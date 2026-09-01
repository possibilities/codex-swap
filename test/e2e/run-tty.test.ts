import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression: AgentLaunch drives `codex-swap run --claim` inside a real
 * terminal (a PTY), and the official Codex CLI it ultimately launches
 * requires stdin/stdout/stderr to stay real TTYs — it refuses with
 * "stdout is not a terminal" otherwise. codex-swap's own spawn always uses
 * `stdio: "inherit"`, but the ndy wrapper decides for itself whether to
 * pipe the real Codex CLI's stdio, and an inherited
 * CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT=1 forces it to pipe even under a
 * real terminal (see src/ndy/environment.ts). This proves the full
 * `run --claim` path keeps the ndy child attached to a real PTY and that a
 * hostile CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT never reaches it. It also
 * proves a hostile inherited CODEX_CI=1 (e.g. from a CI-flavored manager or
 * orchestrator environment this process itself runs under) never reaches
 * the ndy child either: the pinned wrapper's own
 * shouldCaptureForwardedCodexOutput() (scripts/codex.js) treats CODEX_CI=1
 * as an independent force-true path ahead of its isTTY auto-detect, so a
 * stale CODEX_CI would force piped stdio just as surely as a stale
 * CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT would.
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

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
    },
  });
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(usageBody(20));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function makeWorld(serverUrl: string): { env: NodeJS.ProcessEnv; recordDir: string } {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs-tty-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs-tty-home-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "cs-tty-rec-"));
  writeFileSync(
    path.join(multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({
      version: 3,
      accounts: [
        {
          recordId: "r1",
          accountId: "acc_1",
          email: "user1@x.com",
          refreshToken: "refresh-token-secret-TTY-1",
          accessToken: "access-token-TTY-1",
          expiresAt: Date.now() + 3_600_000,
          enabled: true,
          addedAt: 1700000000000,
          lastUsed: 1700000001000,
        },
      ],
      activeIndex: 0,
    }),
  );
  return {
    recordDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? os.homedir(),
      CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      CODEX_SWAP_HOME: swapHome,
      CODEX_HOME: path.join(swapHome, "codex-home"),
      CODEX_SWAP_UNSAFE_USAGE_BASE_URL: serverUrl,
      FAKE_NDY_RECORD_DIR: recordDir,
      // Hostile inheritance: a parent process (or a prior non-interactive
      // codex-swap invocation sharing the same shell env) leaves this set.
      // It must never reach the ndy child under an interactive launch.
      CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "1",
      // Hostile inheritance: a CI-flavored manager/orchestrator environment
      // (this test process itself may run under one) leaves this set. The
      // pinned ndy wrapper treats it as an independent force-true path for
      // piping the real Codex CLI's stdio, so it must never reach the child
      // either, even under a real interactive PTY launch.
      CODEX_CI: "1",
    },
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

/** Runs a command attached to a freshly allocated pseudo-terminal. */
function runUnderPty(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number | null } {
  const result =
    process.platform === "darwin"
      ? spawnSync("script", ["-q", "/dev/null", command, ...args], {
          env,
          stdio: ["ignore", "ignore", "ignore"],
        })
      : spawnSync(
          "script",
          ["-qc", [command, ...args].map(shQuote).join(" "), "/dev/null"],
          { env, stdio: ["ignore", "ignore", "ignore"] },
        );
  return { code: result.status };
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface ClaimEnvelope {
  data: { lease: { leaseId: string } } | null;
}

interface Recorded {
  bin: string;
  argv: string[];
  env: Record<string, string>;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}

function wrapperInvocations(recordDir: string): Recorded[] {
  return readFileSync(path.join(recordDir, "invocations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Recorded)
    .filter((r) => r.bin === "codex");
}

test(
  "run --claim keeps the ndy child on a real PTY and strips a hostile capture-output override",
  {
    skip:
      process.platform === "win32"
        ? "no `script` PTY helper on Windows CI"
        : false,
  },
  async () => {
    const server = await startServer();
    try {
      const world = makeWorld(server.url);
      await runCli(["usage", "refresh", "--json"], world.env);

      const claim = await runCli(["select", "--claim", "--json"], world.env);
      assert.equal(claim.code, 0, claim.stderr);
      const leaseId = (JSON.parse(claim.stdout) as ClaimEnvelope).data?.lease.leaseId;
      assert.ok(leaseId, "expected a reserved lease id");

      const { code } = runUnderPty(
        process.execPath,
        [MAIN, "run", "--claim", leaseId!, "--", "exec", "hi"],
        world.env,
      );
      assert.equal(code, 0, "run --claim should exit 0 under a real PTY");

      const [invocation] = wrapperInvocations(world.recordDir);
      assert.ok(invocation, "expected one ndy wrapper invocation");
      assert.equal(invocation.stdinIsTTY, true, "stdin must stay a real TTY");
      assert.equal(invocation.stdoutIsTTY, true, "stdout must stay a real TTY");
      assert.equal(invocation.stderrIsTTY, true, "stderr must stay a real TTY");
      assert.ok(
        !("CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT" in invocation.env),
        "a hostile capture-output override must never reach the ndy child",
      );
      assert.ok(
        !("CODEX_CI" in invocation.env),
        "a hostile inherited CODEX_CI must never reach the ndy child",
      );
    } finally {
      await server.close();
    }
  },
);
