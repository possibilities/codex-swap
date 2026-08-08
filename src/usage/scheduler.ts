import type { UsageSettings } from "../config/schema.ts";
import { QUARANTINE_DEAD_STRIKES } from "./trust.ts";
import type { UsageStateRow } from "./store.ts";

/**
 * The traffic invariant (handoff §18.1): one scheduler pass may fetch the
 * active account when due plus at most one due alternate — chosen by stalest
 * successful measurement (never-measured accounts first), then stable
 * account key. Pool bootstrap therefore fills gradually instead of
 * sweeping, and polling stays approximately flat as the pool grows.
 */
export interface FetchCandidate {
  accountKey: string;
  usage: UsageStateRow | undefined;
}

export function isDue(
  usage: UsageStateRow | undefined,
  settings: UsageSettings,
  nowMs: number,
): boolean {
  if (usage === undefined) return true;
  if (usage.claimUntilMs !== null && usage.claimUntilMs > nowMs) return false;
  if (usage.authDeadStrikes >= QUARANTINE_DEAD_STRIKES) return false;
  if (usage.backoffUntilMs !== null && usage.backoffUntilMs > nowMs) return false;
  if (
    usage.fetchedAtMs !== null &&
    nowMs - usage.fetchedAtMs < settings.serveTtlMs
  ) {
    return false;
  }
  if (usage.nextPollAtMs !== null && usage.nextPollAtMs > nowMs) return false;
  return true;
}

export function selectFetchSet(
  candidates: readonly FetchCandidate[],
  activeAccountKey: string | null,
  settings: UsageSettings,
  nowMs: number,
): string[] {
  const due = candidates.filter((c) => isDue(c.usage, settings, nowMs));
  const selected: string[] = [];

  const active = due.find((c) => c.accountKey === activeAccountKey);
  if (active !== undefined) {
    selected.push(active.accountKey);
  }

  const alternates = due
    .filter((c) => c.accountKey !== activeAccountKey)
    .sort((a, b) => {
      const aFetched = a.usage?.fetchedAtMs ?? -1; // never measured sorts first
      const bFetched = b.usage?.fetchedAtMs ?? -1;
      if (aFetched !== bFetched) return aFetched - bFetched;
      return a.accountKey < b.accountKey ? -1 : a.accountKey > b.accountKey ? 1 : 0;
    });
  const first = alternates[0];
  if (first !== undefined) {
    selected.push(first.accountKey);
  }
  return selected;
}
