import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseResetCreditDetails,
  parseUsageResponse,
  UsageParseError,
} from "../../src/usage/parser.ts";
import {
  bindingHeadroomPercent,
  bindingUsedPercent,
} from "../../src/usage/types.ts";

const NOW_MS = Date.UTC(2026, 7, 8, 20, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

function parse(body: unknown) {
  return parseUsageResponse(body, { probeKind: "direct-wham", nowMs: NOW_MS });
}

test("parses the official full-shape response", () => {
  // Shape mirrors openai/codex app-server rate_limits test fixture.
  const measurement = parse({
    plan_type: "enterprise_cbp_automation",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18000,
        reset_after_seconds: 120,
        reset_at: NOW_S + 120,
      },
      secondary_window: {
        used_percent: 5,
        limit_window_seconds: 604800,
        reset_after_seconds: 43200,
        reset_at: NOW_S + 43200,
      },
    },
    rate_limit_reached_type: { type: "workspace_member_usage_limit_reached" },
    spend_control: { reached: false },
    additional_rate_limits: [
      {
        limit_name: "codex_code_review",
        metered_feature: "code_review",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 88,
            limit_window_seconds: 1800,
            reset_after_seconds: 600,
            reset_at: NOW_S + 600,
          },
        },
      },
    ],
    rate_limit_reset_credits: { available_count: 3 },
  });

  assert.equal(measurement.planType, "enterprise_cbp_automation");
  assert.equal(measurement.limitReached, false);
  assert.equal(measurement.resetCreditsAvailable, 3);
  assert.equal(measurement.windows.length, 3);

  const [primary, secondary, review] = measurement.windows;
  assert.equal(primary?.kind, "primary");
  assert.equal(primary?.label, "5h");
  assert.equal(primary?.usedPercent, 42);
  assert.equal(primary?.remainingPercent, 58);
  assert.equal(primary?.resetsAt, "2026-08-08T20:02:00.000Z");

  assert.equal(secondary?.kind, "secondary");
  assert.equal(secondary?.label, "weekly");

  assert.equal(review?.kind, "code_review");
  assert.equal(review?.usedPercent, 88);

  // Code-review quota must not bind general selection.
  assert.equal(bindingUsedPercent(measurement), 42);
  assert.equal(bindingHeadroomPercent(measurement), 58);
});

test("weekly-only window is identified by duration, not position", () => {
  const measurement = parse({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 7 * 24 * 3600,
      },
    },
  });
  assert.equal(measurement.windows.length, 1);
  assert.equal(measurement.windows[0]?.kind, "primary");
  assert.equal(measurement.windows[0]?.label, "weekly");
});

test("daily secondary window keeps a daily label (falsifies seven_day assumption)", () => {
  const measurement = parse({
    rate_limit: {
      primary_window: { used_percent: 42, limit_window_seconds: 3600 },
      secondary_window: { used_percent: 5, limit_window_seconds: 86400 },
    },
  });
  assert.equal(measurement.windows[1]?.label, "daily");
});

test("legacy singular code_review_rate_limit is tolerated", () => {
  const measurement = parse({
    rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 18000 },
    },
    code_review_rate_limit: {
      primary_window: { used_percent: 50, limit_window_seconds: 18000 },
    },
  });
  assert.equal(measurement.windows.length, 2);
  assert.equal(measurement.windows[1]?.kind, "code_review");
  assert.equal(bindingUsedPercent(measurement), 1);
});

test("credits balance parses from number, string, and unlimited flag", () => {
  assert.equal(parse({ credits: { balance: 12.5 } }).creditsLeft, 12.5);
  assert.equal(parse({ credits: { balance: "17.25" } }).creditsLeft, 17.25);
  assert.equal(parse({ credits: { balance: "" } }).creditsLeft, undefined);
  const unlimited = parse({ credits: { unlimited: true, balance: null } });
  assert.equal(unlimited.creditsUnlimited, true);
  assert.equal(unlimited.creditsLeft, undefined);
});

test("reset credits preserve zero, omit missing counts, and reject malformed counts", () => {
  assert.equal(
    parse({ rate_limit_reset_credits: { available_count: 0 } })
      .resetCreditsAvailable,
    0,
  );
  assert.equal(parse({}).resetCreditsAvailable, undefined);
  assert.equal(
    parse({ rate_limit_reset_credits: {} }).resetCreditsAvailable,
    undefined,
  );
  assert.equal(
    parse({ rate_limit_reset_credits: { available_count: null } })
      .resetCreditsAvailable,
    undefined,
  );

  for (const available_count of [-1, 1.5, "3"]) {
    assert.throws(
      () => parse({ rate_limit_reset_credits: { available_count } }),
      UsageParseError,
    );
  }
});

test("reset-credit details normalize expiries and preserve non-expiring credits", () => {
  assert.deepEqual(
    parseResetCreditDetails({
      available_count: 2,
      credits: [
        { expires_at: "2026-09-08T12:00:00Z" },
        { expires_at: null },
      ],
    }),
    {
      availableCount: 2,
      expirations: ["2026-09-08T12:00:00.000Z", null],
    },
  );
  assert.deepEqual(parseResetCreditDetails({ available_count: 1 }), {
    availableCount: 1,
  });
  assert.throws(
    () => parseResetCreditDetails({ available_count: 1, credits: [{ expires_at: "later" }] }),
    UsageParseError,
  );
});

test("missing reset fields leave resetsAt undefined; reset_after_seconds substitutes", () => {
  const noReset = parse({
    rate_limit: { primary_window: { used_percent: 5 } },
  });
  assert.equal(noReset.windows[0]?.resetsAt, undefined);
  assert.equal(noReset.windows[0]?.label, "unknown");

  const relativeOnly = parse({
    rate_limit: {
      primary_window: { used_percent: 5, reset_after_seconds: 300 },
    },
  });
  assert.equal(relativeOnly.windows[0]?.resetsAt, "2026-08-08T20:05:00.000Z");
});

test("zero and absurd reset_at values are dropped, not fatal", () => {
  const zero = parse({
    rate_limit: { primary_window: { used_percent: 5, reset_at: 0 } },
  });
  assert.equal(zero.windows[0]?.resetsAt, undefined);

  const absurd = parse({
    rate_limit: {
      primary_window: { used_percent: 5, reset_at: NOW_S + 10 * 365 * 24 * 3600 },
    },
  });
  assert.equal(absurd.windows[0]?.resetsAt, undefined);
  assert.equal(absurd.windows[0]?.usedPercent, 5);
});

test("out-of-range used_percent keeps raw value but clamps remaining", () => {
  const over = parse({
    rate_limit: { primary_window: { used_percent: 250, limit_window_seconds: 18000 } },
  });
  assert.equal(over.windows[0]?.usedPercent, 250);
  assert.equal(over.windows[0]?.remainingPercent, 0);
  assert.equal(bindingUsedPercent(over), 100);

  const negative = parse({
    rate_limit: { primary_window: { used_percent: -3, limit_window_seconds: 18000 } },
  });
  assert.equal(negative.windows[0]?.usedPercent, -3);
  assert.equal(negative.windows[0]?.remainingPercent, 100);
});

test("empty success parses to zero windows (not decision-grade downstream)", () => {
  const empty = parse({});
  assert.equal(empty.windows.length, 0);
  assert.equal(bindingUsedPercent(empty), undefined);
});

test("non-finite numbers and non-object bodies fail without quoting content", () => {
  for (const body of [
    { rate_limit: { primary_window: { used_percent: Infinity } } },
    "sekrit-string-body",
    null,
    42,
  ]) {
    assert.throws(
      () => parse(body),
      (error: unknown) =>
        error instanceof UsageParseError &&
        !error.message.includes("sekrit") &&
        error.message.includes("validation"),
    );
  }
});

test("additional rate-limit lanes carry their identity for consumers", () => {
  // A codex-spark-style model lane: consumers label it as its own meter.
  const measurement = parse({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
    },
    additional_rate_limits: [
      {
        limit_name: "gpt-5.3-codex-spark",
        metered_feature: "codex_spark",
        rate_limit: {
          primary_window: { used_percent: 55, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 30, limit_window_seconds: 604800 },
        },
      },
    ],
  });
  const spark = measurement.windows.filter((w) => w.limitName !== undefined);
  assert.equal(spark.length, 2);
  assert.equal(spark[0]?.limitName, "gpt-5.3-codex-spark");
  assert.equal(spark[0]?.meteredFeature, "codex_spark");
  assert.equal(spark[0]?.kind, "other");
  assert.equal(spark[0]?.label, "5h");
  assert.equal(spark[1]?.label, "weekly");
  // General windows carry no lane identity, and lanes never bind selection.
  assert.equal(measurement.windows[0]?.limitName, undefined);
  assert.equal(bindingUsedPercent(measurement), 10);
});

test("unknown fields are tolerated", () => {
  const measurement = parse({
    plan_type: "pro",
    brand_new_field: { nested: true },
    rate_limit: {
      primary_window: {
        used_percent: 7,
        limit_window_seconds: 18000,
        future_flag: "yes",
      },
    },
  });
  assert.equal(measurement.windows[0]?.usedPercent, 7);
});
