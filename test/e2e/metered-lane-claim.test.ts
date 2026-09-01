import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databasePath, dataRoot } from "../../src/storage/paths.ts";

/**
 * The metered-lane claim (`select --account <key> --claim --metered-lane
 * codex-spark --model <spark-model>`): a narrow standalone claim primitive
 * that proves independent Spark-lane headroom and waives only general
 * quota exhaustion, never any other eligibility guard.
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));
const SPARK_MODEL = "gpt-5.3-codex-spark";
const NOW_S = Math.floor(Date.now() / 1000);

interface LaneWindow {
  usedPercent: number;
  limitName?: string;
  meteredFeature?: string;
}

interface AccountUsagePlan {
  mainUsedPercent: number;
  limitReached?: boolean;
  lane?: LaneWindow[];
  /** A general reset already in the past: forces the measurement stale. */
  generalResetInPast?: boolean;
}

function windowBody(usedPercent: number, resetInPast?: boolean) {
  return {
    used_percent: usedPercent,
    limit_window_seconds: 18000,
    reset_after_seconds: resetInPast === true ? -3600 : 3600,
    reset_at: resetInPast === true ? NOW_S - 3600 : NOW_S + 3600,
  };
}

function usageBody(plan: AccountUsagePlan): string {
  return JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: plan.limitReached ?? false,
      primary_window: windowBody(plan.mainUsedPercent, plan.generalResetInPast),
    },
    additional_rate_limits: (plan.lane ?? []).map((w) => ({
      limit_name: w.limitName,
      metered_feature: w.meteredFeature,
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: windowBody(w.usedPercent),
      },
    })),
  });
}

async function startServer(
  plans: Map<string, AccountUsagePlan>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const account = req.headers["chatgpt-account-id"] as string | undefined;
    const plan = (account !== undefined ? plans.get(account) : undefined) ?? {
      mainUsedPercent: 10,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(usageBody(plan));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface AccountFixture {
  recordId: string;
  accountId?: string;
  email?: string;
  refreshToken?: string;
  enabled?: boolean;
  authInvalidatedAt?: number;
  rateLimitResetTimes?: Record<string, number>;
}

interface World {
  env: NodeJS.ProcessEnv;
  multiAuthDir: string;
  swapHome: string;
}

function writeAccounts(multiAuthDir: string, fixtures: AccountFixture[]): void {
  const accounts = fixtures.map((f, i) => ({
    recordId: f.recordId,
    ...(f.accountId !== undefined ? { accountId: f.accountId } : {}),
    ...(f.email !== undefined ? { email: f.email } : {}),
    ...(f.refreshToken !== undefined ? { refreshToken: f.refreshToken } : {}),
    accessToken: `access-${f.recordId}`,
    expiresAt: Date.now() + 3_600_000,
    enabled: f.enabled ?? true,
    addedAt: 1700000000000 + i,
    lastUsed: 1700000001000 + i,
    ...(f.authInvalidatedAt !== undefined
      ? { authInvalidatedAt: f.authInvalidatedAt }
      : {}),
    ...(f.rateLimitResetTimes !== undefined
      ? { rateLimitResetTimes: f.rateLimitResetTimes }
      : {}),
  }));
  writeFileSync(
    path.join(multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({ version: 3, accounts, activeIndex: 0 }),
  );
}

function makeWorld(serverUrl: string, fixtures: AccountFixture[]): World {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs-lane-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs-lane-home-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "cs-lane-rec-"));
  writeAccounts(multiAuthDir, fixtures);
  writeFileSync(
    path.join(swapHome, "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      selection: { defaultMaxConcurrent: 1, familyFilter: true },
      leases: {
        reservationTtlMs: 30_000,
        heartbeatIntervalMs: 1_000,
        runningExpiryMs: 5_000,
      },
    }),
  );
  return {
    multiAuthDir,
    swapHome,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? os.homedir(),
      CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      CODEX_SWAP_HOME: swapHome,
      CODEX_HOME: path.join(swapHome, "codex-home"),
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

interface ClaimEnvelope {
  data: {
    selection: {
      kind: string;
      accountKey?: string;
      lane?: string;
      headroomPercent?: number;
    };
    lease: { leaseId: string; ownerNonce: string; accountKey: string; status: string } | null;
  } | null;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
}

function claim(
  env: NodeJS.ProcessEnv,
  accountKey: string,
  model: string = SPARK_MODEL,
): Promise<{ code: number; envelope: ClaimEnvelope }> {
  return runCli(
    ["select", "--account", accountKey, "--claim", "--metered-lane", "codex-spark", "--model", model, "--json"],
    env,
  ).then((r) => ({ code: r.code, envelope: JSON.parse(r.stdout) as ClaimEnvelope }));
}

function withPolicy(
  world: World,
  accountKey: string,
  fields: { manuallyDisabled?: boolean; cooldownUntilMs?: number },
): void {
  const dbPath = databasePath(dataRoot(world.env));
  const db = new DatabaseSync(dbPath);
  try {
    db
      .prepare(
        `INSERT INTO account_policy (account_key, manually_disabled, cooldown_until_ms, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_key) DO UPDATE SET
           manually_disabled = excluded.manually_disabled,
           cooldown_until_ms = excluded.cooldown_until_ms,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        accountKey,
        fields.manuallyDisabled === true ? 1 : 0,
        fields.cooldownUntilMs ?? null,
        Date.now(),
      );
  } finally {
    db.close();
  }
}

function selectionState(world: World): { sequence: number; lastSelected: string | null } {
  const dbPath = databasePath(dataRoot(world.env));
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT sequence, last_selected_account_key AS lastSelected FROM selection_state WHERE id = 1",
      )
      .get() as { sequence: number; lastSelected: string | null } | undefined;
    return row ?? { sequence: 0, lastSelected: null };
  } finally {
    db.close();
  }
}

const BASE_FIXTURES: AccountFixture[] = [
  { recordId: "spark_ok", accountId: "acc_spark_ok", email: "spark-ok@x.com", refreshToken: "rt-spark-ok" },
  {
    recordId: "spark_exhausted",
    accountId: "acc_spark_exhausted",
    email: "spark-exhausted@x.com",
    refreshToken: "rt-spark-exhausted",
  },
  {
    recordId: "spark_missing",
    accountId: "acc_spark_missing",
    email: "spark-missing@x.com",
    refreshToken: "rt-spark-missing",
  },
  {
    recordId: "spark_limitname",
    accountId: "acc_spark_limitname",
    email: "spark-limitname@x.com",
    refreshToken: "rt-spark-limitname",
  },
  {
    recordId: "spark_metered_fallback",
    accountId: "acc_spark_metered_fallback",
    email: "spark-fallback@x.com",
    refreshToken: "rt-spark-fallback",
  },
  {
    recordId: "spark_limitname_mismatch",
    accountId: "acc_spark_limitname_mismatch",
    email: "spark-mismatch@x.com",
    refreshToken: "rt-spark-mismatch",
  },
  {
    recordId: "spark_disabled",
    accountId: "acc_spark_disabled",
    email: "spark-disabled@x.com",
    refreshToken: "rt-spark-disabled",
    enabled: false,
  },
  {
    recordId: "spark_relogin",
    accountId: "acc_spark_relogin",
    email: "spark-relogin@x.com",
    refreshToken: "rt-spark-relogin",
    authInvalidatedAt: Date.now() - 1000,
  },
  {
    recordId: "spark_manual",
    accountId: "acc_spark_manual",
    email: "spark-manual@x.com",
    refreshToken: "rt-spark-manual",
  },
  {
    recordId: "spark_cooldown",
    accountId: "acc_spark_cooldown",
    email: "spark-cooldown@x.com",
    refreshToken: "rt-spark-cooldown",
  },
  {
    recordId: "spark_family",
    accountId: "acc_spark_family",
    email: "spark-family@x.com",
    refreshToken: "rt-spark-family",
    rateLimitResetTimes: { "gpt-5.2": Date.now() + 3_600_000 },
  },
  {
    recordId: "spark_concurrency",
    accountId: "acc_spark_concurrency",
    email: "spark-concurrency@x.com",
    refreshToken: "rt-spark-concurrency",
  },
  {
    recordId: "spark_stale",
    accountId: "acc_spark_stale",
    email: "spark-stale@x.com",
    refreshToken: "rt-spark-stale",
  },
];

function basePlans(): Map<string, AccountUsagePlan> {
  const plans = new Map<string, AccountUsagePlan>();
  plans.set("acc_spark_ok", {
    mainUsedPercent: 100,
    limitReached: true,
    lane: [{ usedPercent: 30, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_exhausted", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 100, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_missing", { mainUsedPercent: 10, lane: [] });
  plans.set("acc_spark_limitname", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 20, limitName: "codex-spark", meteredFeature: "not-spark" }],
  });
  plans.set("acc_spark_metered_fallback", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 25, meteredFeature: "CODEX-SPARK" }],
  });
  plans.set("acc_spark_limitname_mismatch", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 15, limitName: "not-spark", meteredFeature: "codex-spark" }],
  });
  plans.set("acc_spark_disabled", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 20, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_relogin", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 20, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_manual", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 20, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_cooldown", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 20, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_family", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 20, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_concurrency", {
    mainUsedPercent: 10,
    lane: [{ usedPercent: 20, limitName: "codex-spark" }],
  });
  plans.set("acc_spark_stale", {
    mainUsedPercent: 10,
    generalResetInPast: true,
    lane: [{ usedPercent: 20, limitName: "codex-spark" }],
  });
  return plans;
}

test("exhausted main quota still claims via positive Spark headroom", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);

    const before = selectionState(world);
    const { code, envelope } = await claim(world.env, "record:spark_ok");
    assert.equal(code, 0, JSON.stringify(envelope));
    assert.equal(envelope.data?.selection.kind, "selected");
    assert.equal(envelope.data?.selection.accountKey, "record:spark_ok");
    assert.equal(envelope.data?.selection.lane, "codex-spark");
    assert.equal(envelope.data?.selection.headroomPercent, 70);
    assert.equal(envelope.data?.lease?.accountKey, "record:spark_ok");
    assert.equal(envelope.data?.lease?.status, "reserved");

    // Never updates main-lane selection_state.
    const after = selectionState(world);
    assert.deepEqual(after, before);
  } finally {
    await server.close();
  }
});

test("Spark lane itself exhausted refuses even with main headroom", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_exhausted");
    assert.equal(code, 3, JSON.stringify(envelope));
    assert.equal(envelope.error?.code, "NO_ELIGIBLE_ACCOUNT");
    assert.equal(envelope.error?.details?.["reason"], "spark_lane_exhausted");
  } finally {
    await server.close();
  }
});

test("missing Spark lane data refuses as unavailable, not zero-headroom", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_missing");
    assert.equal(code, 3);
    assert.equal(envelope.error?.details?.["reason"], "spark_lane_unavailable");
  } finally {
    await server.close();
  }
});

test("stale Spark data (measurement not decision-grade) refuses via usage_unknown", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_stale");
    assert.equal(code, 3);
    assert.equal(envelope.error?.details?.["reason"], "eligibility_excluded");
    const exclusions = envelope.error?.details?.["exclusions"] as Array<{
      accountKey: string;
      exclusions: string[];
    }>;
    const mine = exclusions.find((e) => e.accountKey === "record:spark_stale");
    assert.ok(mine?.exclusions.includes("usage_unknown"), JSON.stringify(mine));
  } finally {
    await server.close();
  }
});

test("limitName identifies the lane and wins over a mismatched meteredFeature", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_limitname");
    assert.equal(code, 0, JSON.stringify(envelope));
    assert.equal(envelope.data?.selection.headroomPercent, 80);
  } finally {
    await server.close();
  }
});

test("meteredFeature falls back only when limitName is absent", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_metered_fallback");
    assert.equal(code, 0, JSON.stringify(envelope));
    assert.equal(envelope.data?.selection.headroomPercent, 75);
  } finally {
    await server.close();
  }
});

test("a limitName mismatch is not rescued by a matching meteredFeature", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_limitname_mismatch");
    assert.equal(code, 3);
    assert.equal(envelope.error?.details?.["reason"], "spark_lane_unavailable");
  } finally {
    await server.close();
  }
});

// no_credentials and identity_conflict are covered in
// test/integration/metered-lane-service.test.ts instead: the real
// codex-multi-auth storage module drops zero-refresh-token records and
// merges same-email records lacking an accountId before codex-swap ever
// sees the store, so neither exclusion is producible through this harness.
test("every non-capacity eligibility exclusion survives the waiver", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    withPolicy(world, "record:spark_manual", { manuallyDisabled: true });
    withPolicy(world, "record:spark_cooldown", { cooldownUntilMs: Date.now() + 3_600_000 });

    const cases: Array<{ accountKey: string; expect: string }> = [
      { accountKey: "record:spark_disabled", expect: "ndy_disabled" },
      { accountKey: "record:spark_relogin", expect: "relogin_required" },
      { accountKey: "record:spark_manual", expect: "manually_disabled" },
      { accountKey: "record:spark_cooldown", expect: "cooldown_active" },
    ];
    for (const { accountKey, expect } of cases) {
      const { code, envelope } = await claim(world.env, accountKey);
      assert.equal(code, 3, `${accountKey}: ${JSON.stringify(envelope)}`);
      assert.equal(envelope.error?.details?.["reason"], "eligibility_excluded", accountKey);
      const exclusions = envelope.error?.details?.["exclusions"] as Array<{
        accountKey: string;
        exclusions: string[];
      }>;
      const mine = exclusions.find((e) => e.accountKey === accountKey);
      assert.ok(
        mine?.exclusions.includes(expect),
        `${accountKey}: expected ${expect}, got ${JSON.stringify(mine)}`,
      );
    }
  } finally {
    await server.close();
  }
});

test("an unknown account key refuses instead of guessing", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:does_not_exist");
    assert.equal(code, 3);
    assert.equal(envelope.error?.details?.["reason"], "account_not_found");
  } finally {
    await server.close();
  }
});

test("an account made absent after onboarding still refuses", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    writeAccounts(
      world.multiAuthDir,
      BASE_FIXTURES.filter((f) => f.recordId !== "spark_ok"),
    );
    const { code, envelope } = await claim(world.env, "record:spark_ok");
    assert.equal(code, 3);
    assert.equal(envelope.error?.details?.["reason"], "eligibility_excluded");
    const exclusions = envelope.error?.details?.["exclusions"] as Array<{
      accountKey: string;
      exclusions: string[];
    }>;
    const mine = exclusions.find((e) => e.accountKey === "record:spark_ok");
    assert.ok(mine?.exclusions.includes("absent"));
  } finally {
    await server.close();
  }
});

test("a family rate-limit record on the target account still refuses", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    world.env["FAKE_NDY_MODELS_JSON"] = JSON.stringify({
      command: "models",
      matrix: { entries: [{ accountIndex: 1, accountLabel: "x", model: SPARK_MODEL, normalizedModel: SPARK_MODEL, promptFamily: "gpt-5.2" }] },
    });
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_family");
    assert.equal(code, 3, JSON.stringify(envelope));
    assert.equal(envelope.error?.details?.["reason"], "eligibility_excluded");
    const exclusions = envelope.error?.details?.["exclusions"] as Array<{
      accountKey: string;
      exclusions: string[];
    }>;
    const mine = exclusions.find((e) => e.accountKey === "record:spark_family");
    assert.ok(mine?.exclusions.includes("family_rate_limited"), JSON.stringify(mine));
  } finally {
    await server.close();
  }
});

test("max concurrency is enforced for the metered lane exactly like any lease", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const first = await claim(world.env, "record:spark_concurrency");
    assert.equal(first.code, 0, JSON.stringify(first.envelope));

    const second = await claim(world.env, "record:spark_concurrency");
    assert.equal(second.code, 3);
    assert.equal(second.envelope.error?.details?.["reason"], "eligibility_excluded");
    const exclusions = second.envelope.error?.details?.["exclusions"] as Array<{
      accountKey: string;
      exclusions: string[];
    }>;
    const mine = exclusions.find((e) => e.accountKey === "record:spark_concurrency");
    assert.ok(mine?.exclusions.includes("max_concurrent_reached"));
  } finally {
    await server.close();
  }
});

test("concurrent metered claims on one account cannot both win under the limit", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const [a, b] = await Promise.all([
      claim(world.env, "record:spark_concurrency"),
      claim(world.env, "record:spark_concurrency"),
    ]);
    const codes = [a.code, b.code].sort();
    assert.deepEqual(codes, [0, 3], "exactly one concurrent claim wins the single slot");
  } finally {
    await server.close();
  }
});

test("--metered-lane rejects invalid flag combinations", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);

    const noAccount = await runCli(
      ["select", "--claim", "--metered-lane", "codex-spark", "--model", SPARK_MODEL, "--json"],
      world.env,
    );
    assert.equal(noAccount.code, 2);

    const noClaim = await runCli(
      ["select", "--account", "record:spark_ok", "--metered-lane", "codex-spark", "--model", SPARK_MODEL, "--json"],
      world.env,
    );
    assert.equal(noClaim.code, 2);

    const noModel = await runCli(
      ["select", "--account", "record:spark_ok", "--claim", "--metered-lane", "codex-spark", "--json"],
      world.env,
    );
    assert.equal(noModel.code, 2);

    const badLane = await runCli(
      ["select", "--account", "record:spark_ok", "--claim", "--metered-lane", "other-lane", "--model", SPARK_MODEL, "--json"],
      world.env,
    );
    assert.equal(badLane.code, 2);

    const withStrategy = await runCli(
      ["select", "--account", "record:spark_ok", "--claim", "--metered-lane", "codex-spark", "--model", SPARK_MODEL, "--strategy", "best", "--json"],
      world.env,
    );
    assert.equal(withStrategy.code, 2);

    const withAllowUnknown = await runCli(
      ["select", "--account", "record:spark_ok", "--claim", "--metered-lane", "codex-spark", "--model", SPARK_MODEL, "--allow-unknown", "--json"],
      world.env,
    );
    assert.equal(withAllowUnknown.code, 2);

    const nonSparkModel = await runCli(
      ["select", "--account", "record:spark_ok", "--claim", "--metered-lane", "codex-spark", "--model", "gpt-5.3-codex", "--json"],
      world.env,
    );
    assert.equal(nonSparkModel.code, 2);

    const modelWithoutLane = await runCli(
      ["select", "--account", "record:spark_ok", "--claim", "--model", SPARK_MODEL, "--json"],
      world.env,
    );
    assert.equal(modelWithoutLane.code, 2);
  } finally {
    await server.close();
  }
});

test("normal select --claim is unaffected by the metered-lane addition", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const result = await runCli(["select", "--account", "record:spark_ok", "--claim", "--json"], world.env);
    // record:spark_ok's general quota is exhausted (limitReached: true), so
    // ordinary selection still refuses it — the waiver is metered-lane only.
    assert.equal(result.code, 3, result.stdout);
    const envelope = JSON.parse(result.stdout) as ClaimEnvelope;
    const exclusions = envelope.error?.details?.["exclusions"] as Array<{
      accountKey: string;
      exclusions: string[];
    }>;
    const mine = exclusions.find((e) => e.accountKey === "record:spark_ok");
    assert.ok(mine?.exclusions.includes("quota_exhausted"));
  } finally {
    await server.close();
  }
});

test("the lease purpose is codex-spark-claim and run --claim consumes it like any lease", async () => {
  const plans = basePlans();
  const server = await startServer(plans);
  try {
    const world = makeWorld(server.url, BASE_FIXTURES);
    await runCli(["usage", "refresh", "--json"], world.env);
    const { code, envelope } = await claim(world.env, "record:spark_ok");
    assert.equal(code, 0, JSON.stringify(envelope));
    const leaseId = envelope.data?.lease?.leaseId;
    assert.ok(leaseId);

    const leases = await runCli(["leases", "--all", "--json"], world.env);
    const leasesEnvelope = JSON.parse(leases.stdout) as {
      data: { leases: Array<{ leaseId: string; purpose: string; status: string; accountKey: string }> };
    };
    const mine = leasesEnvelope.data.leases.find((l) => l.leaseId === leaseId);
    assert.equal(mine?.purpose, "codex-spark-claim");
    assert.equal(mine?.status, "reserved");
    assert.equal(mine?.accountKey, "record:spark_ok");

    const run = await runCli(["run", "--claim", leaseId, "--"], world.env);
    assert.equal(run.code, 0, run.stderr);

    const after = await runCli(["leases", "--all", "--json"], world.env);
    const afterEnvelope = JSON.parse(after.stdout) as {
      data: { leases: Array<{ leaseId: string; status: string; childExitCode: number | null }> };
    };
    const consumed = afterEnvelope.data.leases.find((l) => l.leaseId === leaseId);
    assert.equal(consumed?.status, "released");
    assert.equal(consumed?.childExitCode, 0);

    const again = await runCli(["run", "--claim", leaseId, "--"], world.env);
    assert.equal(again.code, 1, "a consumed lease cannot be reused");
  } finally {
    await server.close();
  }
});
