/**
 * Normalized usage measurement per handoff §15.3, extended with fields the
 * official Codex OpenAPI schema provides that the handoff draft predates:
 * reset_after_seconds (clock-skew-free countdown), credits unlimited flag,
 * and the rate_limit limit_reached boolean.
 *
 * Persisted verbatim as usage_state.last_good_json — keep JSON-serializable
 * and secret-free.
 */
export const USAGE_MEASUREMENT_SCHEMA_VERSION = 1;

export type UsageWindowKind = "primary" | "secondary" | "code_review" | "other";

export interface UsageWindow {
  kind: UsageWindowKind;
  /** Human-facing duration label derived from windowSeconds ("5h", "weekly"). */
  label: string;
  windowSeconds?: number;
  /** Raw finite value from the provider; may fall outside [0, 100]. */
  usedPercent: number;
  /** 100 - clamp(usedPercent, 0, 100); always within [0, 100]. */
  remainingPercent: number;
  /** ISO 8601 UTC. Derived from reset_at (unix seconds) or reset_after_seconds. */
  resetsAt?: string;
  resetAfterSeconds?: number;
}

export type ProbeKind = "direct-wham" | "direct-codex" | "header-probe";

export interface UsageMeasurement {
  schemaVersion: typeof USAGE_MEASUREMENT_SCHEMA_VERSION;
  probeKind: ProbeKind;
  planType?: string;
  creditsLeft?: number;
  creditsUnlimited?: boolean;
  /** True when the provider says the general rate limit is currently reached. */
  limitReached?: boolean;
  windows: UsageWindow[];
  /** ISO 8601 UTC time of the successful fetch. */
  fetchedAt: string;
}

/**
 * The binding used percentage for general Codex selection: the max clamped
 * usedPercent across general (primary/secondary) windows. Code-review and
 * other per-feature windows do not bind by default (handoff §20.2).
 */
export function bindingUsedPercent(
  measurement: UsageMeasurement,
): number | undefined {
  const relevant = measurement.windows.filter(
    (w) => w.kind === "primary" || w.kind === "secondary",
  );
  if (relevant.length === 0) return undefined;
  return Math.max(...relevant.map((w) => clampPercent(w.usedPercent)));
}

export function bindingHeadroomPercent(
  measurement: UsageMeasurement,
): number | undefined {
  const used = bindingUsedPercent(measurement);
  return used === undefined ? undefined : 100 - used;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
