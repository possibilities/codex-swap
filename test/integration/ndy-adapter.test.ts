import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoForcedAccountOverride,
  ForcedAccountConflictError,
  NdyAdapter,
  NdyContractError,
} from "../../src/ndy/adapter.ts";
import { resolveNdyInstallation } from "../../src/ndy/bin-resolver.ts";
import { NDY_CONTAINMENT_ENV } from "../../src/ndy/environment.ts";

const FIXTURE_DIR = fileURLToPath(
  new URL("../fixtures/fake-ndy", import.meta.url),
);

interface Recorded {
  bin: string;
  argv: string[];
  env: Record<string, string>;
  stdinIsTTY: boolean;
}

function makeAdapter(extraEnv?: Record<string, string>): {
  adapter: NdyAdapter;
  recordDir: string;
  multiAuthDir: string;
} {
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "fake-ndy-rec-"));
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "fake-ndy-store-"));
  const installation = resolveNdyInstallation({ packageDir: FIXTURE_DIR });
  const adapter = new NdyAdapter(installation, {
    PATH: process.env["PATH"] ?? "",
    FAKE_NDY_RECORD_DIR: recordDir,
    CODEX_MULTI_AUTH_DIR: multiAuthDir,
    ...extraEnv,
  });
  return { adapter, recordDir, multiAuthDir };
}

function readInvocations(recordDir: string): Recorded[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(recordDir, "invocations.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

test("status validates JSON from stdout while stderr noise is isolated", async () => {
  const { adapter } = makeAdapter();
  const status = await adapter.status();
  assert.equal(status.accountCount, 1);
  assert.equal(status.accounts[0]?.index, 0);
  assert.equal(status.accounts[0]?.enabled, true);
});

test("malformed manager JSON raises a contract error", async () => {
  const { adapter } = makeAdapter({ FAKE_NDY_MALFORMED: "1" });
  await assert.rejects(
    adapter.status(),
    (error: unknown) => error instanceof NdyContractError,
  );
});

test("every ndy child receives the containment environment and pinned store dir", async () => {
  const { adapter, recordDir, multiAuthDir } = makeAdapter();
  await adapter.status();
  const [record] = readInvocations(recordDir);
  assert.ok(record);
  for (const [key, value] of Object.entries(NDY_CONTAINMENT_ENV)) {
    assert.equal(record.env[key], value, `env ${key}`);
  }
  assert.equal(record.env["CODEX_MULTI_AUTH_DIR"], multiAuthDir);
  assert.ok(!("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY" in record.env));
  assert.ok(!("CODEX_MULTI_AUTH_BYPASS" in record.env));
  assert.ok(!("CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT" in record.env));
});

test("a hostile CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT in the parent env never reaches the child", async () => {
  const { adapter, recordDir } = makeAdapter({
    CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "1",
  });
  await adapter.status();
  const [record] = readInvocations(recordDir);
  assert.ok(record);
  assert.ok(!("CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT" in record.env));
});

test("a hostile CODEX_CI in the parent env never reaches the child", async () => {
  const { adapter, recordDir } = makeAdapter({
    CODEX_CI: "1",
  });
  await adapter.status();
  const [record] = readInvocations(recordDir);
  assert.ok(record);
  assert.ok(!("CODEX_CI" in record.env));
});

test("a manager env with both CODEX_CI and CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT set never leaks either to the child", async () => {
  const { adapter, recordDir } = makeAdapter({
    CODEX_CI: "1",
    CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "1",
  });
  await adapter.status();
  const [record] = readInvocations(recordDir);
  assert.ok(record);
  assert.ok(!("CODEX_CI" in record.env));
  assert.ok(!("CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT" in record.env));
});

test("login modes map to exact ndy argv", async () => {
  const { adapter, recordDir } = makeAdapter();
  await adapter.login("device");
  await adapter.login("manual");
  await adapter.login("browser", { orgId: "org_42" });
  const argvs = readInvocations(recordDir).map((r) => r.argv);
  assert.deepEqual(argvs, [
    ["login", "--device-auth"],
    ["login", "--manual"],
    ["login", "--org", "org_42"],
  ]);
});

test("history list and show validate against the ndy shapes", async () => {
  const { adapter } = makeAdapter();
  const list = await adapter.historyList();
  assert.equal(list.count, 2);
  assert.equal(list.sessions[0]?.provider, "openai");
  assert.equal(list.sessions[1]?.provider, "codex-multi-auth-runtime-proxy");

  const detail = await adapter.historyShow("5973b6c0-94b8-487b-a530-2aeb6098ae0e");
  assert.equal(detail.id, "5973b6c0-94b8-487b-a530-2aeb6098ae0e");
  assert.equal(detail.cliVersion, "0.147.0");
  assert.equal(detail.messages.length, 2);
});

test("runCodex forwards account selector and args byte-for-byte", async () => {
  const { adapter, recordDir } = makeAdapter();
  const weird = ["resume", "abc-123", "--", "--flag with space", "ünïcode", "-x"];
  const result = await adapter.runCodex({
    accountSelector: "acc_1",
    args: weird,
  });
  assert.equal(result.exitCode, 0);
  const [record] = readInvocations(recordDir);
  assert.deepEqual(record?.argv, ["--account", "acc_1", ...weird]);
  assert.equal(record?.bin, "codex");
});

test("child exit codes propagate; fail-hard is never retried", async () => {
  const { adapter, recordDir } = makeAdapter({ FAKE_NDY_CODEX_EXIT: "7" });
  const result = await adapter.runCodex({ accountSelector: "acc_1", args: [] });
  assert.equal(result.exitCode, 7);

  const failing = makeAdapter({ FAKE_NDY_CODEX_MODE: "fail-account" });
  const failResult = await failing.adapter.runCodex({
    accountSelector: "acc_9",
    args: [],
  });
  assert.equal(failResult.exitCode, 1);
  assert.equal(readInvocations(failing.recordDir).length, 1, "exactly one attempt");
  assert.equal(readInvocations(recordDir).length, 1);
});

test("forwarded --account tokens are rejected before any spawn", async () => {
  const { adapter, recordDir } = makeAdapter();
  for (const args of [["--account", "other"], ["--account=other"], ["exec", "--account=x"]]) {
    await assert.rejects(
      adapter.runCodex({ accountSelector: "acc_1", args }),
      (error: unknown) => error instanceof ForcedAccountConflictError,
    );
  }
  assert.equal(readInvocations(recordDir).length, 0);
  assert.throws(() => assertNoForcedAccountOverride(["--account=x"]));
  assert.doesNotThrow(() => assertNoForcedAccountOverride(["--accountant"]));
});

test("shell metacharacters in args are data, not shell", async () => {
  const { adapter, recordDir } = makeAdapter();
  const hostile = ["$(touch /tmp/pwned)", "; echo hi", "`id`", "&& rm -rf /"];
  await adapter.runCodex({ accountSelector: "acc_1", args: hostile });
  const [record] = readInvocations(recordDir);
  assert.deepEqual(record?.argv.slice(2), hostile);
});

test("promptFamilyForModel resolves through the models matrix", async () => {
  const { adapter, recordDir } = makeAdapter();
  const family = await adapter.promptFamilyForModel("gpt-5.6-sol");
  assert.equal(family, "gpt-5.2");
  const [invocation] = readInvocations(recordDir);
  assert.deepEqual(invocation?.argv, ["models", "--json", "--model", "gpt-5.6-sol"]);

  const { adapter: familyless } = makeAdapter({
    FAKE_NDY_MODELS_JSON: JSON.stringify({ matrix: { entries: [{ model: "mystery" }] } }),
  });
  assert.equal(await familyless.promptFamilyForModel("mystery"), null);

  await assert.rejects(
    adapter.promptFamilyForModel("--flag"),
    NdyContractError,
  );
});

test("forecast passes the model and live flag and validates the envelope", async () => {
  const { adapter, recordDir } = makeAdapter();
  const cached = await adapter.forecast("gpt-5.6-sol");
  assert.equal(cached.liveProbe, false);
  const live = await adapter.forecast("gpt-5.6-sol", { live: true });
  assert.equal(live.liveProbe, true);
  const argvs = readInvocations(recordDir).map((entry) => entry.argv);
  assert.deepEqual(argvs, [
    ["forecast", "--json", "--model", "gpt-5.6-sol"],
    ["forecast", "--json", "--model", "gpt-5.6-sol", "--live"],
  ]);

  const { adapter: malformed } = makeAdapter({ FAKE_NDY_MALFORMED: "1" });
  await assert.rejects(malformed.forecast(null), NdyContractError);
});

test("resetRateLimits converts the 0-based index to the CLI's display index", async () => {
  const { adapter, recordDir } = makeAdapter();
  const result = await adapter.resetRateLimits(0);
  assert.equal(result.ok, true);
  const [invocation] = readInvocations(recordDir);
  assert.deepEqual(invocation?.argv, [
    "rotation",
    "reset-rate-limits",
    "--account",
    "1",
    "--json",
  ]);
  await assert.rejects(adapter.resetRateLimits(-1), NdyContractError);
});
