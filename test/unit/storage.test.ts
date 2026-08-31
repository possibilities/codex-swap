import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { Database } from "../../src/storage/database.ts";
import { dataRoot, databasePath } from "../../src/storage/paths.ts";
import { SymlinkRefusedError } from "../../src/storage/permissions.ts";
import { appliedSchemaVersion, MIGRATIONS } from "../../src/storage/migrations.ts";

const POSIX = process.platform !== "win32";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-swap-db-"));
}

test("CODEX_SWAP_HOME overrides the platform data root", () => {
  const resolved = dataRoot({ CODEX_SWAP_HOME: "/tmp/custom-root" });
  assert.equal(resolved, path.resolve("/tmp/custom-root"));
  const platformDefault = dataRoot({});
  assert.ok(platformDefault.endsWith("codex-swap"));
});

test("open applies migrations, WAL mode, and private permissions", () => {
  const root = tempRoot();
  const dbPath = databasePath(path.join(root, "data"));
  const db = Database.open(dbPath, () => 1_000);

  const journalMode = db.handle
    .prepare("PRAGMA journal_mode")
    .get() as Record<string, string>;
  assert.equal(Object.values(journalMode)[0], "wal");

  assert.equal(
    appliedSchemaVersion(db.handle),
    MIGRATIONS[MIGRATIONS.length - 1]?.version,
  );

  const tables = db.handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const expected of [
    "accounts",
    "account_policy",
    "usage_state",
    "selection_state",
    "invocation_leases",
    "events",
    "schema_migrations",
  ]) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  for (const retired of ["app_servers", "ndy_capability"]) {
    assert.ok(!names.includes(retired), `retired table ${retired} should not exist`);
  }

  if (POSIX) {
    assert.equal(statSync(path.dirname(dbPath)).mode & 0o777, 0o700);
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  }
  db.close();

  const reopened = Database.open(dbPath, () => 2_000);
  assert.equal(
    appliedSchemaVersion(reopened.handle),
    MIGRATIONS[MIGRATIONS.length - 1]?.version,
  );
  reopened.close();
});

test("open refuses a symlinked database path", () => {
  if (!POSIX) return;
  const root = tempRoot();
  const realFile = path.join(root, "real.db");
  writeFileSync(realFile, "");
  const link = path.join(root, "linked.db");
  symlinkSync(realFile, link);
  assert.throws(() => Database.open(link), SymlinkRefusedError);
});

test("immediate transaction commits and rolls back", () => {
  const root = tempRoot();
  const db = Database.open(path.join(root, "tx.db"), () => 1_000);

  db.immediate(() => {
    db.handle
      .prepare(
        "INSERT INTO accounts (account_key, first_seen_at_ms, last_seen_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run("record:a", 1, 1, 1);
  });
  assert.throws(() =>
    db.immediate(() => {
      db.handle
        .prepare(
          "INSERT INTO accounts (account_key, first_seen_at_ms, last_seen_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run("record:b", 2, 2, 2);
      throw new Error("boom");
    }),
  );

  const rows = db.handle
    .prepare("SELECT account_key FROM accounts ORDER BY account_key")
    .all() as Array<{ account_key: string }>;
  assert.deepEqual(
    rows.map((r) => r.account_key),
    ["record:a"],
  );

  const foreignKeys = db.handle
    .prepare("PRAGMA foreign_keys")
    .get() as Record<string, number>;
  assert.equal(Object.values(foreignKeys)[0], 1);
  db.close();
});

test("migration 5 remains an applied no-op", (context) => {
  const root = tempRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "from-v4.db");
  const old = new DatabaseSync(dbPath);
  old.exec("PRAGMA foreign_keys = ON");
  appliedSchemaVersion(old);
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 4)) {
    old.exec("BEGIN IMMEDIATE");
    old.exec(migration.sql);
    old.prepare(
      "INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)",
    ).run(migration.version, 1_000 + migration.version);
    old.exec("COMMIT");
  }
  old.prepare(
    `INSERT INTO accounts (
       account_key, first_seen_at_ms, last_seen_at_ms, updated_at_ms
     ) VALUES ('record:a', 1, 1, 1)`,
  ).run();
  const insertLease = old.prepare(
    `INSERT INTO invocation_leases (
       lease_id, account_key, owner_pid, owner_nonce, purpose, cwd,
       acquired_at_ms, heartbeat_at_ms, expires_at_ms, released_at_ms,
       status, selector_reason_json, child_exit_code
     ) VALUES (?, 'record:a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertLease.run(
    "codex-lease",
    11,
    "codex-nonce",
    "codex-session",
    "/codex",
    10,
    11,
    12,
    13,
    "released",
    '{"summary":"preserve exactly"}',
    0,
  );
  const insertEvent = old.prepare(
    `INSERT INTO events (occurred_at_ms, event_type, account_key, payload_json)
     VALUES (?, ?, 'record:a', ?)`,
  );
  insertEvent.run(
    30,
    "invocation_lease_acquired",
    '{"leaseId":"codex-lease","purpose":"codex-session","keep":"exact"}',
  );
  const codexLeaseBefore = old
    .prepare("SELECT * FROM invocation_leases WHERE lease_id = 'codex-lease'")
    .get();
  const codexEventBefore = old
    .prepare("SELECT * FROM events WHERE json_extract(payload_json, '$.leaseId') = 'codex-lease'")
    .get();
  old.close();

  const upgraded = Database.open(dbPath, () => 9_000);
  assert.equal(appliedSchemaVersion(upgraded.handle), 5);
  assert.deepEqual(
    upgraded.handle
      .prepare("SELECT * FROM invocation_leases WHERE lease_id = 'codex-lease'")
      .get(),
    codexLeaseBefore,
  );
  assert.deepEqual(
    upgraded.handle
      .prepare("SELECT * FROM events WHERE json_extract(payload_json, '$.leaseId') = 'codex-lease'")
      .get(),
    codexEventBefore,
  );
  upgraded.close();
});
