import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSettings } from "../../src/config/schema.ts";
import { InvocationLeaseStore } from "../../src/selection/leases.ts";
import { Database } from "../../src/storage/database.ts";

const SETTINGS = defaultSettings().leases;

function world(): {
  db: Database;
  leases: InvocationLeaseStore;
  setNow: (ms: number) => void;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "leases-"));
  let nowMs = 1_000_000;
  const clock = () => nowMs;
  const db = Database.open(path.join(dir, "l.db"), clock);
  for (const key of ["record:a", "record:b"]) {
    db.handle
      .prepare(
        "INSERT INTO accounts (account_key, first_seen_at_ms, last_seen_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(key, nowMs, nowMs, nowMs);
  }
  return {
    db,
    leases: new InvocationLeaseStore(db, SETTINGS, clock),
    setNow: (ms) => (nowMs = ms),
  };
}

test("reserve → running → heartbeat → release lifecycle", () => {
  const { db, leases, setNow } = world();
  const lease = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: "codex-session" }),
  );
  assert.equal(lease.status, "reserved");
  assert.equal(lease.expiresAtMs, 1_000_000 + SETTINGS.reservationTtlMs);

  assert.equal(leases.markRunning(lease.leaseId, lease.ownerNonce), true);
  let row = leases.get(lease.leaseId);
  assert.equal(row?.status, "running");
  assert.equal(row?.expiresAtMs, 1_000_000 + SETTINGS.runningExpiryMs);

  setNow(1_050_000);
  assert.equal(leases.heartbeat(lease.leaseId, lease.ownerNonce), true);
  row = leases.get(lease.leaseId);
  assert.equal(row?.expiresAtMs, 1_050_000 + SETTINGS.runningExpiryMs);

  assert.equal(
    leases.release(lease.leaseId, lease.ownerNonce, {
      status: "released",
      childExitCode: 0,
    }),
    true,
  );
  row = leases.get(lease.leaseId);
  assert.equal(row?.status, "released");
  assert.equal(row?.childExitCode, 0);

  // Double release and post-release heartbeats are no-ops.
  assert.equal(leases.heartbeat(lease.leaseId, lease.ownerNonce), false);
  assert.equal(
    leases.release(lease.leaseId, lease.ownerNonce, { status: "released" }),
    false,
  );
  db.close();
});

test("wrong nonce cannot mutate a lease", () => {
  const { db, leases } = world();
  const lease = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: "codex-session" }),
  );
  assert.equal(leases.markRunning(lease.leaseId, "wrong-nonce"), false);
  assert.equal(leases.get(lease.leaseId)?.status, "reserved");
  db.close();
});

test("stale reserved and crashed running leases expire by wall clock", () => {
  const { db, leases, setNow } = world();
  const reserved = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: "codex-session" }),
  );
  const running = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:b", purpose: "codex-session" }),
  );
  leases.markRunning(running.leaseId, running.ownerNonce);

  // Neither is stale yet.
  db.immediate(() => assert.equal(leases.expireStaleLocked(), 0));

  // Reservation TTL passes: the unlaunched claim expires; the running one
  // (with its longer expiry) survives.
  setNow(1_000_000 + SETTINGS.reservationTtlMs + 1);
  db.immediate(() => assert.equal(leases.expireStaleLocked(), 1));
  assert.equal(leases.get(reserved.leaseId)?.status, "expired");
  assert.equal(leases.get(running.leaseId)?.status, "running");

  // The crashed owner never heartbeats: the running lease expires too.
  setNow(1_000_000 + SETTINGS.runningExpiryMs + 1);
  db.immediate(() => assert.equal(leases.expireStaleLocked(), 1));
  assert.equal(leases.get(running.leaseId)?.status, "expired");

  // An expired lease cannot be started.
  assert.equal(leases.markRunning(reserved.leaseId, reserved.ownerNonce), false);
  db.close();
});

test("active counts see reserved and running, not finished or expired", () => {
  const { db, leases, setNow } = world();
  const a1 = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: "codex-session" }),
  );
  db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: "harness-claim" }),
  );
  const b1 = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:b", purpose: "codex-session" }),
  );
  leases.markRunning(b1.leaseId, b1.ownerNonce);

  let counts = db.immediate(() => leases.activeCountsLocked());
  assert.equal(counts.get("record:a"), 2);
  assert.equal(counts.get("record:b"), 1);

  leases.release(a1.leaseId, a1.ownerNonce, { status: "released", childExitCode: 0 });
  counts = db.immediate(() => leases.activeCountsLocked());
  assert.equal(counts.get("record:a"), 1);

  setNow(1_000_000 + SETTINGS.runningExpiryMs + 1);
  counts = db.immediate(() => leases.activeCountsLocked());
  assert.equal(counts.get("record:a"), undefined);
  assert.equal(counts.get("record:b"), undefined);
  db.close();
});

test("pruneFinished keeps the audit window", () => {
  const { db, leases, setNow } = world();
  const lease = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: "codex-session" }),
  );
  leases.release(lease.leaseId, lease.ownerNonce, { status: "released", childExitCode: 0 });

  assert.equal(leases.pruneFinished(3_600_000), 0, "inside the window");
  setNow(1_000_000 + 3_600_001);
  assert.equal(leases.pruneFinished(3_600_000), 1);
  assert.equal(leases.get(lease.leaseId), null);
  db.close();
});
