import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CredentialBroker,
  CredentialLeaseResult,
} from "../../src/accounts/credential-broker.ts";
import { defaultSettings } from "../../src/config/schema.ts";
import { Database } from "../../src/storage/database.ts";
import { UsageCollector, fixedPlanner } from "../../src/usage/collector.ts";
import { UsageFetchError } from "../../src/usage/error-classifier.ts";
import type { UsageProbe, UsageProbeInput } from "../../src/usage/probe.ts";
import { UsageStore } from "../../src/usage/store.ts";
import type { UsageMeasurement } from "../../src/usage/types.ts";

const SETTINGS = defaultSettings().usage;
const NOW = 5_000_000;

function measurement(usedPercent: number): UsageMeasurement {
  return {
    schemaVersion: 1,
    probeKind: "direct-wham",
    windows: [
      {
        kind: "primary",
        label: "5h",
        windowSeconds: 18000,
        usedPercent,
        remainingPercent: 100 - usedPercent,
      },
    ],
    fetchedAt: new Date(NOW).toISOString(),
  };
}

interface FakeBroker {
  broker: CredentialBroker;
  calls: Array<{ accountKey: string; forceRefresh: boolean }>;
}

function fakeBroker(
  handler: (accountKey: string, forceRefresh: boolean) => CredentialLeaseResult,
): FakeBroker {
  const calls: Array<{ accountKey: string; forceRefresh: boolean }> = [];
  const broker = {
    async acquire(
      accountKey: string,
      options?: { forceRefresh?: boolean },
    ): Promise<CredentialLeaseResult> {
      const forceRefresh = options?.forceRefresh === true;
      calls.push({ accountKey, forceRefresh });
      return handler(accountKey, forceRefresh);
    },
  } as unknown as CredentialBroker;
  return { broker, calls };
}

function readyLease(accountKey: string, refreshed: boolean): CredentialLeaseResult {
  return {
    kind: "ready",
    accountKey,
    providerAccountId: "acc_1",
    accessToken: `token-${refreshed ? "fresh" : "cached"}`,
    expiresAtMs: NOW + 3_600_000,
    lineageHmac: "hmac",
    refreshed,
  };
}

function fakeProbe(
  handler: (input: UsageProbeInput, call: number) => UsageMeasurement,
): { probe: UsageProbe; calls: UsageProbeInput[] } {
  const calls: UsageProbeInput[] = [];
  const probe: UsageProbe = {
    kind: "fake",
    async fetch(input) {
      calls.push(input);
      return handler(input, calls.length);
    },
  };
  return { probe, calls };
}

function world(accountKeys: string[]): { db: Database; store: UsageStore } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collector-"));
  const db = Database.open(path.join(dir, "c.db"), () => NOW);
  for (const key of accountKeys) {
    db.handle
      .prepare(
        "INSERT INTO accounts (account_key, first_seen_at_ms, last_seen_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(key, NOW, NOW, NOW);
    db.handle
      .prepare("INSERT INTO usage_state (account_key, updated_at_ms) VALUES (?, ?)")
      .run(key, NOW);
  }
  const store = new UsageStore({
    db,
    settings: SETTINGS,
    clock: () => NOW,
    rng: () => 0.5,
  });
  return { db, store };
}

function collector(
  store: UsageStore,
  broker: CredentialBroker,
  probe: UsageProbe,
): UsageCollector {
  return new UsageCollector({
    store,
    broker,
    probe,
    planner: fixedPlanner(SETTINGS, () => 0.5, () => NOW),
    clock: () => NOW,
  });
}

test("successful collection stores the measurement and a poll plan", async () => {
  const { store } = world(["record:r1"]);
  const { broker } = fakeBroker((key) => readyLease(key, false));
  const { probe } = fakeProbe(() => measurement(33));

  const items = await collector(store, broker, probe).collect(["record:r1"]);
  assert.deepEqual(items, [
    { accountKey: "record:r1", outcome: "success", reason: "direct-wham" },
  ]);
  const row = store.read("record:r1");
  assert.ok(row?.lastGoodJson?.includes('"usedPercent":33'));
  assert.equal(row?.nextPollAtMs, NOW + SETTINGS.candidateDefaultIntervalMs);
});

test("401 on a cached token forces one refresh and retries once", async () => {
  const { store } = world(["record:r1"]);
  const brokerWorld = fakeBroker((key, forceRefresh) =>
    readyLease(key, forceRefresh),
  );
  const probeWorld = fakeProbe((input, call) => {
    if (call === 1) {
      assert.equal(input.accessToken, "token-cached");
      throw new UsageFetchError("auth", "usage endpoint rejected authentication (401)", {
        httpStatus: 401,
      });
    }
    assert.equal(input.accessToken, "token-fresh");
    return measurement(12);
  });

  const items = await collector(store, brokerWorld.broker, probeWorld.probe).collect([
    "record:r1",
  ]);
  assert.equal(items[0]?.outcome, "success");
  assert.deepEqual(
    brokerWorld.calls.map((c) => c.forceRefresh),
    [false, true],
  );
  assert.equal(probeWorld.calls.length, 2);
});

test("a second 401 records an auth failure without dead strikes", async () => {
  const { store } = world(["record:r1"]);
  const { broker } = fakeBroker((key, forceRefresh) => readyLease(key, forceRefresh));
  const { probe } = fakeProbe(() => {
    throw new UsageFetchError("auth", "usage endpoint rejected authentication (401)", {
      httpStatus: 401,
    });
  });

  const items = await collector(store, broker, probe).collect(["record:r1"]);
  assert.deepEqual(items, [
    { accountKey: "record:r1", outcome: "failed", reason: "auth" },
  ]);
  const row = store.read("record:r1");
  assert.equal(row?.lastErrorCode, "auth");
  assert.equal(row?.authDeadStrikes, 0, "endpoint 401s never strike the lineage");
});

test("broker relogin_required records an auth-dead strike", async () => {
  const { store } = world(["record:r1"]);
  const { broker } = fakeBroker(() => ({
    kind: "relogin_required",
    reason: "refresh rejected permanently (http_error 400)",
  }));
  const { probe, calls } = fakeProbe(() => measurement(1));

  const items = await collector(store, broker, probe).collect(["record:r1"]);
  assert.equal(items[0]?.outcome, "failed");
  assert.equal(calls.length, 0, "no probe without credentials");
  const row = store.read("record:r1");
  assert.equal(row?.authDeadStrikes, 1);
  assert.equal(row?.lastErrorCode, "auth");
});

test("one account's failure leaves other accounts untouched", async () => {
  const { store } = world(["record:ok", "record:bad"]);
  const { broker } = fakeBroker((key) => readyLease(key, true));
  const { probe } = fakeProbe((input) => {
    if (input.accountKey === "record:bad") {
      throw new UsageFetchError("server", "usage endpoint server error (503)", {
        httpStatus: 503,
      });
    }
    return measurement(20);
  });

  const items = await collector(store, broker, probe).collect([
    "record:ok",
    "record:bad",
  ]);
  assert.equal(items[0]?.outcome, "success");
  assert.equal(items[1]?.outcome, "failed");

  const ok = store.read("record:ok");
  const bad = store.read("record:bad");
  assert.ok(ok?.lastGoodJson !== null);
  assert.equal(ok?.lastErrorCode, null);
  assert.equal(bad?.lastGoodJson, null);
  assert.equal(bad?.lastErrorCode, "server");
});

test("non-due accounts are skipped by the store, not fetched", async () => {
  const { store } = world(["record:r1"]);
  const { broker } = fakeBroker((key) => readyLease(key, false));
  const first = fakeProbe(() => measurement(5));
  await collector(store, broker, first.probe).collect(["record:r1"]);

  const second = fakeProbe(() => measurement(6));
  const items = await collector(store, broker, second.probe).collect(["record:r1"]);
  assert.deepEqual(items, [
    { accountKey: "record:r1", outcome: "skipped", reason: "not_due" },
  ]);
  assert.equal(second.calls.length, 0);
});
