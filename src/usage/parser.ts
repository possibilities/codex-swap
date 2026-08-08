import { z } from "zod";
import { toIsoUtc } from "../util/clock.ts";
import {
  clampPercent,
  USAGE_MEASUREMENT_SCHEMA_VERSION,
  type ProbeKind,
  type UsageMeasurement,
  type UsageWindow,
  type UsageWindowKind,
} from "./types.ts";

/**
 * Wire schema for GET /backend-api/wham/usage (and /api/codex/usage),
 * validated against the official Codex OpenAPI models
 * (RateLimitStatusPayload / RateLimitWindowSnapshot / CreditStatusDetails)
 * rather than the Go reference: `code_review_rate_limit` (singular) is a
 * legacy shape kept tolerated, per-feature limits actually arrive via
 * `additional_rate_limits`, and `credits.balance` may be a string.
 *
 * Parse failures must never quote response contents — error messages carry
 * field paths and issue codes only.
 */

const wireWindow = z.looseObject({
  used_percent: z.number(),
  limit_window_seconds: z.number().nullish(),
  reset_after_seconds: z.number().nullish(),
  reset_at: z.number().nullish(),
});

const wireRateLimit = z.looseObject({
  allowed: z.boolean().nullish(),
  limit_reached: z.boolean().nullish(),
  primary_window: wireWindow.nullish(),
  secondary_window: wireWindow.nullish(),
});

const wireCredits = z.looseObject({
  balance: z.union([z.number(), z.string()]).nullish(),
  has_credits: z.boolean().nullish(),
  unlimited: z.boolean().nullish(),
});

const wireAdditionalLimit = z.looseObject({
  limit_name: z.string().nullish(),
  metered_feature: z.string().nullish(),
  rate_limit: wireRateLimit.nullish(),
});

const wireUsageResponse = z.looseObject({
  plan_type: z.string().nullish(),
  rate_limit: wireRateLimit.nullish(),
  code_review_rate_limit: wireRateLimit.nullish(),
  additional_rate_limits: z.array(wireAdditionalLimit).nullish(),
  credits: wireCredits.nullish(),
});

export class UsageParseError extends Error {}

const MAX_CREDIBLE_RESET_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Duration buckets matching the official CLI's display labels. */
function windowLabel(windowSeconds: number | undefined): string {
  if (windowSeconds === undefined || windowSeconds <= 0) return "unknown";
  const minutes = Math.ceil(windowSeconds / 60);
  const buckets: Array<[string, number]> = [
    ["5h", 300],
    ["daily", 1440],
    ["weekly", 10080],
    ["monthly", 43200],
    ["annual", 525600],
  ];
  for (const [label, bucketMinutes] of buckets) {
    if (Math.abs(minutes - bucketMinutes) <= bucketMinutes * 0.05) {
      return label;
    }
  }
  return `${windowSeconds}s`;
}

function normalizeWindow(
  raw: z.infer<typeof wireWindow>,
  kind: UsageWindowKind,
  nowMs: number,
): UsageWindow {
  const windowSeconds =
    raw.limit_window_seconds !== null &&
    raw.limit_window_seconds !== undefined &&
    raw.limit_window_seconds > 0
      ? raw.limit_window_seconds
      : undefined;

  const window: UsageWindow = {
    kind,
    label: windowLabel(windowSeconds),
    usedPercent: raw.used_percent,
    remainingPercent: 100 - clampPercent(raw.used_percent),
  };
  if (windowSeconds !== undefined) {
    window.windowSeconds = windowSeconds;
  }
  if (
    raw.reset_after_seconds !== null &&
    raw.reset_after_seconds !== undefined &&
    raw.reset_after_seconds >= 0
  ) {
    window.resetAfterSeconds = raw.reset_after_seconds;
  }

  // reset_at is unix seconds. An absurd value drops the reset rather than the
  // measurement; reset_after_seconds substitutes when usable.
  const resetAtMs =
    raw.reset_at !== null && raw.reset_at !== undefined && raw.reset_at > 0
      ? raw.reset_at * 1000
      : undefined;
  if (
    resetAtMs !== undefined &&
    resetAtMs <= nowMs + MAX_CREDIBLE_RESET_AHEAD_MS
  ) {
    window.resetsAt = toIsoUtc(resetAtMs);
  } else if (window.resetAfterSeconds !== undefined) {
    window.resetsAt = toIsoUtc(nowMs + window.resetAfterSeconds * 1000);
  }
  return window;
}

function isCodeReviewFeature(entry: z.infer<typeof wireAdditionalLimit>): boolean {
  const name = (entry.metered_feature ?? entry.limit_name ?? "").toLowerCase();
  return name.includes("code_review") || name.includes("code-review");
}

function parseFlexibleNumber(
  value: number | string | null | undefined,
): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseUsageResponse(
  body: unknown,
  options: { probeKind: ProbeKind; nowMs: number },
): UsageMeasurement {
  const result = wireUsageResponse.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.code}`)
      .join("; ");
    throw new UsageParseError(`usage response failed validation (${issues})`);
  }
  const wire = result.data;

  const windows: UsageWindow[] = [];
  const general = wire.rate_limit;
  if (general?.primary_window != null) {
    windows.push(normalizeWindow(general.primary_window, "primary", options.nowMs));
  }
  if (general?.secondary_window != null) {
    windows.push(
      normalizeWindow(general.secondary_window, "secondary", options.nowMs),
    );
  }
  const legacyCodeReview = wire.code_review_rate_limit;
  for (const raw of [
    legacyCodeReview?.primary_window,
    legacyCodeReview?.secondary_window,
  ]) {
    if (raw != null) {
      windows.push(normalizeWindow(raw, "code_review", options.nowMs));
    }
  }
  for (const entry of wire.additional_rate_limits ?? []) {
    const kind: UsageWindowKind = isCodeReviewFeature(entry)
      ? "code_review"
      : "other";
    for (const raw of [
      entry.rate_limit?.primary_window,
      entry.rate_limit?.secondary_window,
    ]) {
      if (raw != null) {
        windows.push(normalizeWindow(raw, kind, options.nowMs));
      }
    }
  }

  const measurement: UsageMeasurement = {
    schemaVersion: USAGE_MEASUREMENT_SCHEMA_VERSION,
    probeKind: options.probeKind,
    windows,
    fetchedAt: toIsoUtc(options.nowMs),
  };
  if (wire.plan_type != null && wire.plan_type.length > 0) {
    measurement.planType = wire.plan_type;
  }
  const balance = parseFlexibleNumber(wire.credits?.balance);
  if (balance !== undefined) {
    measurement.creditsLeft = balance;
  }
  if (wire.credits?.unlimited != null) {
    measurement.creditsUnlimited = wire.credits.unlimited;
  }
  if (general?.limit_reached != null) {
    measurement.limitReached = general.limit_reached;
  }
  return measurement;
}
