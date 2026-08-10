import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
