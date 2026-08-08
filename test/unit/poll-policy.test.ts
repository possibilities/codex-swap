import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings } from "../../src/config/schema.ts";
import { planAfterSuccess, type PollRole } from "../../src/usage/poll-policy.ts";
import { isDue, selectFetchSet } from "../../src/usage/scheduler.ts";
import type { UsageStateRow } from "../../src/usage/store.ts";
import type { UsageMeasurement } from "../../src/usage/types.ts";

const SETTINGS = defaultSettings().usage;
const NOW = 50_000_000;
const CENTER_RNG = () => 0.5; // jitter factor exactly 1.0

function measurement(
  usedPercent: number,
  options?: { resetInMs?: number; limitReached?: boolean },
): UsageMeasurement {
  return {
    schemaVersion: 1,
    probeKind: "direct-wham",
    ...(options?.limitReached !== undefined
      ? { limitReached: options.limitReached }
      : {}),
    windows: [
      {
        kind: "primary",
        label: "5h",
        windowSeconds: 18000,
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        ...(options?.resetInMs !== undefined
          ? { resetsAt: new Date(NOW + options.resetInMs).toISOString() }
          : {}),
      },
    ],
    fetchedAt: new Date(NOW).toISOString(),
  };
}

function previousRow(overrides?: Partial<UsageStateRow>): UsageStateRow {
  return {
    accountKey: "record:r1",
    lastGoodJson: JSON.stringify(measurement(40)),
    fetchedAtMs: NOW - 300_000,
    lastAttemptAtMs: NOW - 300_000,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorHttpStatus: null,
    lastErrorSummary: null,
    retryAfterMs: null,
    backoffUntilMs: null,
    nextPollAtMs: null,
    pollIntervalMs: 300_000,
    last429AtMs: null,
    authDeadStrikes: 0,
    claimId: null,
    claimUntilMs: null,
    claimGeneration: 1,
    probeKind: "direct-wham",
    ...overrides,
  };
}

function plan(
  role: PollRole,
  previous: UsageStateRow,
  next: UsageMeasurement,
  rng = CENTER_RNG,
) {
  return planAfterSuccess({
    role,
    previous,
    measurement: next,
    nowMs: NOW,
    settings: SETTINGS,
    rng,
  });
}

test("no comparable usage falls back to the role default", () => {
  const noPrevious = previousRow({ lastGoodJson: null, pollIntervalMs: null });
  assert.equal(
    plan("active", noPrevious, measurement(10)).pollIntervalMs,
    SETTINGS.activeDefaultIntervalMs,
  );
  assert.equal(
    plan("candidate", noPrevious, measurement(10)).pollIntervalMs,
    SETTINGS.candidateDefaultIntervalMs,
  );
});

test("movement halves the interval down to the floor; calm widens to the role ceiling", () => {
  const moving = plan("candidate", previousRow(), measurement(45));
  assert.equal(moving.pollIntervalMs, Math.max(SETTINGS.minimumIntervalMs, 150_000));

  const calm = plan("candidate", previousRow(), measurement(40.2));
  assert.equal(calm.pollIntervalMs, Math.min(SETTINGS.candidateMaximumIntervalMs, 450_000));

  // Repeated calm caps at the ceiling.
  const widest = plan(
    "candidate",
    previousRow({ pollIntervalMs: SETTINGS.candidateMaximumIntervalMs }),
    measurement(40),
  );
  assert.equal(widest.pollIntervalMs, SETTINGS.candidateMaximumIntervalMs);

  // Halving never goes below the minimum.
  const floored = plan(
    "candidate",
    previousRow({ pollIntervalMs: SETTINGS.minimumIntervalMs }),
    measurement(60),
  );
  assert.equal(floored.pollIntervalMs, SETTINGS.minimumIntervalMs);
});

test("urgent mode requires active role, upward movement near the threshold, no recent 429", () => {
  const urgent = plan("active", previousRow({ lastGoodJson: JSON.stringify(measurement(74)) }), measurement(80));
  assert.equal(urgent.pollIntervalMs, SETTINGS.urgentIntervalMs);

  // Candidate role: no urgent mode.
  const candidate = plan("candidate", previousRow({ lastGoodJson: JSON.stringify(measurement(74)) }), measurement(80));
  assert.notEqual(candidate.pollIntervalMs, SETTINGS.urgentIntervalMs);

  // Moving down out of the hot zone: no urgent mode.
  const cooling = plan("active", previousRow({ lastGoodJson: JSON.stringify(measurement(90)) }), measurement(80));
  assert.notEqual(cooling.pollIntervalMs, SETTINGS.urgentIntervalMs);

  // Movement stopped: snaps back to the normal widen path.
  const stopped = plan(
    "active",
    previousRow({
      lastGoodJson: JSON.stringify(measurement(80)),
      pollIntervalMs: SETTINGS.urgentIntervalMs,
    }),
    measurement(80),
  );
  assert.equal(
    stopped.pollIntervalMs,
    Math.max(SETTINGS.minimumIntervalMs, SETTINGS.urgentIntervalMs * 1.5),
  );

  // Recent 429 suppresses urgent mode entirely.
  const with429 = plan(
    "active",
    previousRow({
      lastGoodJson: JSON.stringify(measurement(74)),
      last429AtMs: NOW - 60_000,
    }),
    measurement(80),
  );
  assert.ok(with429.pollIntervalMs >= SETTINGS.post429MinimumIntervalMs);
});

test("recent 429 floors and multiplicatively widens the cadence (AIMD)", () => {
  const first = plan(
    "candidate",
    previousRow({ last429AtMs: NOW - 60_000, pollIntervalMs: 200_000 }),
    measurement(40),
  );
  // max(widen(200k->300k), 200k*1.5, post429Min=360k) = 360k
  assert.equal(first.pollIntervalMs, SETTINGS.post429MinimumIntervalMs);

  const widened = plan(
    "candidate",
    previousRow({ last429AtMs: NOW - 60_000, pollIntervalMs: 400_000 }),
    measurement(40),
  );
  assert.equal(widened.pollIntervalMs, 600_000);

  const capped = plan(
    "candidate",
    previousRow({ last429AtMs: NOW - 60_000, pollIntervalMs: 5_000_000 }),
    measurement(40),
  );
  assert.equal(capped.pollIntervalMs, SETTINGS.post429MaximumIntervalMs);

  // Outside the recent-429 window the floor lifts.
  const recovered = plan(
    "candidate",
    previousRow({
      last429AtMs: NOW - SETTINGS.recent429WindowMs - 1,
      pollIntervalMs: 400_000,
    }),
    measurement(40),
  );
  assert.equal(recovered.pollIntervalMs, SETTINGS.candidateMaximumIntervalMs);
});

test("exhausted accounts rest on the bounded slow cadence", () => {
  const exhausted = plan("active", previousRow(), measurement(100));
  assert.ok(exhausted.pollIntervalMs >= SETTINGS.exhaustedIntervalMs);

  const flagged = plan(
    "active",
    previousRow(),
    measurement(50, { limitReached: true }),
  );
  assert.ok(flagged.pollIntervalMs >= SETTINGS.exhaustedIntervalMs);
});

test("a known future reset pulls the next poll earlier", () => {
  const resetSoon = plan(
    "candidate",
    previousRow(),
    measurement(40.1, { resetInMs: 120_000 }),
  );
  assert.equal(resetSoon.nextPollAtMs, NOW + 120_000 + SETTINGS.resetSlackMs);

  // A distant reset does not shorten the plan.
  const resetFar = plan(
    "candidate",
    previousRow(),
    measurement(40.1, { resetInMs: 24 * 3_600_000 }),
  );
  assert.equal(resetFar.nextPollAtMs, NOW + resetFar.pollIntervalMs);
});

test("jitter is deterministic under an injected RNG and bounded by the fraction", () => {
  const low = plan("candidate", previousRow(), measurement(40.1), () => 0);
  const high = plan("candidate", previousRow(), measurement(40.1), () => 0.999999);
  const interval = 450_000;
  assert.equal(low.nextPollAtMs, NOW + Math.round(interval * (1 - SETTINGS.jitterFraction)));
  assert.ok(high.nextPollAtMs <= NOW + Math.round(interval * (1 + SETTINGS.jitterFraction)));
  assert.ok(high.nextPollAtMs > low.nextPollAtMs);
});

test("fetch set honors the traffic invariant: active plus at most one alternate", () => {
  const usageOf = (fetchedAtMs: number | null): UsageStateRow =>
    previousRow({ fetchedAtMs, nextPollAtMs: null, pollIntervalMs: null });

  // 100 accounts, all due: only two fetches per pass.
  const many = Array.from({ length: 100 }, (_, i) => ({
    accountKey: `record:r${String(i).padStart(3, "0")}`,
    usage: i === 0 ? usageOf(NOW - 10_000_000) : undefined,
  }));
  const selected = selectFetchSet(many, "record:r050", SETTINGS, NOW);
  assert.equal(selected.length, 2);
  assert.equal(selected[0], "record:r050", "active first");
  assert.equal(selected[1], "record:r001", "never-measured alternate beats stale");

  // Two accounts behave identically — no sweep amplification either way.
  const two = many.slice(0, 2);
  assert.equal(selectFetchSet(two, null, SETTINGS, NOW).length, 1);
});

test("pool bootstrap fills gradually, one alternate per pass", () => {
  const measured = new Map<string, number>();
  const keys = ["record:a", "record:b", "record:c", "record:d", "record:e"];
  for (let pass = 0; pass < keys.length; pass++) {
    const candidates = keys.map((accountKey) => {
      const fetchedAt = measured.get(accountKey);
      return {
        accountKey,
        usage:
          fetchedAt !== undefined
            ? previousRow({
                accountKey,
                fetchedAtMs: fetchedAt,
                nextPollAtMs: fetchedAt + 300_000_000,
              })
            : undefined,
      };
    });
    const selected = selectFetchSet(candidates, null, SETTINGS, NOW + pass);
    assert.equal(selected.length, 1, `pass ${pass} fetches exactly one`);
    const key = selected[0];
    assert.ok(key !== undefined);
    assert.ok(!measured.has(key), "each pass fills a new account");
    measured.set(key, NOW + pass);
  }
  assert.equal(measured.size, keys.length, "whole pool measured after N passes");
});

test("isDue respects claims, backoff, quarantine, serve TTL, and poll plans", () => {
  assert.equal(isDue(undefined, SETTINGS, NOW), true);
  assert.equal(isDue(previousRow({ claimUntilMs: NOW + 1_000 }), SETTINGS, NOW), false);
  assert.equal(isDue(previousRow({ authDeadStrikes: 2 }), SETTINGS, NOW), false);
  assert.equal(isDue(previousRow({ backoffUntilMs: NOW + 1 }), SETTINGS, NOW), false);
  assert.equal(
    isDue(previousRow({ fetchedAtMs: NOW - 1_000 }), SETTINGS, NOW),
    false,
    "inside serve TTL",
  );
  assert.equal(
    isDue(previousRow({ nextPollAtMs: NOW + 1 }), SETTINGS, NOW),
    false,
  );
  assert.equal(
    isDue(
      previousRow({ fetchedAtMs: NOW - SETTINGS.serveTtlMs - 1, nextPollAtMs: NOW - 1 }),
      SETTINGS,
      NOW,
    ),
    true,
  );
});
