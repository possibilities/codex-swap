import { randomUUID } from "node:crypto";
import type { UsageSettings } from "../config/schema.ts";
import type { Database } from "../storage/database.ts";
import { recordEvent } from "../storage/events.ts";
import type { Clock } from "../util/clock.ts";
import { systemRng, type Rng } from "../util/rng.ts";
import { failureBackoffMs } from "./backoff.ts";
import type { UsageErrorCode } from "./error-classifier.ts";
import { QUARANTINE_DEAD_STRIKES } from "./trust.ts";
import { bindingUsedPercent, type UsageMeasurement } from "./types.ts";

/**
 * The persisted usage store (handoff §16): reserve/fetch/record with random
 * fence IDs and claim generations, stale-on-error semantics, and distinct
 * failure classes. The store lock is never held across network I/O — the
 * collector runs reserve and record as two separate immediate transactions.
 */
export interface UsageStateRow {
  accountKey: string;
  lastGoodJson: string | null;
  fetchedAtMs: number | null;
  lastAttemptAtMs: number | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorHttpStatus: number | null;
  lastErrorSummary: string | null;
  retryAfterMs: number | null;
  backoffUntilMs: number | null;
  nextPollAtMs: number | null;
  pollIntervalMs: number | null;
  last429AtMs: number | null;
  authDeadStrikes: number;
  claimId: string | null;
  claimUntilMs: number | null;
  claimGeneration: number;
  probeKind: string | null;
}

export interface FetchClaim {
  accountKey: string;
  claimId: string;
  generation: number;
}

export type ReserveOutcome =
  | { kind: "claimed"; claim: FetchClaim }
  | { kind: "not_due"; nextPollAtMs: number | null }
  | { kind: "backoff"; untilMs: number }
  | { kind: "claimed_elsewhere"; untilMs: number }
  | { kind: "quarantined" }
  | { kind: "missing" };

export interface PollPlan {
  nextPollAtMs: number;
  pollIntervalMs: number;
}

export interface UsageFailure {
  code: UsageErrorCode | string;
  httpStatus?: number | undefined;
  retryAfterMs?: number | undefined;
  summary: string;
  /** Confirmed dead credential lineage (invalid_grant / missing refresh). */
  authDead: boolean;
}

const SUMMARY_LIMIT = 200;

export class UsageStore {
  private readonly db: Database;
  private readonly settings: UsageSettings;
  private readonly clock: Clock;
  private readonly rng: Rng;

  constructor(options: {
    db: Database;
    settings: UsageSettings;
    clock: Clock;
    rng?: Rng;
  }) {
    this.db = options.db;
    this.settings = options.settings;
    this.clock = options.clock;
    this.rng = options.rng ?? systemRng;
  }

  /**
   * Fetch-eligibility decision plus claim write, one immediate transaction.
   * `force` bypasses only the poll plan / serve TTL — never claims, backoff,
   * or quarantine (handoff §24 usage refresh).
   */
  reserve(accountKey: string, options?: { force?: boolean }): ReserveOutcome {
    const now = this.clock();
    return this.db.immediate(() => {
      const row = this.readRow(accountKey);
      if (row === null) return { kind: "missing" };

      if (row.claimUntilMs !== null && row.claimUntilMs > now) {
        return { kind: "claimed_elsewhere", untilMs: row.claimUntilMs };
      }
      if (row.authDeadStrikes >= QUARANTINE_DEAD_STRIKES) {
        return { kind: "quarantined" };
      }
      if (row.backoffUntilMs !== null && row.backoffUntilMs > now) {
        return { kind: "backoff", untilMs: row.backoffUntilMs };
      }
      if (options?.force !== true) {
        const fresh =
          row.fetchedAtMs !== null &&
          now - row.fetchedAtMs < this.settings.serveTtlMs;
        const scheduledLater =
          row.nextPollAtMs !== null && row.nextPollAtMs > now;
        if (fresh || scheduledLater) {
          return { kind: "not_due", nextPollAtMs: row.nextPollAtMs };
        }
      }

      const claimId = randomUUID();
      const generation = row.claimGeneration + 1;
      this.db.handle
        .prepare(
          `UPDATE usage_state
           SET claim_id = ?, claim_until_ms = ?, claim_generation = ?,
               last_attempt_at_ms = ?, updated_at_ms = ?
           WHERE account_key = ?`,
        )
        .run(
          claimId,
          now + this.settings.fetchClaimTtlMs,
          generation,
          now,
          now,
          accountKey,
        );
      recordEvent(this.db.handle, now, "usage_claim_acquired", accountKey);
      return {
        kind: "claimed",
        claim: { accountKey, claimId, generation },
      };
    });
  }

  /** True when the result was applied; false when fenced out. */
  recordSuccess(claim: FetchClaim, measurement: UsageMeasurement, plan: PollPlan): boolean {
    const now = this.clock();
    return this.db.immediate(() => {
      if (!this.fence(claim, now)) return false;
      this.db.handle
        .prepare(
          `UPDATE usage_state
           SET last_good_json = ?, fetched_at_ms = ?,
               consecutive_failures = 0, last_error_code = NULL,
               last_error_http_status = NULL, last_error_summary = NULL,
               retry_after_ms = NULL, backoff_until_ms = NULL,
               auth_dead_strikes = 0,
               next_poll_at_ms = ?, poll_interval_ms = ?,
               claim_id = NULL, claim_until_ms = NULL,
               probe_kind = ?, updated_at_ms = ?
           WHERE account_key = ?`,
        )
        .run(
          JSON.stringify(measurement),
          now,
          plan.nextPollAtMs,
          plan.pollIntervalMs,
          measurement.probeKind,
          now,
          claim.accountKey,
        );
      recordEvent(this.db.handle, now, "usage_fetch_succeeded", claim.accountKey, {
        probeKind: measurement.probeKind,
        bindingUsedPercent: bindingUsedPercent(measurement) ?? null,
      });
      return true;
    });
  }

  /** Never touches last_good_json or fetched_at_ms (§16.4). */
  recordFailure(claim: FetchClaim, failure: UsageFailure): boolean {
    const now = this.clock();
    return this.db.immediate(() => {
      if (!this.fence(claim, now)) return false;
      const row = this.readRow(claim.accountKey);
      if (row === null) return false;

      const consecutiveFailures = row.consecutiveFailures + 1;
      const backoffMs = failureBackoffMs({
        consecutiveFailures,
        errorCode: failure.code,
        retryAfterMs: failure.retryAfterMs,
        settings: this.settings,
        rng: this.rng,
      });
      const is429 = failure.code === "rate_limited";
      this.db.handle
        .prepare(
          `UPDATE usage_state
           SET consecutive_failures = ?, last_error_code = ?,
               last_error_http_status = ?, last_error_summary = ?,
               retry_after_ms = ?, backoff_until_ms = ?,
               last_429_at_ms = COALESCE(?, last_429_at_ms),
               auth_dead_strikes = auth_dead_strikes + ?,
               claim_id = NULL, claim_until_ms = NULL, updated_at_ms = ?
           WHERE account_key = ?`,
        )
        .run(
          consecutiveFailures,
          failure.code,
          failure.httpStatus ?? null,
          failure.summary.slice(0, SUMMARY_LIMIT),
          failure.retryAfterMs ?? null,
          now + backoffMs,
          is429 ? now : null,
          failure.authDead ? 1 : 0,
          now,
          claim.accountKey,
        );
      recordEvent(this.db.handle, now, "usage_fetch_failed", claim.accountKey, {
        code: failure.code,
        httpStatus: failure.httpStatus ?? null,
        authDead: failure.authDead,
      });
      if (failure.authDead && row.authDeadStrikes + 1 >= QUARANTINE_DEAD_STRIKES) {
        recordEvent(this.db.handle, now, "usage_account_quarantined", claim.accountKey);
      }
      return true;
    });
  }

  /** Releases a claim without recording a result (local pre-fetch errors). */
  releaseClaim(claim: FetchClaim): void {
    const now = this.clock();
    this.db.immediate(() => {
      if (!this.fence(claim, now)) return;
      this.db.handle
        .prepare(
          `UPDATE usage_state
           SET claim_id = NULL, claim_until_ms = NULL, updated_at_ms = ?
           WHERE account_key = ?`,
        )
        .run(now, claim.accountKey);
    });
  }

  read(accountKey: string): UsageStateRow | null {
    return this.readRow(accountKey);
  }

  readAll(): Map<string, UsageStateRow> {
    const rows = this.db.handle
      .prepare(`SELECT * FROM usage_state`)
      .all() as Array<Record<string, unknown>>;
    return new Map(rows.map((raw) => {
      const row = mapRow(raw);
      return [row.accountKey, row];
    }));
  }

  private fence(claim: FetchClaim, now: number): boolean {
    const row = this.readRow(claim.accountKey);
    if (
      row === null ||
      row.claimId !== claim.claimId ||
      row.claimGeneration !== claim.generation
    ) {
      recordEvent(
        this.db.handle,
        now,
        "usage_result_fenced_out",
        row === null ? null : claim.accountKey,
      );
      return false;
    }
    return true;
  }

  private readRow(accountKey: string): UsageStateRow | null {
    const raw = this.db.handle
      .prepare(`SELECT * FROM usage_state WHERE account_key = ?`)
      .get(accountKey) as Record<string, unknown> | undefined;
    return raw === undefined ? null : mapRow(raw);
  }
}

function mapRow(raw: Record<string, unknown>): UsageStateRow {
  return {
    accountKey: raw["account_key"] as string,
    lastGoodJson: raw["last_good_json"] as string | null,
    fetchedAtMs: raw["fetched_at_ms"] as number | null,
    lastAttemptAtMs: raw["last_attempt_at_ms"] as number | null,
    consecutiveFailures: raw["consecutive_failures"] as number,
    lastErrorCode: raw["last_error_code"] as string | null,
    lastErrorHttpStatus: raw["last_error_http_status"] as number | null,
    lastErrorSummary: raw["last_error_summary"] as string | null,
    retryAfterMs: raw["retry_after_ms"] as number | null,
    backoffUntilMs: raw["backoff_until_ms"] as number | null,
    nextPollAtMs: raw["next_poll_at_ms"] as number | null,
    pollIntervalMs: raw["poll_interval_ms"] as number | null,
    last429AtMs: raw["last_429_at_ms"] as number | null,
    authDeadStrikes: raw["auth_dead_strikes"] as number,
    claimId: raw["claim_id"] as string | null,
    claimUntilMs: raw["claim_until_ms"] as number | null,
    claimGeneration: raw["claim_generation"] as number,
    probeKind: raw["probe_kind"] as string | null,
  };
}
