import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountCatalog,
  deriveAuthStatus,
  identityConflictKeys,
} from "../../src/accounts/catalog.ts";
import { redactNdyAccount } from "../../src/accounts/redaction.ts";
import { Database } from "../../src/storage/database.ts";
import { lineageHmac, loadOrCreateInstallSecret } from "../../src/storage/install-secret.ts";

const SECRET_TOKEN = "refresh-token-secret-QQQ";

function makeDb(): Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "catalog-"));
  return Database.open(path.join(dir, "test.db"), () => 1_000);
}

function redacted(
  record: Parameters<typeof redactNdyAccount>[0],
  index: number,
  secret: Buffer,
) {
  return redactNdyAccount(record, index, (token) => lineageHmac(secret, token));
}

test("reconcile inserts, reorders keep keys stable, ndy_index tracks display position", () => {
  const db = makeDb();
  const secretDir = mkdtempSync(path.join(os.tmpdir(), "catalog-secret-"));
  const secret = loadOrCreateInstallSecret(secretDir);
  const catalog = new AccountCatalog(db, () => 2_000);

  const a = { recordId: "r1", accountId: "acc_1", email: "a@x.com", refreshToken: "t-a", addedAt: 1, lastUsed: 1 };
  const b = { recordId: "r2", accountId: "acc_2", email: "b@x.com", refreshToken: "t-b", addedAt: 2, lastUsed: 2 };

  const first = catalog.reconcile([redacted(a, 0, secret), redacted(b, 1, secret)]);
  assert.deepEqual(first.addedKeys.sort(), ["record:r1", "record:r2"]);

  // Reorder in ndy's array: keys stay, indexes swap.
  catalog.reconcile([redacted(b, 0, secret), redacted(a, 1, secret)]);
  const rows = catalog.listAll();
  const byKey = new Map(rows.map((r) => [r.accountKey, r]));
  assert.equal(byKey.get("record:r1")?.ndyIndex, 1);
  assert.equal(byKey.get("record:r2")?.ndyIndex, 0);
  assert.equal(rows.length, 2);

  // usage_state rows were auto-created for both.
  const usageRows = db.handle
    .prepare("SELECT account_key FROM usage_state ORDER BY account_key")
    .all() as Array<{ account_key: string }>;
  assert.deepEqual(
    usageRows.map((r) => r.account_key),
    ["record:r1", "record:r2"],
  );
  db.close();
});

test("absent accounts keep history and reappear with first_seen preserved", () => {
  const db = makeDb();
  const secret = loadOrCreateInstallSecret(mkdtempSync(path.join(os.tmpdir(), "cs-")));
  let now = 10_000;
  const catalog = new AccountCatalog(db, () => now);
  const a = { recordId: "r1", accountId: "acc_1", email: "a@x.com", refreshToken: "t-a", addedAt: 1, lastUsed: 1 };

  catalog.reconcile([redacted(a, 0, secret)]);
  now = 20_000;
  const removal = catalog.reconcile([]);
  assert.deepEqual(removal.removedKeys, ["record:r1"]);
  let row = catalog.listAll()[0];
  assert.equal(row?.present, false);
  assert.equal(row?.firstSeenAtMs, 10_000);

  now = 30_000;
  const back = catalog.reconcile([redacted(a, 0, secret)]);
  assert.deepEqual(back.addedKeys, []);
  row = catalog.listAll()[0];
  assert.equal(row?.present, true);
  assert.equal(row?.firstSeenAtMs, 10_000, "first seen survives absence");
  assert.equal(row?.lastSeenAtMs, 30_000);
  db.close();
});

test("credential lineage change releases quarantine and resets failure state", () => {
  const db = makeDb();
  const secret = loadOrCreateInstallSecret(mkdtempSync(path.join(os.tmpdir(), "cs-")));
  const catalog = new AccountCatalog(db, () => 5_000);
  const oldCreds = { recordId: "r1", accountId: "acc_1", email: "a@x.com", refreshToken: "old-token", addedAt: 1, lastUsed: 1 };

  catalog.reconcile([redacted(oldCreds, 0, secret)]);
  db.handle
    .prepare(
      "UPDATE usage_state SET auth_dead_strikes = 3, consecutive_failures = 7, backoff_until_ms = 99999999, next_poll_at_ms = 99999999 WHERE account_key = 'record:r1'",
    )
    .run();

  // Same lineage: quarantine stays.
  catalog.reconcile([redacted(oldCreds, 0, secret)]);
  let usage = db.handle
    .prepare("SELECT auth_dead_strikes AS s FROM usage_state WHERE account_key = 'record:r1'")
    .get() as { s: number };
  assert.equal(usage.s, 3);

  // Rotated refresh token: strikes, failures, backoff, poll plan all clear.
  const result = catalog.reconcile([
    redacted({ ...oldCreds, refreshToken: "new-token" }, 0, secret),
  ]);
  assert.deepEqual(result.lineageChangedKeys, ["record:r1"]);
  const cleared = db.handle
    .prepare(
      "SELECT auth_dead_strikes AS s, consecutive_failures AS f, backoff_until_ms AS b, next_poll_at_ms AS p FROM usage_state WHERE account_key = 'record:r1'",
    )
    .get() as { s: number; f: number; b: number | null; p: number | null };
  assert.deepEqual({ ...cleared }, { s: 0, f: 0, b: null, p: null });

  const events = db.handle
    .prepare("SELECT event_type FROM events WHERE event_type = 'credential_lineage_changed'")
    .all();
  assert.equal(events.length, 1);
  db.close();
});

test("raw tokens never reach the database file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "catalog-leak-"));
  const dbPath = path.join(dir, "leak.db");
  const db = Database.open(dbPath, () => 1_000);
  const secret = loadOrCreateInstallSecret(dir);
  const catalog = new AccountCatalog(db, () => 1_000);

  catalog.reconcile([
    redacted(
      { recordId: "r1", accountId: "acc_1", email: "a@x.com", refreshToken: SECRET_TOKEN, addedAt: 1, lastUsed: 1 },
      0,
      secret,
    ),
  ]);
  db.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const bytes = readFileSync(dbPath).toString("latin1");
  assert.ok(!bytes.includes(SECRET_TOKEN), "db must not contain the refresh token");
  assert.ok(
    bytes.includes(lineageHmac(secret, SECRET_TOKEN)),
    "db carries only the keyed fingerprint",
  );
});

test("identity conflicts require shared email AND missing provider id", () => {
  const accounts = [
    { accountKey: "k1", email: "dup@x.com", providerAccountId: "acc_1" },
    { accountKey: "k2", email: "dup@x.com", providerAccountId: "acc_2" },
    { accountKey: "k3", email: "DUP@x.com", providerAccountId: null },
    { accountKey: "k4", email: "solo@x.com", providerAccountId: null },
  ];
  const conflicts = identityConflictKeys(accounts);
  assert.deepEqual([...conflicts], ["k3"]);
});

test("auth status derivation", () => {
  assert.equal(deriveAuthStatus({ hasCredentials: false }), "no_credentials");
  assert.equal(
    deriveAuthStatus({ hasCredentials: true, authInvalidatedAt: 5 }),
    "relogin_required",
  );
  assert.equal(deriveAuthStatus({ hasCredentials: true }), "ready");
});
