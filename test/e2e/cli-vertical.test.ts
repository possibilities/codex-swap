import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Milestone 1 gate: with a fake dependency, one can onboard, list history,
 * and launch pinned Codex through the real CLI without any project-internal
 * token handling. Uses CODEX_SWAP_NDY_PACKAGE_DIR (fake bins) plus
 * CODEX_MULTI_AUTH_DIR (temp store read by the real storage subpath).
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

const SECRET_A = "refresh-token-secret-AAA";
const SECRET_B = "refresh-token-secret-BBB";

function makeWorld(): { env: NodeJS.ProcessEnv; multiAuthDir: string; recordDir: string } {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs-e2e-store-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "cs-e2e-rec-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs-e2e-home-"));
  writeFileSync(
    path.join(multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({
      version: 3,
      accounts: [
        {
          recordId: "r1",
          accountId: "acc_1",
          email: "a@x.com",
          refreshToken: SECRET_A,
          accessToken: "access-token-secret-AAA",
          enabled: true,
          addedAt: 1700000000000,
          lastUsed: 1700000001000,
        },
        {
          recordId: "r2",
          accountId: "acc_2",
          email: "dup@x.com",
          refreshToken: SECRET_B,
          enabled: true,
          addedAt: 1700000002000,
          lastUsed: 1700000003000,
        },
        {
          recordId: "r3",
          accountId: "acc_3",
          email: "dup@x.com",
          refreshToken: "refresh-token-secret-CCC",
          enabled: true,
          addedAt: 1700000004000,
          lastUsed: 1700000005000,
        },
      ],
      activeIndex: 0,
    }),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? os.homedir(),
    CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
    CODEX_MULTI_AUTH_DIR: multiAuthDir,
    FAKE_NDY_RECORD_DIR: recordDir,
    // Sandbox ALL codex-swap state: without this, lease-backed commands
    // write into the real platform data root.
    CODEX_SWAP_HOME: swapHome,
    CODEX_HOME: path.join(swapHome, "codex-home"),
    CODEX_SWAP_UNSAFE_USAGE_BASE_URL: "http://127.0.0.1:1",
  };
  return { env, multiAuthDir, recordDir };
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

function invocations(recordDir: string): Array<{ bin: string; argv: string[] }> {
  try {
    return readFileSync(path.join(recordDir, "invocations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { bin: string; argv: string[] });
  } catch {
    return [];
  }
}

test("auth add --device-auth reports the added account, redacted, via store diff", async () => {
  const world = makeWorld();
  world.env["FAKE_NDY_LOGIN_ADD_ACCOUNT"] = JSON.stringify({
    recordId: "r-new",
    accountId: "acc_new",
    email: "new@x.com",
    refreshToken: "refresh-token-secret-NEW",
    enabled: true,
    addedAt: 1700000009000,
    lastUsed: 1700000009000,
  });
  const result = await runCli(["auth", "add", "--device-auth", "--json"], world.env);
  assert.equal(result.code, 0, result.stderr);

  const envelope = JSON.parse(result.stdout) as {
    schemaVersion: number;
    command: string;
    data: {
      mode: string;
      accountCount: number;
      added: Array<{ accountKey: string; email?: string }>;
      changed: unknown[];
    };
    error: null;
  };
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.command, "auth add");
  assert.equal(envelope.data.mode, "device");
  assert.equal(envelope.data.accountCount, 4);
  assert.deepEqual(
    envelope.data.added.map((a) => a.accountKey),
    ["record:r-new"],
  );

  for (const secret of [SECRET_A, SECRET_B, "refresh-token-secret-NEW", "access-token-secret-AAA"]) {
    assert.ok(!result.stdout.includes(secret), "stdout must not leak tokens");
    assert.ok(!result.stderr.includes(secret), "stderr must not leak tokens");
  }
});

test("auth add with cancelled login (exit 0, no diff) reports empty change set", async () => {
  const world = makeWorld();
  const result = await runCli(["auth", "add", "--device-auth", "--json"], world.env);
  assert.equal(result.code, 0);
  const envelope = JSON.parse(result.stdout) as {
    data: { added: unknown[]; changed: unknown[] };
  };
  assert.deepEqual(envelope.data.added, []);
  assert.deepEqual(envelope.data.changed, []);
});

test("failed login exits 1 with an error envelope", async () => {
  const world = makeWorld();
  world.env["FAKE_NDY_LOGIN_EXIT"] = "1";
  const result = await runCli(["auth", "add", "--device-auth", "--json"], world.env);
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.stdout) as { error: { code: string } };
  assert.equal(envelope.error.code, "AUTH_LOGIN_FAILED");
});

test("run pins by provider account id resolved from account key selector", async () => {
  const world = makeWorld();
  const result = await runCli(
    ["run", "--account", "record:r1", "--", "exec", "hello world"],
    world.env,
  );
  assert.equal(result.code, 0, result.stderr);
  const wrapperCalls = invocations(world.recordDir).filter((r) => r.bin === "codex");
  assert.equal(wrapperCalls.length, 1);
  assert.deepEqual(wrapperCalls[0]?.argv, [
    "--account",
    "acc_1",
    "exec",
    "hello world",
  ]);
});

test("run formalizes a caller-owned foreground App Server invocation", async () => {
  const world = makeWorld();
  const result = await runCli(
    [
      "run",
      "--account",
      "record:r1",
      "--",
      "-c",
      'plugins."agent@agentstart-managed".enabled=false',
      "-c",
      'skills.config=[{path="/capabilities/build/SKILL.md",enabled=true}]',
      "app-server",
      "--listen",
      "unix:///tmp/caller-owned.sock",
    ],
    world.env,
  );
  assert.equal(result.code, 0, result.stderr);
  const wrapperCalls = invocations(world.recordDir).filter((r) => r.bin === "codex");
  assert.deepEqual(wrapperCalls[0]?.argv, [
    "--account",
    "acc_1",
    "-c",
    'plugins."agent@agentstart-managed".enabled=false',
    "-c",
    'skills.config=[{path="/capabilities/build/SKILL.md",enabled=true}]',
    "app-server",
    "--listen",
    "unix:///tmp/caller-owned.sock",
  ]);
});

test("run no longer accepts codex-swap-owned server sidecar flags", async () => {
  const world = makeWorld();
  const result = await runCli(
    ["run", "--account", "record:r1", "--server", "auto", "--"],
    world.env,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option '--server'/);
  assert.equal(invocations(world.recordDir).length, 0);
});

test("forwarded --remote remains a caller-owned Codex arg", async () => {
  const world = makeWorld();
  const result = await runCli(
    ["run", "--account", "record:r1", "--", "--remote", "unix:///tmp/caller.sock"],
    world.env,
  );
  assert.equal(result.code, 0, result.stderr);
  const wrapperCalls = invocations(world.recordDir).filter((r) => r.bin === "codex");
  assert.deepEqual(wrapperCalls[0]?.argv, [
    "--account",
    "acc_1",
    "--remote",
    "unix:///tmp/caller.sock",
  ]);
});

test("run resolves unique email and propagates child exit code", async () => {
  const world = makeWorld();
  world.env["FAKE_NDY_CODEX_EXIT"] = "9";
  const result = await runCli(["run", "--account", "a@x.com", "--"], world.env);
  assert.equal(result.code, 9);
});

test("ambiguous email selector fails hard with exit 4 and no launch", async () => {
  const world = makeWorld();
  const result = await runCli(["run", "--account", "dup@x.com", "--"], world.env);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /matches multiple accounts/);
  assert.equal(invocations(world.recordDir).length, 0);
});

test("unknown selector exits 4; forwarded --account is rejected with exit 2", async () => {
  const world = makeWorld();
  const missing = await runCli(["run", "--account", "ghost@x.com", "--"], world.env);
  assert.equal(missing.code, 4);

  const conflict = await runCli(
    ["run", "--account", "record:r1", "--", "--account=acc_2"],
    world.env,
  );
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /must not contain --account/);
  assert.equal(invocations(world.recordDir).length, 0);
});

test("history list --json emits an envelope with both providers", async () => {
  const world = makeWorld();
  const result = await runCli(["history", "--json"], world.env);
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as {
    command: string;
    data: { count: number; sessions: Array<{ provider: string | null }> };
  };
  assert.equal(envelope.command, "history list");
  assert.equal(envelope.data.count, 2);
  assert.deepEqual(
    envelope.data.sessions.map((s) => s.provider),
    ["openai", "codex-multi-auth-runtime-proxy"],
  );
});

test("history show forwards the exact session id", async () => {
  const world = makeWorld();
  const result = await runCli(
    ["history", "show", "11111111-2222-4333-8444-555555555555", "--json"],
    world.env,
  );
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as { data: { id: string } };
  assert.equal(envelope.data.id, "11111111-2222-4333-8444-555555555555");
});

test(
  "SIGTERM to codex-swap run is forwarded to the wrapper child",
  {
    skip:
      process.platform === "win32"
        ? "Windows has no POSIX SIGTERM forwarding"
        : false,
  },
  async () => {
    const world = makeWorld();
    world.env["FAKE_NDY_CODEX_MODE"] = "hang";
    const child = spawn(
      process.execPath,
      [MAIN, "run", "--account", "record:r1", "--"],
      { env: world.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exit = new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
    });
    // Wait until the wrapper actually started before signaling.
    for (let i = 0; i < 100; i++) {
      if (invocations(world.recordDir).length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(invocations(world.recordDir).length > 0, "wrapper never started");
    child.kill("SIGTERM");
    const code = await exit;
    assert.equal(code, 143, "child's SIGTERM exit must propagate");
  },
);

test("unsupported ndy version fails closed with exit 5", async () => {
  const world = makeWorld();
  const badDir = mkdtempSync(path.join(os.tmpdir(), "cs-badndy-"));
  writeFileSync(
    path.join(badDir, "package.json"),
    JSON.stringify({
      name: "codex-multi-auth",
      version: "3.0.0",
      bin: {
        "codex-multi-auth": "scripts/codex-multi-auth.js",
        "codex-multi-auth-codex": "scripts/codex.js",
      },
    }),
  );
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(badDir, "scripts"), { recursive: true });
  writeFileSync(path.join(badDir, "scripts", "codex-multi-auth.js"), "#!/usr/bin/env node\n");
  writeFileSync(path.join(badDir, "scripts", "codex.js"), "#!/usr/bin/env node\n");
  world.env["CODEX_SWAP_NDY_PACKAGE_DIR"] = badDir;

  const result = await runCli(["history", "--json"], world.env);
  assert.equal(result.code, 5);
  const envelope = JSON.parse(result.stdout) as { error: { code: string } };
  assert.equal(envelope.error.code, "DEPENDENCY_UNSUPPORTED");
});
