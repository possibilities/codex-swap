import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings } from "../../src/config/schema.ts";
import { resolveNdyInstallation } from "../../src/ndy/bin-resolver.ts";
import { NdyStoreReader } from "../../src/ndy/store-reader.ts";
import { Database } from "../../src/storage/database.ts";
import { databasePath } from "../../src/storage/paths.ts";
import { SnapshotService } from "../../src/snapshot/service.ts";

/**
 * `no_credentials` is one of the non-capacity exclusions the metered-lane
 * claim must preserve, but the real codex-multi-auth storage module drops
 * any account record lacking a refresh token before codex-swap ever sees it
 * (node_modules/codex-multi-auth/dist/lib/storage.js filters on
 * `refreshToken.trim()`), so it cannot be produced through the account
 * store in an end-to-end test. This exercises the service method directly
 * against a synthetic catalog row instead.
 */
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

function openService(): { service: SnapshotService; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cs-lane-svc-"));
  const db = Database.open(databasePath(root));
  const installation = resolveNdyInstallation({ packageDir: FIXTURE_DIR });
  const service = new SnapshotService({
    db,
    reader: new NdyStoreReader({ CODEX_MULTI_AUTH_DIR: root }),
    installation,
    secret: Buffer.alloc(32, 7),
    settings: defaultSettings(),
  });
  return { service, root };
}

function seedAccount(
  service: SnapshotService,
  options: {
    accountKey: string;
    authStatus: string;
    email?: string | null;
    providerAccountId?: string | null;
    nowMs: number;
  },
): void {
  service.database.handle
    .prepare(
      `INSERT INTO accounts (
         account_key, record_id, provider_account_id, email, label, added_at_ms,
         ndy_index, enabled, present, auth_status, auth_invalidated_at_ms,
         credential_lineage_hmac, first_seen_at_ms, last_seen_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, NULL, ?, 0, 1, 1, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      options.accountKey,
      options.accountKey,
      options.providerAccountId ?? null,
      options.email ?? null,
      options.nowMs,
      options.authStatus,
      options.nowMs,
      options.nowMs,
      options.nowMs,
    );
  service.database.handle
    .prepare(
      `INSERT INTO usage_state (
         account_key, last_good_json, fetched_at_ms, consecutive_failures,
         auth_dead_strikes, claim_generation, updated_at_ms
       ) VALUES (?, ?, ?, 0, 0, 0, ?)`,
    )
    .run(
      options.accountKey,
      JSON.stringify({
        schemaVersion: 1,
        probeKind: "direct-wham",
        windows: [
          { kind: "primary", label: "5h", usedPercent: 10, remainingPercent: 90 },
          {
            kind: "other",
            label: "5h",
            usedPercent: 20,
            remainingPercent: 80,
            limitName: "codex-spark",
          },
        ],
        fetchedAt: new Date(options.nowMs).toISOString(),
      }),
      options.nowMs,
      options.nowMs,
    );
}

test("no_credentials survives the metered-lane waiver even with valid Spark headroom", () => {
  const { service } = openService();
  try {
    const nowMs = Date.now();
    seedAccount(service, { accountKey: "record:no-creds", authStatus: "no_credentials", nowMs });

    const { result, lease } = service.selectAndClaimMeteredLane({
      accountKey: "record:no-creds",
      lane: "codex-spark",
      purpose: "codex-spark-claim",
    });

    assert.equal(result.kind, "none");
    assert.equal(lease, null);
    if (result.kind === "none") {
      assert.equal(result.reason, "eligibility_excluded");
      const mine = result.exclusions.find((e) => e.accountKey === "record:no-creds");
      assert.ok(mine?.exclusions.includes("no_credentials"), JSON.stringify(mine));
    }
  } finally {
    service.close();
  }
});

test("identity_conflict survives the metered-lane waiver even with valid Spark headroom", () => {
  const { service } = openService();
  try {
    const nowMs = Date.now();
    // The real ndy storage module merges same-email records lacking an
    // accountId before codex-swap ever sees them, so this state — reachable
    // only by codex-swap's own catalog reconciliation across separate
    // onboarding events — is seeded directly rather than through the store.
    seedAccount(service, {
      accountKey: "record:conflict-a",
      authStatus: "ready",
      email: "shared@x.com",
      nowMs,
    });
    seedAccount(service, {
      accountKey: "record:conflict-b",
      authStatus: "ready",
      email: "shared@x.com",
      nowMs,
    });

    const { result, lease } = service.selectAndClaimMeteredLane({
      accountKey: "record:conflict-a",
      lane: "codex-spark",
      purpose: "codex-spark-claim",
    });

    assert.equal(result.kind, "none");
    assert.equal(lease, null);
    if (result.kind === "none") {
      assert.equal(result.reason, "eligibility_excluded");
      const mine = result.exclusions.find((e) => e.accountKey === "record:conflict-a");
      assert.ok(mine?.exclusions.includes("identity_conflict"), JSON.stringify(mine));
    }
  } finally {
    service.close();
  }
});
