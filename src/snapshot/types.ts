import type { UsageMeasurement } from "../usage/types.ts";

/**
 * The versioned snapshot contract (handoff §19) — the primary integration
 * boundary for TUIs and balancing harnesses. Secret-free by construction:
 * assembled exclusively from redacted catalog rows and the usage store.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

export type AccountExclusionReason =
  | "absent"
  | "ndy_disabled"
  | "manually_disabled"
  | "no_credentials"
  | "relogin_required"
  | "identity_conflict"
  | "cooldown_active"
  | "usage_unknown"
  | "quota_exhausted"
  | "max_concurrent_reached"
  | "pi_profile_missing";

export type UsageStatus =
  | "ok"
  | "stale"
  | "unknown"
  | "error"
  | "backoff"
  | "quarantined";

export interface SnapshotUsageView {
  status: UsageStatus;
  decisionGrade: boolean;
  /** Present only while decision trust rules hold. */
  measurement: UsageMeasurement | null;
  fetchedAt: string | null;
  ageSeconds: number | null;
  nextPollAt: string | null;
  pollIntervalMs: number | null;
  lastError: {
    code: string;
    httpStatus: number | null;
    summary: string | null;
    at: string | null;
  } | null;
}

export interface SnapshotLastGoodView {
  measurement: UsageMeasurement;
  fetchedAt: string;
  ageSeconds: number;
}

export interface SnapshotAccountView {
  accountKey: string;
  providerAccountId: string | null;
  email: string | null;
  label: string | null;
  enabled: boolean;
  present: boolean;
  ndyIndex: number | null;
  auth: {
    status: string;
    reloginRequired: boolean;
  };
  identityConflict: boolean;
  policy: {
    manuallyDisabled: boolean;
    priority: number;
    weight: number;
    maxConcurrent: number | null;
  };
  usage: SnapshotUsageView;
  lastGoodUsage: SnapshotLastGoodView | null;
  selection: {
    eligible: boolean;
    exclusions: AccountExclusionReason[];
    headroomPercent: number | null;
    activeLeases: number;
  };
}

export interface SnapshotRecommendation {
  accountKey: string;
  providerAccountId: string | null;
  strategy: string;
  reason: string;
  headroomPercent: number | null;
  activeLeases: number;
}

export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  dependency: {
    name: string;
    version: string;
    healthy: boolean;
  };
  canonicalCodexHome: string;
  recommendation: SnapshotRecommendation | null;
  accounts: SnapshotAccountView[];
}
