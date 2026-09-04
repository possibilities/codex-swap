import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Milestone 3 gate: eight concurrent snapshot processes cause no more than
 * one usage request per due account, repeated snapshots inside the TTL cause
 * zero, and a failure retains labeled last-good usage.
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

interface UsageServer {
  url: string;
  countsByAccount: Map<string, number>;
  totalRequests: () => number;
  setMode: (mode: "ok" | "server-error") => void;
  close: () => Promise<void>;
}

function usageBody(usedPercent: number): string {
  return JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
      },
      secondary_window: {
        used_percent: Math.max(0, usedPercent - 10),
        limit_window_seconds: 604800,
        reset_after_seconds: 86400,
        reset_at: Math.floor(Date.now() / 1000) + 86400,
      },
    },
    rate_limit_reset_credits: { available_count: 1 },
  });
}

async function startServer(): Promise<UsageServer> {
  const countsByAccount = new Map<string, number>();
  let mode: "ok" | "server-error" = "ok";
  const server = http.createServer((req, res) => {
    const account = req.headers["chatgpt-account-id"];
    const key = typeof account === "string" ? account : "none";
    if (req.url?.includes("/api/codex/rate-limit-reset-credits") === true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        available_count: 1,
        credits: [{ expires_at: "2026-09-08T12:00:00Z" }],
      }));
      return;
    }
    countsByAccount.set(key, (countsByAccount.get(key) ?? 0) + 1);
    if (mode === "server-error") {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("unavailable");
      return;
    }
    if (req.url?.includes("/backend-api/wham/usage") === true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(usageBody(key === "acc_1" ? 40 : 70));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    countsByAccount,
    totalRequests: () =>
      [...countsByAccount.values()].reduce((sum, n) => sum + n, 0),
    setMode: (m) => (mode = m),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function makeWorld(serverUrl: string): NodeJS.ProcessEnv {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs3-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs3-home-"));
  const accounts = [1, 2].map((n) => ({
    recordId: `r${n}`,
    accountId: `acc_${n}`,
    email: `user${n}@x.com`,
    refreshToken: `refresh-token-secret-C-${n}`,
    // Fresh cached access tokens: the broker must not need a live OAuth
    // refresh during this test.
    accessToken: `access-token-C-${n}`,
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
    addedAt: 1700000000000 + n,
    lastUsed: 1700000001000 + n,
  }));
  writeFileSync(
    path.join(multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({ version: 3, accounts, activeIndex: 0 }),
  );
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? os.homedir(),
    CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
    CODEX_MULTI_AUTH_DIR: multiAuthDir,
    CODEX_SWAP_HOME: swapHome,
    CODEX_HOME: path.join(swapHome, "codex-home"),
    CODEX_SWAP_UNSAFE_USAGE_BASE_URL: serverUrl,
  };
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

interface SnapshotEnvelope {
  data: {
    accounts: Array<{
      accountKey: string;
      usage: {
        status: string;
        decisionGrade: boolean;
        measurement: {
          resetCreditsAvailable?: number;
          resetCreditExpirations?: Array<string | null>;
          windows: Array<{ usedPercent: number }>;
        } | null;
        lastError: { code: string } | null;
      };
      lastGoodUsage: { measurement: unknown } | null;
      selection: { eligible: boolean; exclusions: string[] };
    }>;
  };
}

test("eight concurrent snapshots produce at most one request per account, then TTL suppresses", async () => {
  const server = await startServer();
  try {
    const env = makeWorld(server.url);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => runCli(["snapshot", "--json"], env)),
    );
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }

    assert.ok(
      (server.countsByAccount.get("acc_1") ?? 0) <= 1,
      `acc_1 fetched ${server.countsByAccount.get("acc_1")} times`,
    );
    assert.ok(
      (server.countsByAccount.get("acc_2") ?? 0) <= 1,
      `acc_2 fetched ${server.countsByAccount.get("acc_2")} times`,
    );
    assert.ok(server.totalRequests() <= 2, "storm stayed within the pool size");

    // One follow-up pass may bootstrap-fill the second account (one due
    // alternate per pass); per-account budget still holds.
    await runCli(["snapshot", "--json"], env);
    assert.ok((server.countsByAccount.get("acc_1") ?? 0) <= 1);
    assert.ok((server.countsByAccount.get("acc_2") ?? 0) <= 1);
    const afterFill = server.totalRequests();
    assert.equal(afterFill, 2, "both accounts measured exactly once in total");

    // Inside the serve TTL a further snapshot performs zero requests and
    // serves decision-grade data.
    const followUp = await runCli(["snapshot", "--json"], env);
    assert.equal(server.totalRequests(), afterFill, "TTL suppressed refetch");
    const envelope = JSON.parse(followUp.stdout) as SnapshotEnvelope;
    const acc1 = envelope.data.accounts.find((a) => a.accountKey === "record:r1");
    assert.equal(acc1?.usage.decisionGrade, true);
    assert.equal(acc1?.usage.measurement?.windows[0]?.usedPercent, 40);
    assert.equal(acc1?.usage.measurement?.resetCreditsAvailable, 1);
    assert.deepEqual(
      acc1?.usage.measurement?.resetCreditExpirations,
      ["2026-09-08T12:00:00.000Z"],
    );
    assert.equal(acc1?.selection.eligible, true);
    assert.deepEqual(acc1?.selection.exclusions, []);

    // Exhausted secondary math sanity: acc_2 at 70% is still eligible.
    const acc2 = envelope.data.accounts.find((a) => a.accountKey === "record:r2");
    assert.equal(acc2?.selection.eligible, true);
  } finally {
    await server.close();
  }
});

test("a failed refresh retains and labels last-good usage", async () => {
  const server = await startServer();
  try {
    const env = makeWorld(server.url);

    // Operator refresh seeds the whole pool (a plain scheduler pass would
    // honor the active-plus-one-alternate traffic invariant instead).
    const seed = await runCli(["usage", "refresh", "--json"], env);
    assert.equal(seed.code, 0, seed.stderr);
    assert.equal(server.totalRequests(), 2);

    server.setMode("server-error");
    const refreshed = await runCli(["usage", "refresh", "--json"], env);
    assert.equal(refreshed.code, 0, refreshed.stderr);

    const envelope = JSON.parse(refreshed.stdout) as {
      data: {
        accounts: Array<{
          accountKey: string;
          usage: {
            decisionGrade: boolean;
            lastError: { code: string; httpStatus: number | null } | null;
          };
          lastGoodUsage: {
            measurement: {
              resetCreditsAvailable?: number;
              resetCreditExpirations?: Array<string | null>;
              windows: Array<{ usedPercent: number }>;
            };
          } | null;
        }>;
      };
    };
    const acc1 = envelope.data.accounts.find((a) => a.accountKey === "record:r1");
    assert.ok(acc1);
    assert.equal(acc1.usage.lastError?.code, "server");
    assert.equal(acc1.usage.lastError?.httpStatus, 503);
    assert.equal(
      acc1.lastGoodUsage?.measurement.windows[0]?.usedPercent,
      40,
      "last-good measurement survives the failure",
    );
    assert.equal(
      acc1.lastGoodUsage?.measurement.resetCreditsAvailable,
      1,
      "reset credits persist in last-good and survive the failure",
    );
    assert.deepEqual(
      acc1.lastGoodUsage?.measurement.resetCreditExpirations,
      ["2026-09-08T12:00:00.000Z"],
      "reset-credit expiries persist in last-good and survive the failure",
    );
    // Fresh last-good (seconds old) stays decision-grade despite the error.
    assert.equal(acc1.usage.decisionGrade, true);
  } finally {
    await server.close();
  }
});
