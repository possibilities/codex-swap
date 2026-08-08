import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSettings } from "../../src/config/schema.ts";
import { Database } from "../../src/storage/database.ts";
import { UsageStore, type FetchClaim } from "../../src/usage/store.ts";
import { failureBackoffMs } from "../../src/usage/backoff.ts";
import type { UsageMeasurement } from "../../src/usage/types.ts";

const SETTINGS = defaultSettings().usage;
const FIXED_RNG = () => 0.5; // jitter factor exactly 1.0

function world(startMs = 1_000_000): {
  db: Database;
  store: UsageStore;
  setNow: (ms: number) => void;
  now: () => number;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "usage-store-"));
  let nowMs = startMs;
  const clock = () => nowMs;
  const db = Database.open(path.join(dir, "u.db"), clock);
  db.handle
    .prepare(
      "INSERT INTO accounts (account_key, first_seen_at_ms, last_seen_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
    )
    .run("record:r1", startMs, startMs, startMs);
  db.handle
    .prepare("INSERT INTO usage_state (account_key, updated_at_ms) VALUES (?, ?)")
    .run("record:r1", startMs);
  const store = new UsageStore({ db, settings: SETTINGS, clock, rng: FIXED_RNG });
  return { db, store, setNow: (ms) => (nowMs = ms), now: () => nowMs };
}

function measurement(usedPercent: number): UsageMeasurement {
  return {
    schemaVersion: 1,
    probeKind: "direct-wham",
    windows: [
      {
        kind: "primary",
        label: "5h",
        windowSeconds: 18000,
        usedPercent,
        remainingPercent: 100 - usedPercent,
      },
    ],
    fetchedAt: "2026-08-08T20:00:00.000Z",
  };
}

function claimOf(outcome: ReturnType<UsageStore["reserve"]>): FetchClaim {
  assert.equal(outcome.kind, "claimed");
  return (outcome as { kind: "claimed"; claim: FetchClaim }).claim;
}

test("claim lifecycle: reserve, contention, expiry, regeneration", () => {
  const { store, setNow } = world();

  const claim = claimOf(store.reserve("record:r1"));
  assert.equal(claim.generation, 1);

  const contended = store.reserve("record:r1");
  assert.equal(contended.kind, "claimed_elsewhere");

  // Crash simulation: claim expires without a record; next reserve wins.
  setNow(1_000_000 + SETTINGS.fetchClaimTtlMs + 1);
  const second = claimOf(store.reserve("record:r1"));
  assert.equal(second.generation, 2);

  // The dead collector's late result is fenced out.
  const fenced = store.recordSuccess(claim, measurement(10), {
    nextPollAtMs: 2_000_000,
    pollIntervalMs: 300_000,
  });
  assert.equal(fenced, false);
  const row = store.read("record:r1");
  assert.equal(row?.lastGoodJson, null, "fenced write must not land");
  assert.equal(row?.claimGeneration, 2);
});

test("success stores measurement, clears failures, commits poll plan atomically", () => {
  const { store, setNow } = world();
  const claim = claimOf(store.reserve("record:r1"));
  const ok = store.recordSuccess(claim, measurement(42), {
    nextPollAtMs: 1_300_000,
    pollIntervalMs: 300_000,
  });
  assert.equal(ok, true);
  const row = store.read("record:r1");
  assert.equal(row?.fetchedAtMs, 1_000_000);
  assert.equal(row?.nextPollAtMs, 1_300_000);
  assert.equal(row?.pollIntervalMs, 300_000);
  assert.equal(row?.probeKind, "direct-wham");
  assert.equal(row?.claimId, null);

  // Fresh within serve TTL: not due. Force bypasses only the plan.
  setNow(1_000_000 + 10_000);
  assert.equal(store.reserve("record:r1").kind, "not_due");
  const forced = store.reserve("record:r1", { force: true });
  assert.equal(forced.kind, "claimed");
});

test("failure preserves last-good, increments failures, installs backoff", () => {
  const { store, setNow } = world();
  const first = claimOf(store.reserve("record:r1"));
  store.recordSuccess(first, measurement(42), {
    nextPollAtMs: 1_060_000,
    pollIntervalMs: 60_000,
  });

  setNow(1_400_000); // past serveTtl and plan
  const second = claimOf(store.reserve("record:r1"));
  const applied = store.recordFailure(second, {
    code: "server",
    httpStatus: 503,
    summary: "usage endpoint server error (503)",
    authDead: false,
  });
  assert.equal(applied, true);

  const row = store.read("record:r1");
  assert.ok(row?.lastGoodJson?.includes('"usedPercent":42'), "last-good survives");
  assert.equal(row?.fetchedAtMs, 1_000_000, "fetchedAt untouched by failure");
  assert.equal(row?.consecutiveFailures, 1);
  assert.equal(row?.lastErrorCode, "server");
  assert.equal(row?.backoffUntilMs, 1_400_000 + 30_000, "first ladder step");

  // Backoff blocks even forced reserves.
  setNow(1_405_000);
  assert.equal(store.reserve("record:r1").kind, "backoff");
  assert.equal(store.reserve("record:r1", { force: true }).kind, "backoff");

  setNow(1_430_001);
  assert.equal(store.reserve("record:r1", { force: true }).kind, "claimed");
});

test("429 sets last_429_at and honors Retry-After with the edge floor", () => {
  const { store, setNow } = world();
  const claim = claimOf(store.reserve("record:r1"));
  store.recordFailure(claim, {
    code: "rate_limited",
    httpStatus: 429,
    retryAfterMs: 600_000,
    summary: "rate limited",
    authDead: false,
  });
  let row = store.read("record:r1");
  assert.equal(row?.last429AtMs, 1_000_000);
  assert.equal(row?.backoffUntilMs, 1_600_000, "600s Retry-After honored");

  // Retry-After: 0 gets at least the five-minute edge floor.
  setNow(1_600_001);
  const second = claimOf(store.reserve("record:r1"));
  store.recordFailure(second, {
    code: "rate_limited",
    httpStatus: 429,
    retryAfterMs: 0,
    summary: "rate limited",
    authDead: false,
  });
  row = store.read("record:r1");
  assert.equal(row?.backoffUntilMs, 1_600_001 + 300_000);
});

test("two permanent auth failures quarantine the account", () => {
  const { store, setNow } = world();
  for (const [attempt, at] of [
    [1, 1_000_000],
    [2, 2_000_000],
  ] as const) {
    setNow(at);
    const claim = claimOf(store.reserve("record:r1", { force: true }));
    store.recordFailure(claim, {
      code: "auth",
      summary: "refresh rejected permanently (http_error 400)",
      authDead: true,
    });
    const row = store.read("record:r1");
    assert.equal(row?.authDeadStrikes, attempt);
  }
  setNow(3_000_000);
  assert.equal(store.reserve("record:r1").kind, "quarantined");
  assert.equal(store.reserve("record:r1", { force: true }).kind, "quarantined");
});

test("releaseClaim clears the claim without penalty", () => {
  const { store } = world();
  const claim = claimOf(store.reserve("record:r1"));
  store.releaseClaim(claim);
  const row = store.read("record:r1");
  assert.equal(row?.claimId, null);
  assert.equal(row?.consecutiveFailures, 0);
  assert.equal(store.reserve("record:r1").kind, "claimed");
});

test("failure backoff ladder progresses and caps; Retry-After capped on non-429", () => {
  const ladder = [1, 2, 3, 4, 5, 6, 7].map((failures) =>
    failureBackoffMs({
      consecutiveFailures: failures,
      errorCode: "server",
      settings: SETTINGS,
      rng: FIXED_RNG,
    }),
  );
  assert.deepEqual(
    ladder,
    [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000],
  );

  const pathological = failureBackoffMs({
    consecutiveFailures: 1,
    errorCode: "server",
    retryAfterMs: 999_999_999,
    settings: SETTINGS,
    rng: FIXED_RNG,
  });
  assert.equal(pathological, SETTINGS.normalTrustMaxAgeMs);

  const rateLimited = failureBackoffMs({
    consecutiveFailures: 1,
    errorCode: "rate_limited",
    retryAfterMs: 999_999_999,
    settings: SETTINGS,
    rng: FIXED_RNG,
  });
  assert.equal(rateLimited, SETTINGS.retryAfterCapMs);
});
