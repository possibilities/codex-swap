import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NdyAdapter } from "../../src/ndy/adapter.ts";
import { resolveNdyInstallation } from "../../src/ndy/bin-resolver.ts";
import { NdyStoreReader } from "../../src/ndy/store-reader.ts";
import {
  computeFamilyBlocks,
  verifyAndHealFamilyBlocks,
} from "../../src/selection/family-blocks.ts";

const FIXTURE_DIR = fileURLToPath(
  new URL("../fixtures/fake-ndy", import.meta.url),
);

const FAMILY = "gpt-5.2";

/**
 * End-to-end advisory-record healing over the real reader and the fake ndy
 * CLI: a persisted record the live probe disproves is cleared through
 * `rotation reset-rate-limits`, and the stamp gate bounds repeat probes.
 */
function makeWorld(untilMs: number): {
  adapter: NdyAdapter;
  reader: NdyStoreReader;
  storePath: string;
  stampPath: string;
} {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "fake-ndy-heal-"));
  const storePath = path.join(multiAuthDir, "openai-codex-accounts.json");
  writeFileSync(
    storePath,
    JSON.stringify(
      {
        version: 3,
        accounts: [
          {
            recordId: "record-heal-a",
            accountId: "org-heal-a",
            accountLabel: "Heal A",
            email: "heal-a@example.com",
            refreshToken: "fake-refresh-token",
            addedAt: 1786000000000,
            lastUsed: 1786000000000,
            rateLimitResetTimes: { [FAMILY]: untilMs },
            workspaces: [],
          },
        ],
        activeIndex: 0,
      },
      null,
      2,
    ),
  );
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "fake-ndy-heal-rec-"));
  const env = {
    PATH: process.env["PATH"] ?? "",
    FAKE_NDY_RECORD_DIR: recordDir,
    CODEX_MULTI_AUTH_DIR: multiAuthDir,
    FAKE_NDY_FORECAST_LIVE_JSON: JSON.stringify({
      liveProbe: true,
      accounts: [
        {
          index: 0,
          availability: "ready",
          waitMs: 0,
          reasons: [],
          liveQuota: { status: 200 },
        },
      ],
    }),
  };
  const installation = resolveNdyInstallation({ packageDir: FIXTURE_DIR });
  return {
    adapter: new NdyAdapter(installation, env),
    reader: new NdyStoreReader(env),
    storePath,
    stampPath: path.join(
      mkdtempSync(path.join(os.tmpdir(), "codex-swap-stamp-")),
      "family-verify-stamp.json",
    ),
  };
}

test("a live-disproved family record is cleared and the block set recomputed", async () => {
  const nowMs = Date.now();
  const untilMs = nowMs + 3 * 24 * 3_600_000;
  const world = makeWorld(untilMs);

  const accounts = await world.reader.loadRedactedAccounts();
  const blocks = computeFamilyBlocks(accounts, FAMILY, nowMs);
  const [blockedKey] = [...blocks.keys()];
  assert.notEqual(blockedKey, undefined);

  const outcome = await verifyAndHealFamilyBlocks({
    adapter: world.adapter,
    reader: world.reader,
    context: { model: "gpt-5.6-sol", family: FAMILY, blocks },
    healableKeys: [blockedKey!],
    stampPath: world.stampPath,
    minIntervalMs: 300_000,
    nowMs,
  });
  assert.equal(outcome.kind, "healed");
  if (outcome.kind === "healed") {
    assert.deepEqual(outcome.clearedAccountKeys, [blockedKey]);
    assert.equal(outcome.blocks.size, 0);
  }
  const store = JSON.parse(readFileSync(world.storePath, "utf8")) as {
    accounts: Array<{ rateLimitResetTimes?: unknown }>;
  };
  assert.equal(store.accounts[0]?.rateLimitResetTimes, undefined);

  // The stamp gate consumes the interval: an immediate second verification
  // is skipped even though a healable key is offered.
  const again = await verifyAndHealFamilyBlocks({
    adapter: world.adapter,
    reader: world.reader,
    context: { model: "gpt-5.6-sol", family: FAMILY, blocks },
    healableKeys: [blockedKey!],
    stampPath: world.stampPath,
    minIntervalMs: 300_000,
    nowMs: nowMs + 1_000,
  });
  assert.deepEqual(again, { kind: "skipped", reason: "interval" });
});

test("a 429 live verdict confirms the record and clears nothing", async () => {
  const nowMs = Date.now();
  const untilMs = nowMs + 3 * 24 * 3_600_000;
  const world = makeWorld(untilMs);
  const accounts = await world.reader.loadRedactedAccounts();
  const blocks = computeFamilyBlocks(accounts, FAMILY, nowMs);
  const [blockedKey] = [...blocks.keys()];

  // Same world, but the live probe now reports the limit as real.
  const worldEnvAdapter = new NdyAdapter(
    resolveNdyInstallation({ packageDir: FIXTURE_DIR }),
    {
      PATH: process.env["PATH"] ?? "",
      CODEX_MULTI_AUTH_DIR: path.dirname(world.storePath),
      FAKE_NDY_FORECAST_LIVE_JSON: JSON.stringify({
        liveProbe: true,
        accounts: [
          {
            index: 0,
            availability: "delayed",
            waitMs: untilMs - nowMs,
            reasons: ["live probe returned 429"],
            liveQuota: { status: 429 },
          },
        ],
      }),
    },
  );

  const outcome = await verifyAndHealFamilyBlocks({
    adapter: worldEnvAdapter,
    reader: world.reader,
    context: { model: "gpt-5.6-sol", family: FAMILY, blocks },
    healableKeys: [blockedKey!],
    stampPath: world.stampPath,
    minIntervalMs: 300_000,
    nowMs,
  });
  assert.equal(outcome.kind, "healed");
  if (outcome.kind === "healed") {
    assert.deepEqual(outcome.clearedAccountKeys, []);
    assert.equal(outcome.blocks.size, 1);
  }
  const store = JSON.parse(readFileSync(world.storePath, "utf8")) as {
    accounts: Array<{ rateLimitResetTimes?: Record<string, number> }>;
  };
  assert.deepEqual(store.accounts[0]?.rateLimitResetTimes, { [FAMILY]: untilMs });
});
