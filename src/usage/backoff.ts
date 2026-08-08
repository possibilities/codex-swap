import type { UsageSettings } from "../config/schema.ts";
import type { UsageErrorCode } from "./error-classifier.ts";
import type { Rng } from "../util/rng.ts";

/**
 * Failure backoff per handoff §18.4. Exponential 30s→10m for plain
 * failures; 429 honors Retry-After with a hard edge floor and jitter;
 * server-supplied Retry-After on non-429 is honored but capped so a
 * malformed proxy cannot park a row forever.
 */
const LADDER_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const LADDER_CAP_MS = 600_000;
const RATE_LIMIT_EDGE_FLOOR_MS = 300_000;

export function failureBackoffMs(input: {
  consecutiveFailures: number;
  errorCode: UsageErrorCode | string;
  retryAfterMs?: number | undefined;
  settings: UsageSettings;
  rng: Rng;
}): number {
  const { settings } = input;
  const jitter = (ms: number): number =>
    Math.round(ms * (1 + settings.jitterFraction * (input.rng() * 2 - 1)));

  if (input.errorCode === "rate_limited") {
    const honored = Math.min(
      input.retryAfterMs ?? 0,
      settings.retryAfterCapMs,
    );
    return jitter(Math.max(honored, RATE_LIMIT_EDGE_FLOOR_MS));
  }

  const step = Math.min(
    Math.max(input.consecutiveFailures, 1) - 1,
    LADDER_MS.length,
  );
  const ladder = step < LADDER_MS.length ? LADDER_MS[step] ?? LADDER_CAP_MS : LADDER_CAP_MS;

  if (input.retryAfterMs !== undefined) {
    // Non-429 Retry-After: honor but cap at the normal trust ceiling.
    const honored = Math.min(input.retryAfterMs, settings.normalTrustMaxAgeMs);
    return jitter(Math.max(ladder, honored));
  }
  return jitter(ladder);
}
