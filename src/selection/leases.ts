import { randomUUID } from "node:crypto";
import type { LeaseSettings } from "../config/schema.ts";
import type { Database } from "../storage/database.ts";
import { recordEvent } from "../storage/events.ts";
import type { Clock } from "../util/clock.ts";

/**
 * Invocation leases (handoff §21): a running Codex session holds a
 * heartbeated lease so concurrent harnesses balance instead of stampeding
 * one account. Leases influence selection scoring only — they never carry
 * credentials. A crashed owner's lease expires by wall clock.
 */
export type LeaseStatus = "reserved" | "running" | "released" | "expired" | "failed";

/** The lease purpose an interactive `run`/`resume` launch holds. */
export const CODEX_SESSION_LEASE_PURPOSE = "codex-session";

export interface InvocationLease {
  leaseId: string;
  accountKey: string;
  ownerPid: number | null;
  ownerNonce: string;
  purpose: string;
  cwd: string | null;
  status: LeaseStatus;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
  releasedAtMs: number | null;
  childExitCode: number | null;
  selectorReason: unknown;
}

export class InvocationLeaseStore {
  private readonly db: Database;
  private readonly settings: LeaseSettings;
  private readonly clock: Clock;

  constructor(db: Database, settings: LeaseSettings, clock: Clock) {
    this.db = db;
    this.settings = settings;
    this.clock = clock;
  }

  /**
   * Marks overdue reserved/running leases expired. Callers run this inside
   * the same immediate transaction as a selection so counts are honest.
   */
  expireStaleLocked(): number {
    const now = this.clock();
    const stale = this.db.handle
      .prepare(
        `SELECT lease_id FROM invocation_leases
         WHERE status IN ('reserved', 'running') AND expires_at_ms <= ?`,
      )
      .all(now) as Array<{ lease_id: string }>;
    if (stale.length === 0) return 0;
    const mark = this.db.handle.prepare(
      `UPDATE invocation_leases SET status = 'expired' WHERE lease_id = ?`,
    );
    for (const row of stale) {
      mark.run(row.lease_id);
      recordEvent(this.db.handle, now, "invocation_lease_expired", null, {
        leaseId: row.lease_id,
      });
    }
    return stale.length;
  }

  /**
   * Live lease counts per account — the ones that mean "somebody is burning
   * this account's quota right now", so they drive the concurrency penalty
   * and `maxConcurrent`.
   */
  activeCountsLocked(): Map<string, number> {
    const now = this.clock();
    const rows = this.db.handle
      .prepare(
        `SELECT account_key, COUNT(*) AS n FROM invocation_leases
         WHERE status IN ('reserved', 'running') AND expires_at_ms > ?
         GROUP BY account_key`,
      )
      .all(now) as Array<{ account_key: string; n: number }>;
    return new Map(rows.map((row) => [row.account_key, row.n]));
  }

  /** Inserts a reserved lease. Must run inside the selection transaction. */
  reserveLocked(options: {
    accountKey: string;
    purpose: string;
    cwd?: string | undefined;
    selectorReason?: unknown;
  }): InvocationLease {
    const now = this.clock();
    const lease: InvocationLease = {
      leaseId: randomUUID(),
      accountKey: options.accountKey,
      ownerPid: process.pid,
      ownerNonce: randomUUID(),
      purpose: options.purpose,
      cwd: options.cwd ?? null,
      status: "reserved",
      acquiredAtMs: now,
      heartbeatAtMs: now,
      expiresAtMs: now + this.settings.reservationTtlMs,
      releasedAtMs: null,
      childExitCode: null,
      selectorReason: options.selectorReason ?? null,
    };
    this.db.handle
      .prepare(
        `INSERT INTO invocation_leases (
           lease_id, account_key, owner_pid, owner_nonce, purpose, cwd,
           acquired_at_ms, heartbeat_at_ms, expires_at_ms, status,
           selector_reason_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
      )
      .run(
        lease.leaseId,
        lease.accountKey,
        lease.ownerPid,
        lease.ownerNonce,
        lease.purpose,
        lease.cwd,
        lease.acquiredAtMs,
        lease.heartbeatAtMs,
        lease.expiresAtMs,
        lease.selectorReason === null ? null : JSON.stringify(lease.selectorReason),
      );
    recordEvent(this.db.handle, now, "invocation_lease_acquired", options.accountKey, {
      leaseId: lease.leaseId,
      purpose: options.purpose,
    });
    return lease;
  }

  /** reserved → running once the child process has actually spawned. */
  markRunning(leaseId: string, ownerNonce: string): boolean {
    const now = this.clock();
    return this.db.immediate(() => {
      const changed = this.db.handle
        .prepare(
          `UPDATE invocation_leases
           SET status = 'running', owner_pid = ?, heartbeat_at_ms = ?, expires_at_ms = ?
           WHERE lease_id = ? AND owner_nonce = ? AND status = 'reserved'
             AND expires_at_ms > ?`,
        )
        .run(process.pid, now, now + this.settings.runningExpiryMs, leaseId, ownerNonce, now);
      if (changed.changes === 1) {
        recordEvent(this.db.handle, now, "invocation_started", null, { leaseId });
        return true;
      }
      return false;
    });
  }

  heartbeat(leaseId: string, ownerNonce: string): boolean {
    const now = this.clock();
    return this.db.immediate(() => {
      const changed = this.db.handle
        .prepare(
          `UPDATE invocation_leases
           SET heartbeat_at_ms = ?, expires_at_ms = ?
           WHERE lease_id = ? AND owner_nonce = ? AND status = 'running'`,
        )
        .run(now, now + this.settings.runningExpiryMs, leaseId, ownerNonce);
      return changed.changes === 1;
    });
  }

  release(
    leaseId: string,
    ownerNonce: string,
    outcome: { status: "released" | "failed"; childExitCode?: number },
  ): boolean {
    const now = this.clock();
    return this.db.immediate(() => {
      const changed = this.db.handle
        .prepare(
          `UPDATE invocation_leases
           SET status = ?, released_at_ms = ?, child_exit_code = ?
           WHERE lease_id = ? AND owner_nonce = ? AND status IN ('reserved', 'running')`,
        )
        .run(
          outcome.status,
          now,
          outcome.childExitCode ?? null,
          leaseId,
          ownerNonce,
        );
      if (changed.changes === 1) {
        recordEvent(this.db.handle, now, "invocation_finished", null, {
          leaseId,
          status: outcome.status,
          childExitCode: outcome.childExitCode ?? null,
        });
        return true;
      }
      return false;
    });
  }

  get(leaseId: string): InvocationLease | null {
    const raw = this.db.handle
      .prepare(`SELECT * FROM invocation_leases WHERE lease_id = ?`)
      .get(leaseId) as Record<string, unknown> | undefined;
    return raw === undefined ? null : mapLease(raw);
  }

  list(options?: { includeFinished?: boolean; limit?: number }): InvocationLease[] {
    const limit = options?.limit ?? 100;
    const rows =
      options?.includeFinished === true
        ? (this.db.handle
            .prepare(
              `SELECT * FROM invocation_leases ORDER BY acquired_at_ms DESC LIMIT ?`,
            )
            .all(limit) as Array<Record<string, unknown>>)
        : (this.db.handle
            .prepare(
              `SELECT * FROM invocation_leases
               WHERE status IN ('reserved', 'running')
               ORDER BY acquired_at_ms DESC LIMIT ?`,
            )
            .all(limit) as Array<Record<string, unknown>>);
    return rows.map(mapLease);
  }

  /** Prunes finished leases older than the audit window (handoff §11). */
  pruneFinished(auditWindowMs: number): number {
    const cutoff = this.clock() - auditWindowMs;
    const result = this.db.handle
      .prepare(
        `DELETE FROM invocation_leases
         WHERE status IN ('released', 'expired', 'failed')
           AND COALESCE(released_at_ms, expires_at_ms) < ?`,
      )
      .run(cutoff);
    return Number(result.changes);
  }
}

function mapLease(raw: Record<string, unknown>): InvocationLease {
  let selectorReason: unknown = null;
  const reasonJson = raw["selector_reason_json"] as string | null;
  if (reasonJson !== null) {
    try {
      selectorReason = JSON.parse(reasonJson);
    } catch {
      selectorReason = null;
    }
  }
  return {
    leaseId: raw["lease_id"] as string,
    accountKey: raw["account_key"] as string,
    ownerPid: raw["owner_pid"] as number | null,
    ownerNonce: raw["owner_nonce"] as string,
    purpose: raw["purpose"] as string,
    cwd: raw["cwd"] as string | null,
    status: raw["status"] as LeaseStatus,
    acquiredAtMs: raw["acquired_at_ms"] as number,
    heartbeatAtMs: raw["heartbeat_at_ms"] as number,
    expiresAtMs: raw["expires_at_ms"] as number,
    releasedAtMs: raw["released_at_ms"] as number | null,
    childExitCode: raw["child_exit_code"] as number | null,
    selectorReason,
  };
}
