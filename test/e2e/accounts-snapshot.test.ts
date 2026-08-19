import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Milestone 2 gate: the snapshot is stable across ndy index changes and
 * exposes no credentials; concurrent reconciliations converge.
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

const SECRET_PREFIX = "refresh-token-secret-E2E";
const ACCESS_SECRET = "access-token-secret-E2E";

interface World {
  env: NodeJS.ProcessEnv;
  multiAuthDir: string;
  swapHome: string;
}

function accountRecord(n: number, overrides?: Record<string, unknown>) {
  return {
    recordId: `r${n}`,
    accountId: `acc_${n}`,
    email: `user${n}@x.com`,
    // Distinct per account: ndy's loadAccounts() merges records that share a
    // refresh token during store normalization.
    refreshToken: `${SECRET_PREFIX}-${n}`,
    // Fresh cached access tokens so the credential broker never attempts a
    // live OAuth refresh from tests.
    accessToken: ACCESS_SECRET,
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
    addedAt: 1700000000000 + n,
    lastUsed: 1700000001000 + n,
    ...overrides,
  };
}

function writeStore(world: World, accounts: unknown[]): void {
  writeFileSync(
    path.join(world.multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({ version: 3, accounts, activeIndex: 0 }),
  );
}

function makeWorld(): World {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs2-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs2-home-"));
  const world: World = {
    multiAuthDir,
    swapHome,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? os.homedir(),
      CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      CODEX_SWAP_HOME: swapHome,
      CODEX_HOME: path.join(swapHome, "codex-home"),
      // Dead local endpoint: usage fetches fail fast without real network.
      CODEX_SWAP_UNSAFE_USAGE_BASE_URL: "http://127.0.0.1:1",
    },
  };
  writeStore(world, [accountRecord(1), accountRecord(2)]);
  return world;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

interface AccountsEnvelope {
  data: {
    count: number;
    accounts: Array<{
      accountKey: string;
      ndyIndex: number | null;
      present: boolean;
      email: string | null;
      firstSeenAt: string;
      identityConflict: boolean;
      auth: { status: string };
    }>;
  };
}

test("accounts --json is stable across store reorder and never leaks secrets", async () => {
  const world = makeWorld();

  const first = await runCli(["accounts", "--json"], world.env);
  assert.equal(first.code, 0, first.stderr);
  const initial = (JSON.parse(first.stdout) as AccountsEnvelope).data;
  assert.deepEqual(
    initial.accounts.map((a) => a.accountKey),
    ["record:r1", "record:r2"],
  );

  // Reorder the ndy array; keys must not move, indexes must.
  writeStore(world, [accountRecord(2), accountRecord(1)]);
  const second = await runCli(["accounts", "--json"], world.env);
  const reordered = (JSON.parse(second.stdout) as AccountsEnvelope).data;
  const byKey = new Map(reordered.accounts.map((a) => [a.accountKey, a]));
  assert.equal(byKey.get("record:r1")?.ndyIndex, 1);
  assert.equal(byKey.get("record:r2")?.ndyIndex, 0);

  for (const secret of [SECRET_PREFIX, ACCESS_SECRET]) {
    assert.ok(!first.stdout.includes(secret));
    assert.ok(!second.stdout.includes(secret));
  }

  const dbBytes = readFileSync(
    path.join(world.swapHome, "codex-swap.db"),
  ).toString("latin1");
  for (const secret of [SECRET_PREFIX, ACCESS_SECRET]) {
    assert.ok(!dbBytes.includes(secret), "db must not contain tokens");
  }
});

test("absent accounts keep history; reappearance preserves firstSeenAt", async () => {
  const world = makeWorld();
  const first = await runCli(["accounts", "--json"], world.env);
  const initial = (JSON.parse(first.stdout) as AccountsEnvelope).data;
  const firstSeen = initial.accounts.find((a) => a.accountKey === "record:r2")?.firstSeenAt;
  assert.ok(firstSeen);

  writeStore(world, [accountRecord(1)]);
  const removed = await runCli(["accounts", "--json"], world.env);
  const afterRemoval = (JSON.parse(removed.stdout) as AccountsEnvelope).data;
  const absent = afterRemoval.accounts.find((a) => a.accountKey === "record:r2");
  assert.equal(absent?.present, false);

  writeStore(world, [accountRecord(1), accountRecord(2)]);
  const restored = await runCli(["accounts", "--json"], world.env);
  const afterRestore = (JSON.parse(restored.stdout) as AccountsEnvelope).data;
  const back = afterRestore.accounts.find((a) => a.accountKey === "record:r2");
  assert.equal(back?.present, true);
  assert.equal(back?.firstSeenAt, firstSeen);
});

test("same email across workspaces stays distinct; missing id flags conflict", async () => {
  const world = makeWorld();
  writeStore(world, [
    accountRecord(1, { email: "shared@x.com" }),
    accountRecord(2, { email: "shared@x.com" }),
    accountRecord(3, { email: "shared@x.com", accountId: undefined }),
  ]);
  const result = await runCli(["accounts", "--json"], world.env);
  const data = (JSON.parse(result.stdout) as AccountsEnvelope).data;
  assert.equal(data.accounts.length, 3);
  const conflictFlags = new Map(
    data.accounts.map((a) => [a.accountKey, a.identityConflict]),
  );
  assert.equal(conflictFlags.get("record:r1"), false);
  assert.equal(conflictFlags.get("record:r2"), false);
  assert.equal(conflictFlags.get("record:r3"), true);
});

test("snapshot --json carries the versioned shape with fail-safe eligibility", async () => {
  const world = makeWorld();
  const result = await runCli(["snapshot", "--json"], world.env);
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as {
    schemaVersion: number;
    command: string;
    data: {
      schemaVersion: number;
      dependency: { name: string; version: string; healthy: boolean };
      canonicalCodexHome: string;
      recommendation: null;
      accounts: Array<{
        accountKey: string;
        usage: { status: string; decisionGrade: boolean; measurement: null };
        selection: { eligible: boolean; exclusions: string[] };
      }>;
    };
  };
  assert.equal(envelope.command, "snapshot");
  assert.equal(envelope.data.schemaVersion, 1);
  assert.equal(envelope.data.dependency.version, "2.8.6");
  assert.equal(envelope.data.canonicalCodexHome, world.env["CODEX_HOME"]);
  assert.equal(envelope.data.recommendation, null);
  for (const account of envelope.data.accounts) {
    // The dead endpoint means no decision-grade data: fail safe, never
    // optimistic.
    assert.equal(account.usage.decisionGrade, false);
    assert.equal(account.usage.measurement, null);
    assert.equal(account.selection.eligible, false);
    assert.ok(account.selection.exclusions.includes("usage_unknown"));
  }
});

test("concurrent reconciliations converge without corruption", async () => {
  const world = makeWorld();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => runCli(["accounts", "--json"], world.env)),
  );
  for (const result of results) {
    assert.equal(
      result.code,
      0,
      `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  const final = await runCli(["accounts", "--json"], world.env);
  const data = (JSON.parse(final.stdout) as AccountsEnvelope).data;
  assert.equal(data.count, 2);
  assert.deepEqual(
    data.accounts.map((a) => a.accountKey).sort(),
    ["record:r1", "record:r2"],
  );
});
