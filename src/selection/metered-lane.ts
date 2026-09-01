import type { UsageMeasurement, UsageWindow } from "../usage/types.ts";
import type { AccountExclusion } from "./selector.ts";

/**
 * Standalone claim primitive for a separately metered lane (handoff §20/§21
 * extension): a lane like the Codex Spark model tier can have headroom while
 * the account's general primary/secondary windows are exhausted. This module
 * proves that independent headroom exists; it never substitutes for the
 * ordinary eligibility gate, which still runs in full except for the one
 * waived exclusion (`quota_exhausted`) this lane exists to bypass.
 */
export const SPARK_METERED_LANE = "codex-spark";
export const SPARK_CLAIM_LEASE_PURPOSE = "codex-spark-claim";

/** A model name is Spark-eligible when its normalized form contains "spark". */
export function isSparkModel(model: string): boolean {
  return model.toLowerCase().includes("spark");
}

/**
 * A window's lane identity: `limitName` verbatim from the wire, falling
 * back to `meteredFeature` only when `limitName` is absent. Compared
 * case-insensitively against the requested lane.
 */
function laneIdentity(window: UsageWindow): string | null {
  const raw =
    window.limitName !== undefined && window.limitName.length > 0
      ? window.limitName
      : window.meteredFeature;
  return raw !== undefined && raw.length > 0 ? raw.toLowerCase() : null;
}

export type MeteredLaneHeadroom =
  | { kind: "available"; headroomPercent: number }
  | { kind: "unavailable" };

/**
 * The conservative (minimum) remaining percentage across every `other`
 * window whose identity maps to `lane`. `unavailable` when the measurement
 * carries no window for the lane at all — missing and unknown lane data
 * both refuse the claim rather than guess.
 */
export function meteredLaneHeadroom(
  measurement: UsageMeasurement,
  lane: string,
): MeteredLaneHeadroom {
  const normalizedLane = lane.toLowerCase();
  const windows = measurement.windows.filter(
    (w) => w.kind === "other" && laneIdentity(w) === normalizedLane,
  );
  if (windows.length === 0) return { kind: "unavailable" };
  const headroomPercent = Math.min(
    ...windows.map((w) => Math.max(0, Math.min(100, w.remainingPercent))),
  );
  return { kind: "available", headroomPercent };
}

export interface MeteredLaneSelected {
  kind: "selected";
  accountKey: string;
  providerAccountId: string | null;
  lane: string;
  headroomPercent: number;
  summary: string;
}

export type MeteredLaneRefusalReason =
  | "account_not_found"
  | "eligibility_excluded"
  | "spark_lane_unavailable"
  | "spark_lane_exhausted";

export interface MeteredLaneRefused {
  kind: "none";
  reason: MeteredLaneRefusalReason;
  exclusions: AccountExclusion[];
}

export type MeteredLaneClaimResult = MeteredLaneSelected | MeteredLaneRefused;
