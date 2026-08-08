import type { UsageSettings } from "../config/schema.ts";
import type { UsageStateRow } from "./store.ts";
import type { UsageMeasurement } from "./types.ts";

/**
 * Freshness and trust model per handoff §17: display-grade (last-good with
 * age) and decision-grade (trusted for automatic selection) are computed
 * separately, and the snapshot schema keeps them impossible to confuse.
 */
export const QUARANTINE_DEAD_STRIKES = 2;

export type TrustStatus =
  | "ok"
  | "stale"
  | "unknown"
  | "error"
  | "backoff"
  | "quarantined";

export interface TrustResult {
  decisionGrade: boolean;
  status: TrustStatus;
  measurement: UsageMeasurement | null;
}

export function parseStoredMeasurement(
  json: string | null,
): UsageMeasurement | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as UsageMeasurement;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.windows)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Earliest reset among general windows, epoch ms; undefined when none. */
function earliestGeneralResetMs(
  measurement: UsageMeasurement,
): number | undefined {
  const resets = measurement.windows
    .filter((w) => w.kind === "primary" || w.kind === "secondary")
    .map((w) => (w.resetsAt !== undefined ? Date.parse(w.resetsAt) : NaN))
    .filter((ms) => Number.isFinite(ms));
  return resets.length > 0 ? Math.min(...resets) : undefined;
}

export function evaluateTrust(
  row: UsageStateRow,
  settings: UsageSettings,
  nowMs: number,
): TrustResult {
  if (row.authDeadStrikes >= QUARANTINE_DEAD_STRIKES) {
    return {
      decisionGrade: false,
      status: "quarantined",
      measurement: parseStoredMeasurement(row.lastGoodJson),
    };
  }

  const measurement = parseStoredMeasurement(row.lastGoodJson);
  if (measurement === null || row.fetchedAtMs === null) {
    return {
      decisionGrade: false,
      status: row.consecutiveFailures > 0 ? "error" : "unknown",
      measurement: null,
    };
  }

  // An empty-but-successful response is display-grade at best (§15.3).
  if (measurement.windows.length === 0) {
    return { decisionGrade: false, status: "unknown", measurement };
  }

  // A general reset in the past invalidates the measurement for decisions
  // regardless of age (§17.8).
  const earliestReset = earliestGeneralResetMs(measurement);
  if (earliestReset !== undefined && earliestReset <= nowMs) {
    return { decisionGrade: false, status: "stale", measurement };
  }

  const age = nowMs - row.fetchedAtMs;
  if (age < settings.serveTtlMs) {
    return { decisionGrade: true, status: "ok", measurement };
  }

  // Beyond the serve TTL, staleness stays decision-grade only while it is
  // deliberate: a future poll plan, a live fetch claim, or an active
  // failure backoff — and only under the applicable trust ceiling (§17.4-6).
  const deliberate =
    (row.nextPollAtMs !== null && row.nextPollAtMs > nowMs) ||
    (row.claimUntilMs !== null && row.claimUntilMs > nowMs) ||
    (row.backoffUntilMs !== null && row.backoffUntilMs > nowMs);

  // For 429s usage is monotone within its window, so last-good remains a
  // conservative lower bound until the earliest reset (the past-reset rule
  // above invalidates it the moment that reset passes) — but never beyond
  // the client-side rate-limit ceiling (§17.5).
  const rateLimited = row.lastErrorCode === "rate_limited";
  const ceiling = rateLimited
    ? settings.rateLimitTrustMaxAgeMs
    : settings.normalTrustMaxAgeMs;

  if (deliberate && age <= ceiling) {
    return { decisionGrade: true, status: "stale", measurement };
  }
  return { decisionGrade: false, status: "stale", measurement };
}
