import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings } from "../../src/config/schema.ts";
import { evaluateTrust } from "../../src/usage/trust.ts";
import type { UsageStateRow } from "../../src/usage/store.ts";

const SETTINGS = defaultSettings().usage;
const NOW = 10_000_000;

function row(overrides: Partial<UsageStateRow>): UsageStateRow {
  return {
    accountKey: "record:r1",
    lastGoodJson: null,
    fetchedAtMs: null,
    lastAttemptAtMs: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorHttpStatus: null,
    lastErrorSummary: null,
    retryAfterMs: null,
    backoffUntilMs: null,
    nextPollAtMs: null,
    pollIntervalMs: null,
    last429AtMs: null,
    authDeadStrikes: 0,
    claimId: null,
    claimUntilMs: null,
    claimGeneration: 0,
    probeKind: null,
    ...overrides,
  };
}

function measurementJson(options?: {
  resetsAtMs?: number;
  windows?: boolean;
}): string {
  const windows =
    options?.windows === false
      ? []
      : [
          {
            kind: "primary",
            label: "5h",
            windowSeconds: 18000,
            usedPercent: 40,
            remainingPercent: 60,
            ...(options?.resetsAtMs !== undefined
              ? { resetsAt: new Date(options.resetsAtMs).toISOString() }
              : {}),
          },
        ];
  return JSON.stringify({
    schemaVersion: 1,
    probeKind: "direct-wham",
    windows,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });
}

test("no measurement is unknown; with failures it reads as error", () => {
  assert.deepEqual(evaluateTrust(row({}), SETTINGS, NOW), {
    decisionGrade: false,
    status: "unknown",
    measurement: null,
  });
  const failed = evaluateTrust(row({ consecutiveFailures: 2 }), SETTINGS, NOW);
  assert.equal(failed.status, "error");
  assert.equal(failed.decisionGrade, false);
});

test("fresh measurement is decision-grade ok", () => {
  const result = evaluateTrust(
    row({ lastGoodJson: measurementJson(), fetchedAtMs: NOW - 60_000 }),
    SETTINGS,
    NOW,
  );
  assert.equal(result.decisionGrade, true);
  assert.equal(result.status, "ok");
});

test("deliberate staleness stays trusted: future poll plan, live claim, or backoff", () => {
  const age = SETTINGS.serveTtlMs + 60_000;
  const base = {
    lastGoodJson: measurementJson(),
    fetchedAtMs: NOW - age,
  };
  for (const deliberate of [
    { nextPollAtMs: NOW + 60_000 },
    { claimUntilMs: NOW + 30_000 },
    { backoffUntilMs: NOW + 30_000, lastErrorCode: "server" },
  ]) {
    const result = evaluateTrust(row({ ...base, ...deliberate }), SETTINGS, NOW);
    assert.equal(result.decisionGrade, true, JSON.stringify(deliberate));
    assert.equal(result.status, "stale");
  }
  // Same age with no deliberate reason: display-grade only.
  const undeliberate = evaluateTrust(row(base), SETTINGS, NOW);
  assert.equal(undeliberate.decisionGrade, false);
});

test("normal trust ceiling expires even with deliberate staleness", () => {
  const result = evaluateTrust(
    row({
      lastGoodJson: measurementJson(),
      fetchedAtMs: NOW - SETTINGS.normalTrustMaxAgeMs - 1,
      nextPollAtMs: NOW + 60_000,
    }),
    SETTINGS,
    NOW,
  );
  assert.equal(result.decisionGrade, false);
  assert.equal(result.status, "stale");
  assert.ok(result.measurement !== null, "display-grade survives decision expiry");
});

test("429 trust extends to the rate-limit ceiling but never past the earliest reset", () => {
  const fetchedAtMs = NOW - SETTINGS.normalTrustMaxAgeMs - 1; // beyond normal ceiling
  const under429 = evaluateTrust(
    row({
      lastGoodJson: measurementJson({ resetsAtMs: NOW + 3_600_000 }),
      fetchedAtMs,
      lastErrorCode: "rate_limited",
      backoffUntilMs: NOW + 60_000,
    }),
    SETTINGS,
    NOW,
  );
  assert.equal(under429.decisionGrade, true, "429 ceiling is longer");

  // Still bounded: past the rate-limit ceiling it expires like anything else.
  const pastCeiling = evaluateTrust(
    row({
      lastGoodJson: measurementJson({ resetsAtMs: NOW + 3_600_000 }),
      fetchedAtMs: NOW - SETTINGS.rateLimitTrustMaxAgeMs - 1,
      lastErrorCode: "rate_limited",
      backoffUntilMs: NOW + 60_000,
    }),
    SETTINGS,
    NOW,
  );
  assert.equal(pastCeiling.decisionGrade, false);
});

test("a past reset invalidates decisions even when the data is young", () => {
  const result = evaluateTrust(
    row({
      lastGoodJson: measurementJson({ resetsAtMs: NOW - 1_000 }),
      fetchedAtMs: NOW - 30_000,
    }),
    SETTINGS,
    NOW,
  );
  assert.equal(result.decisionGrade, false);
  assert.equal(result.status, "stale");
});

test("empty successful measurements and quarantine are never decision-grade", () => {
  const empty = evaluateTrust(
    row({
      lastGoodJson: measurementJson({ windows: false }),
      fetchedAtMs: NOW - 1_000,
    }),
    SETTINGS,
    NOW,
  );
  assert.equal(empty.decisionGrade, false);
  assert.equal(empty.status, "unknown");

  const quarantined = evaluateTrust(
    row({
      lastGoodJson: measurementJson(),
      fetchedAtMs: NOW - 1_000,
      authDeadStrikes: 2,
    }),
    SETTINGS,
    NOW,
  );
  assert.equal(quarantined.decisionGrade, false);
  assert.equal(quarantined.status, "quarantined");
  assert.ok(quarantined.measurement !== null, "display data survives quarantine");
});
