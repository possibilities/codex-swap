import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Milestone 6 gate: direct resume forwards the exact session UUID and the
 * selected account's pin, preserves the canonical CODEX_HOME, and rejects
 * non-UUID contracts. Cross-account: the session "created under" acc_1 is
 * resumed pinned to acc_2.
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

const SESSION_ID = "5973b6c0-94b8-487b-a530-2aeb6098ae0e";

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const account = req.headers["chatgpt-account-id"];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: account === "acc_1" ? 95 : 20,
            limit_window_seconds: 18000,
            reset_after_seconds: 3600,
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function makeWorld(serverUrl: string): { env: NodeJS.ProcessEnv; recordDir: string; codexHome: string } {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs6-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs6-home-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "cs6-rec-"));
  const codexHome = path.join(swapHome, "codex-home");
  const accounts = [1, 2].map((n) => ({
    recordId: `r${n}`,
    accountId: `acc_${n}`,
    email: `user${n}@x.com`,
    refreshToken: `refresh-token-secret-R-${n}`,
    accessToken: `access-token-R-${n}`,
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
    recordDir,
    codexHome,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? os.homedir(),
      CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      CODEX_SWAP_HOME: swapHome,
      CODEX_HOME: codexHome,
      CODEX_SWAP_UNSAFE_USAGE_BASE_URL: serverUrl,
      FAKE_NDY_RECORD_DIR: recordDir,
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

function wrapperInvocations(
  recordDir: string,
): Array<{ bin: string; argv: string[]; env: Record<string, string> }> {
  try {
    return readFileSync(path.join(recordDir, "invocations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { bin: string; argv: string[]; env: Record<string, string> },
      )
      .filter((r) => r.bin === "codex");
  } catch {
    return [];
  }
}

test("resume pins an explicit account and forwards the exact UUID plus extra args", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    const result = await runCli(
      ["resume", SESSION_ID, "--account", "record:r2", "--", "--model", "o4"],
      world.env,
    );
    assert.equal(result.code, 0, result.stderr);
    const [call] = wrapperInvocations(world.recordDir);
    assert.deepEqual(call?.argv, [
      "--account",
      "acc_2",
      "resume",
      SESSION_ID,
      "--model",
      "o4",
    ]);
    assert.equal(
      call?.env["CODEX_HOME"],
      world.codexHome,
      "canonical CODEX_HOME preserved — no per-account homes",
    );
  } finally {
    await server.close();
  }
});

test("cross-account contract: strategy resume lands on the other account", async () => {
  const server = await startServer();
  try {
    // acc_1 is nearly exhausted (95% used); best selection resumes the
    // "acc_1-era" session pinned to acc_2.
    const world = makeWorld(server.url);
    await runCli(["usage", "refresh", "--json"], world.env);
    const result = await runCli(
      ["resume", SESSION_ID, "--strategy", "best", "--"],
      world.env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /using record:r2/);
    const [call] = wrapperInvocations(world.recordDir);
    assert.deepEqual(call?.argv, ["--account", "acc_2", "resume", SESSION_ID]);
  } finally {
    await server.close();
  }
});

test("non-UUID session ids are rejected — the direct-UUID contract is explicit", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    const result = await runCli(
      ["resume", "my-session-name", "--account", "record:r1", "--"],
      world.env,
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not a session UUID/);
    assert.equal(wrapperInvocations(world.recordDir).length, 0);
  } finally {
    await server.close();
  }
});

test("resume propagates the child exit code and forwards no --account into codex args", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    world.env["FAKE_NDY_CODEX_EXIT"] = "17";
    const result = await runCli(
      ["resume", SESSION_ID, "--account", "user1@x.com", "--"],
      world.env,
    );
    assert.equal(result.code, 17);

    const conflict = await runCli(
      ["resume", SESSION_ID, "--account", "record:r1", "--", "--account=evil"],
      world.env,
    );
    assert.equal(conflict.code, 2);
    assert.match(conflict.stderr, /must not contain --account/);
  } finally {
    await server.close();
  }
});
