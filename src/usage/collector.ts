import type { CredentialBroker } from "../accounts/credential-broker.ts";
import type { UsageSettings } from "../config/schema.ts";
import type { Clock } from "../util/clock.ts";
import { systemRng, type Rng } from "../util/rng.ts";
import { UsageFetchError } from "./error-classifier.ts";
import { planAfterSuccess, type PollRole } from "./poll-policy.ts";
import type { UsageProbe } from "./probe.ts";
import type {
  FetchClaim,
  PollPlan,
  UsageStateRow,
  UsageStore,
} from "./store.ts";
import type { UsageMeasurement } from "./types.ts";

/**
 * The claim/fetch/record orchestrator (handoff §16.2). Reserve and record
 * are separate transactions; token acquisition and the network fetch happen
 * in between with no database lock held. One account's failure never
 * touches another account's row.
 */
export interface PlanInput {
  accountKey: string;
  previous: UsageStateRow;
  measurement: UsageMeasurement;
  nowMs: number;
}

export type PollPlanner = (input: PlanInput) => PollPlan;

/** Fixed-cadence planner used by focused tests; production uses adaptivePlanner. */
export function fixedPlanner(settings: UsageSettings, rng: Rng = systemRng, clock?: Clock): PollPlanner {
  return (input) => {
    const interval = Math.round(
      settings.candidateDefaultIntervalMs *
        (1 + settings.jitterFraction * (rng() * 2 - 1)),
    );
    const now = clock !== undefined ? clock() : input.nowMs;
    return { nextPollAtMs: now + interval, pollIntervalMs: interval };
  };
}

/** Role-aware adaptive planner (handoff §18.3) — see poll-policy.ts. */
export function adaptivePlanner(
  settings: UsageSettings,
  roleOf: (accountKey: string) => PollRole,
  rng: Rng = systemRng,
): PollPlanner {
  return (input) =>
    planAfterSuccess({
      role: roleOf(input.accountKey),
      previous: input.previous,
      measurement: input.measurement,
      nowMs: input.nowMs,
      settings,
      rng,
    });
}

export interface CollectItem {
  accountKey: string;
  outcome: "success" | "failed" | "skipped";
  reason: string;
}

export class UsageCollector {
  private readonly store: UsageStore;
  private readonly broker: CredentialBroker;
  private readonly probe: UsageProbe;
  private readonly planner: PollPlanner;
  private readonly clock: Clock;

  constructor(options: {
    store: UsageStore;
    broker: CredentialBroker;
    probe: UsageProbe;
    planner: PollPlanner;
    clock: Clock;
  }) {
    this.store = options.store;
    this.broker = options.broker;
    this.probe = options.probe;
    this.planner = options.planner;
    this.clock = options.clock;
  }

  async collect(
    accountKeys: readonly string[],
    options?: { force?: boolean },
  ): Promise<CollectItem[]> {
    const items: CollectItem[] = [];
    for (const accountKey of accountKeys) {
      items.push(await this.collectOne(accountKey, options?.force === true));
    }
    return items;
  }

  private async collectOne(
    accountKey: string,
    force: boolean,
  ): Promise<CollectItem> {
    const reserved = this.store.reserve(accountKey, { force });
    if (reserved.kind !== "claimed") {
      return { accountKey, outcome: "skipped", reason: reserved.kind };
    }
    const claim = reserved.claim;

    try {
      const lease = await this.broker.acquire(accountKey);
      if (lease.kind !== "ready") {
        this.store.recordFailure(claim, {
          code: leaseFailureCode(lease.kind),
          summary: lease.reason,
          authDead: lease.kind === "relogin_required",
          retryAfterMs:
            lease.kind === "transient_failure" ? lease.retryAfterMs : undefined,
        });
        return { accountKey, outcome: "failed", reason: lease.kind };
      }

      let measurement: UsageMeasurement;
      try {
        measurement = await this.fetchWithAuthRetry(accountKey, claim, lease.accessToken, lease.providerAccountId, lease.refreshed);
      } catch (error) {
        if (error instanceof UsageFetchError) {
          this.store.recordFailure(claim, {
            code: error.code,
            httpStatus: error.httpStatus,
            retryAfterMs: error.retryAfterMs,
            summary: error.message,
            authDead: false,
          });
          return { accountKey, outcome: "failed", reason: error.code };
        }
        this.store.recordFailure(claim, {
          code: "internal",
          summary: error instanceof Error ? error.message.slice(0, 120) : "unexpected error",
          authDead: false,
        });
        return { accountKey, outcome: "failed", reason: "internal" };
      }

      const previous = this.store.read(accountKey);
      if (previous === null) {
        return { accountKey, outcome: "skipped", reason: "row_removed" };
      }
      const plan = this.planner({
        accountKey,
        previous,
        measurement,
        nowMs: this.clock(),
      });
      const applied = this.store.recordSuccess(claim, measurement, plan);
      return applied
        ? { accountKey, outcome: "success", reason: measurement.probeKind }
        : { accountKey, outcome: "skipped", reason: "fenced" };
    } catch (error) {
      this.store.releaseClaim(claim);
      throw error;
    }
  }

  /**
   * 401-refresh-retry-once (handoff §15.1): when the first attempt ran on a
   * cached access token, force one refresh and retry; a second auth
   * rejection is a real authentication failure.
   */
  private async fetchWithAuthRetry(
    accountKey: string,
    _claim: FetchClaim,
    accessToken: string,
    providerAccountId: string | undefined,
    alreadyRefreshed: boolean,
  ): Promise<UsageMeasurement> {
    try {
      return await this.probe.fetch({
        accountKey,
        providerAccountId,
        accessToken,
        signal: new AbortController().signal,
      });
    } catch (error) {
      if (
        !(error instanceof UsageFetchError) ||
        error.code !== "auth" ||
        alreadyRefreshed
      ) {
        throw error;
      }
      const retryLease = await this.broker.acquire(accountKey, {
        forceRefresh: true,
      });
      if (retryLease.kind !== "ready") {
        throw error;
      }
      return this.probe.fetch({
        accountKey,
        providerAccountId: retryLease.providerAccountId,
        accessToken: retryLease.accessToken,
        signal: new AbortController().signal,
      });
    }
  }
}

function leaseFailureCode(kind: string): string {
  switch (kind) {
    case "relogin_required":
      return "auth";
    case "identity_conflict":
      return "identity_conflict";
    default:
      return "refresh_transient";
  }
}
