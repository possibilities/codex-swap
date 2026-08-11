import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

function makeWorld(): { env: NodeJS.ProcessEnv; swapHome: string } {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs7-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs7-home-"));
  writeFileSync(
    path.join(multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({
      version: 3,
      accounts: [
        {
          recordId: "r1",
          accountId: "acc_1",
          email: "user1@x.com",
          refreshToken: "refresh-token-secret-D-1",
          accessToken: "access-token-D-1",
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
    swapHome,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? os.homedir(),
      CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      CODEX_SWAP_HOME: swapHome,
      CODEX_HOME: path.join(swapHome, "codex-home"),
      CODEX_SWAP_UNSAFE_USAGE_BASE_URL: "http://127.0.0.1:1",
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

test("doctor --json reports healthy checks without secrets", async () => {
  const world = makeWorld();
  const result = await runCli(["doctor", "--json"], world.env);
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as {
    data: { healthy: boolean; checks: Array<{ name: string; status: string; detail: string }> };
  };
  assert.equal(envelope.data.healthy, true);
  const names = envelope.data.checks.map((c) => c.name);
  for (const expected of [
    "platform",
    "codex-swap",
    "codex-multi-auth",
    "codex-home",
    "containment-env",
    "database",
    "accounts",
    "identities",
    "fetch-claims",
    "quarantine",
    "invocation-leases",
    "dependency-contract",
  ]) {
    assert.ok(names.includes(expected), `missing check ${expected}`);
  }
  const ndy = envelope.data.checks.find((c) => c.name === "codex-multi-auth");
  assert.equal(ndy?.status, "ok");
  assert.match(ndy?.detail ?? "", /2\.8\.4/);
  assert.ok(!result.stdout.includes("refresh-token-secret"), "no secrets in doctor output");
});

test("doctor --fix prunes and stays healthy; unsupported ndy fails the report", async () => {
  const world = makeWorld();
  const fixed = await runCli(["doctor", "--fix", "--json"], world.env);
  assert.equal(fixed.code, 0, fixed.stderr);
  const envelope = JSON.parse(fixed.stdout) as {
    data: { checks: Array<{ name: string; detail: string }> };
  };
  assert.ok(envelope.data.checks.some((c) => c.name === "fix"));
});

test("config set/unset round-trips, validates, and preserves unknown fields", async () => {
  const world = makeWorld();
  // Seed a settings file containing an unknown field a future version wrote.
  writeFileSync(
    path.join(world.swapHome, "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      futureUnknownSection: { keep: "me" },
      selection: { strategy: "best" },
    }),
  );

  const set = await runCli(
    ["config", "set", "selection.defaultMaxConcurrent", "2"],
    world.env,
  );
  assert.equal(set.code, 0, set.stderr);

  const raw = JSON.parse(
    readFileSync(path.join(world.swapHome, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(raw["futureUnknownSection"], { keep: "me" }, "unknown fields survive");
  assert.equal(
    (raw["selection"] as Record<string, unknown>)["defaultMaxConcurrent"],
    2,
  );

  const show = await runCli(["config", "show", "--json"], world.env);
  const shown = JSON.parse(show.stdout) as {
    data: { settings: { selection: { defaultMaxConcurrent: number | null } } };
  };
  assert.equal(shown.data.settings.selection.defaultMaxConcurrent, 2);

  // Invalid values are rejected before anything is written.
  const bad = await runCli(
    ["config", "set", "usage.jitterFraction", "0.9"],
    world.env,
  );
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /fail validation/);
  const rawAfterBad = JSON.parse(
    readFileSync(path.join(world.swapHome, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(
    (rawAfterBad["usage"] as Record<string, unknown> | undefined)?.["jitterFraction"],
    undefined,
    "rejected write never lands",
  );

  const unset = await runCli(
    ["config", "unset", "selection.defaultMaxConcurrent"],
    world.env,
  );
  assert.equal(unset.code, 0, unset.stderr);
  const rawAfterUnset = JSON.parse(
    readFileSync(path.join(world.swapHome, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(
    (rawAfterUnset["selection"] as Record<string, unknown>)["defaultMaxConcurrent"],
    undefined,
  );
  assert.deepEqual(rawAfterUnset["futureUnknownSection"], { keep: "me" });

  const unsetMissing = await runCli(
    ["config", "unset", "selection.defaultMaxConcurrent"],
    world.env,
  );
  assert.equal(unsetMissing.code, 2);
});

test("commands append sanitized structured logs", async () => {
  const world = makeWorld();
  await runCli(["accounts", "--json"], world.env);
  const log = readFileSync(
    path.join(world.swapHome, "logs", "codex-swap.jsonl"),
    "utf8",
  );
  const record = JSON.parse(log.trim().split("\n")[0] ?? "{}") as {
    event: string;
    command: string;
    exitCode: number;
  };
  assert.equal(record.event, "command_completed");
  assert.equal(record.command, "accounts");
  assert.equal(record.exitCode, 0);
  assert.ok(!log.includes("refresh-token-secret"));
  assert.ok(!log.includes("user1@x.com"), "emails are redacted in logs");
});
