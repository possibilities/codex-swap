import type { SelectionSettings } from "../config/schema.ts";
import type {
  AccountExclusionReason,
  SnapshotAccountView,
} from "../snapshot/types.ts";

/**
 * Deterministic, explainable, fail-safe selection (handoff §20). Candidates
 * arrive as snapshot views (exclusions already derived); this module applies
 * strategy scoring and returns either a choice with reasons or a structured
 * "none" that a harness can act on. Unknown usage never silently wins: with
 * allowUnknown it scores as zero headroom, so any known headroom beats it.
 */
export type SelectionStrategy = "best" | "next-available";

export interface SelectionReason {
  strategy: SelectionStrategy;
  summary: string;
  headroomPercent: number | null;
  rawHeadroomPercent: number | null;
  concurrencyPenaltyPercent: number;
  priority: number;
  weight: number;
  score: number;
  activeLeases: number;
  tieBreak: "none" | "rotation";
}

export interface AccountExclusion {
  accountKey: string;
  exclusions: AccountExclusionReason[];
}

export type SelectionResult =
  | {
      kind: "selected";
      accountKey: string;
      providerAccountId: string | null;
      reason: SelectionReason;
      exclusions: AccountExclusion[];
    }
  | {
      kind: "none";
      reason:
        | "all_exhausted"
        | "all_unknown"
        | "all_disabled"
        | "all_quarantined"
        | "no_accounts"
        | "dependency_unavailable";
      nextReadyAt: string | null;
      exclusions: AccountExclusion[];
    };

export interface SelectionInput {
  accounts: readonly SnapshotAccountView[];
  strategy: SelectionStrategy;
  settings: SelectionSettings;
  allowUnknown: boolean;
  lastSelectedAccountKey: string | null;
  sequence: number;
}

interface ScoredCandidate {
  view: SnapshotAccountView;
  effectiveExclusions: AccountExclusionReason[];
  headroom: number | null;
  score: number;
}

function effectiveExclusions(
  view: SnapshotAccountView,
  settings: SelectionSettings,
  allowUnknown: boolean,
): AccountExclusionReason[] {
  let exclusions = [...view.selection.exclusions];
  if (allowUnknown) {
    exclusions = exclusions.filter((e) => e !== "usage_unknown");
  }
  const maxConcurrent =
    view.policy.maxConcurrent ?? settings.defaultMaxConcurrent;
  if (
    maxConcurrent !== null &&
    view.selection.activeLeases >= maxConcurrent &&
    !exclusions.includes("max_concurrent_reached")
  ) {
    exclusions.push("max_concurrent_reached");
  }
  return exclusions;
}

function scoreCandidate(
  view: SnapshotAccountView,
  exclusions: AccountExclusionReason[],
  settings: SelectionSettings,
): ScoredCandidate {
  const headroom = view.selection.headroomPercent;
  const effectiveHeadroom = headroom ?? 0;
  const penalty =
    view.selection.activeLeases * settings.concurrencyPenaltyPercent;
  const score =
    (effectiveHeadroom - penalty) * view.policy.weight + view.policy.priority;
  return { view, effectiveExclusions: exclusions, headroom, score };
}

export function selectAccount(input: SelectionInput): SelectionResult {
  const scored = input.accounts.map((view) =>
    scoreCandidate(
      view,
      effectiveExclusions(view, input.settings, input.allowUnknown),
      input.settings,
    ),
  );
  const exclusionReport: AccountExclusion[] = scored
    .filter((c) => c.effectiveExclusions.length > 0)
    .map((c) => ({
      accountKey: c.view.accountKey,
      exclusions: c.effectiveExclusions,
    }));
  const eligible = scored.filter((c) => c.effectiveExclusions.length === 0);

  if (eligible.length === 0) {
    return {
      kind: "none",
      reason: noneReason(scored),
      nextReadyAt: earliestRecovery(scored),
      exclusions: exclusionReport,
    };
  }

  const chosen =
    input.strategy === "best"
      ? chooseBest(eligible, input)
      : chooseNextAvailable(eligible, input);

  return {
    kind: "selected",
    accountKey: chosen.candidate.view.accountKey,
    providerAccountId: chosen.candidate.view.providerAccountId,
    reason: {
      strategy: input.strategy,
      summary: chosen.summary,
      headroomPercent: chosen.candidate.headroom,
      rawHeadroomPercent: chosen.candidate.headroom,
      concurrencyPenaltyPercent:
        chosen.candidate.view.selection.activeLeases *
        input.settings.concurrencyPenaltyPercent,
      priority: chosen.candidate.view.policy.priority,
      weight: chosen.candidate.view.policy.weight,
      score: chosen.candidate.score,
      activeLeases: chosen.candidate.view.selection.activeLeases,
      tieBreak: chosen.tieBreak,
    },
    exclusions: exclusionReport,
  };
}

function chooseBest(
  eligible: ScoredCandidate[],
  input: SelectionInput,
): { candidate: ScoredCandidate; summary: string; tieBreak: "none" | "rotation" } {
  const EPSILON = 1e-9;
  const topScore = Math.max(...eligible.map((c) => c.score));
  const tied = eligible
    .filter((c) => topScore - c.score <= EPSILON)
    .sort((a, b) => compareKeys(a.view.accountKey, b.view.accountKey));
  if (tied.length === 1 || tied[0] === undefined) {
    const candidate = tied[0] ?? eligible[0]!;
    return {
      candidate,
      summary:
        candidate.headroom !== null
          ? `highest trusted headroom (${candidate.headroom.toFixed(1)}%) after lease penalty`
          : "eligible with unknown usage explicitly allowed",
      tieBreak: "none",
    };
  }
  // Fair rotation among near-equal candidates (handoff §20.3): advance
  // through the tied set by selection sequence, preferring the account
  // after the last selected one.
  const lastIndex = tied.findIndex(
    (c) => c.view.accountKey === input.lastSelectedAccountKey,
  );
  const index =
    lastIndex >= 0
      ? (lastIndex + 1) % tied.length
      : input.sequence % tied.length;
  const candidate = tied[index]!;
  return {
    candidate,
    summary: `tie among ${tied.length} near-equal candidates resolved by rotation`,
    tieBreak: "rotation",
  };
}

function chooseNextAvailable(
  eligible: ScoredCandidate[],
  input: SelectionInput,
): { candidate: ScoredCandidate; summary: string; tieBreak: "none" | "rotation" } {
  const ordered = [...eligible].sort((a, b) =>
    compareKeys(a.view.accountKey, b.view.accountKey),
  );
  let candidate = ordered[0]!;
  if (input.lastSelectedAccountKey !== null) {
    const after = ordered.find(
      (c) => compareKeys(c.view.accountKey, input.lastSelectedAccountKey!) > 0,
    );
    if (after !== undefined) candidate = after;
  }
  return {
    candidate,
    summary: "next available account in stable rotation order",
    tieBreak: "rotation",
  };
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function noneReason(
  scored: ScoredCandidate[],
): Extract<SelectionResult, { kind: "none" }>["reason"] {
  if (scored.length === 0) return "no_accounts";
  const every = (reason: AccountExclusionReason | AccountExclusionReason[]) => {
    const reasons = Array.isArray(reason) ? reason : [reason];
    return scored.every((c) =>
      c.effectiveExclusions.some((e) => reasons.includes(e)),
    );
  };
  if (every("quota_exhausted")) return "all_exhausted";
  if (every(["manually_disabled", "ndy_disabled", "absent"])) {
    return "all_disabled";
  }
  if (every("relogin_required")) return "all_quarantined";
  return "all_unknown";
}

/** Earliest credible recovery among exhausted accounts' binding windows. */
function earliestRecovery(scored: ScoredCandidate[]): string | null {
  const resets: number[] = [];
  for (const candidate of scored) {
    if (!candidate.effectiveExclusions.includes("quota_exhausted")) continue;
    const measurement =
      candidate.view.usage.measurement ??
      candidate.view.lastGoodUsage?.measurement ??
      null;
    if (measurement === null) continue;
    for (const window of measurement.windows) {
      if (window.kind !== "primary" && window.kind !== "secondary") continue;
      if (window.resetsAt === undefined) continue;
      const ms = Date.parse(window.resetsAt);
      if (Number.isFinite(ms)) resets.push(ms);
    }
  }
  if (resets.length === 0) return null;
  return new Date(Math.min(...resets)).toISOString();
}
