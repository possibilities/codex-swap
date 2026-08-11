import type { Database } from "../storage/database.ts";
import { recordEvent } from "../storage/events.ts";
import type { InvocationLeaseStore } from "../selection/leases.ts";
import type { Clock } from "../util/clock.ts";

/**
 * The app-server registry (handoff §39): which live, account-pinned
 * app-servers exist and where to reach them, so `run`/`resume` can compose
 * `--remote` without anything hardcoding a consumer's socket directory.
 *
 * A registration is live exactly as long as its resident lease is — one
 * process, one heartbeat, one expiry story. A crashed `app-server run` leaves
 * a row whose lease expires by wall clock, and the row reads dead from that
 * moment without anyone sweeping it.
 */
export interface AppServerRegistration {
  listenUrl: string;
  accountKey: string;
  leaseId: string;
  /** Where the ndy-wrapped server actually listens, behind the identity proxy. */
  upstreamListenUrl: string | null;
  ownerPid: number | null;
  /** True for a server that serves exactly one session and dies with it;
   * attachment composition never hands its socket to another launch. */
  exclusive: boolean;
  startedAtMs: number;
  stoppedAtMs: number | null;
}

export class AppServerRegistry {
  private readonly db: Database;
  private readonly leases: InvocationLeaseStore;
  private readonly clock: Clock;

  constructor(db: Database, leases: InvocationLeaseStore, clock: Clock) {
    this.db = db;
    this.leases = leases;
    this.clock = clock;
  }

  /**
   * Claims a socket for one resident server. Replaces a previous row for the
   * same socket only when that registration is no longer live, so a running
   * server is never silently displaced by a second one on its address.
   */
  register(options: {
    listenUrl: string;
    accountKey: string;
    leaseId: string;
    upstreamListenUrl?: string | undefined;
    exclusive?: boolean | undefined;
  }): AppServerRegistration {
    const now = this.clock();
    return this.db.immediate(() => {
      this.leases.expireStaleLocked();
      const existing = this.readLocked(options.listenUrl);
      if (existing !== null && this.isLiveLocked(existing)) {
        throw new AppServerSocketBusyError(options.listenUrl, existing);
      }
      this.db.handle
        .prepare(
          `INSERT INTO app_servers (
             listen_url, account_key, lease_id, upstream_listen_url,
             owner_pid, exclusive, started_at_ms, stopped_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(listen_url) DO UPDATE SET
             account_key = excluded.account_key,
             lease_id = excluded.lease_id,
             upstream_listen_url = excluded.upstream_listen_url,
             owner_pid = excluded.owner_pid,
             exclusive = excluded.exclusive,
             started_at_ms = excluded.started_at_ms,
             stopped_at_ms = NULL`,
        )
        .run(
          options.listenUrl,
          options.accountKey,
          options.leaseId,
          options.upstreamListenUrl ?? null,
          process.pid,
          options.exclusive === true ? 1 : 0,
          now,
        );
      recordEvent(this.db.handle, now, "app_server_registered", options.accountKey, {
        listenUrl: options.listenUrl,
        leaseId: options.leaseId,
        exclusive: options.exclusive === true,
      });
      return {
        listenUrl: options.listenUrl,
        accountKey: options.accountKey,
        leaseId: options.leaseId,
        upstreamListenUrl: options.upstreamListenUrl ?? null,
        ownerPid: process.pid,
        exclusive: options.exclusive === true,
        startedAtMs: now,
        stoppedAtMs: null,
      };
    });
  }

  /** Marks a registration stopped on clean shutdown. */
  deregister(listenUrl: string, leaseId: string): void {
    const now = this.clock();
    this.db.immediate(() => {
      const changed = this.db.handle
        .prepare(
          `UPDATE app_servers SET stopped_at_ms = ?
           WHERE listen_url = ? AND lease_id = ? AND stopped_at_ms IS NULL`,
        )
        .run(now, listenUrl, leaseId);
      if (changed.changes === 1) {
        recordEvent(this.db.handle, now, "app_server_deregistered", null, {
          listenUrl,
          leaseId,
        });
      }
    });
  }

  /** Every live registration, newest first. */
  listLive(): AppServerRegistration[] {
    return this.db.immediate(() => {
      this.leases.expireStaleLocked();
      return this.listAllLocked()
        .filter((row) => this.isLiveLocked(row))
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
    });
  }

  /**
   * The live shared server for one account, if any. Exclusive servers are
   * skipped: each belongs to the one session it fronts, and handing its
   * socket to an unrelated launch would put a stranger's thread on it.
   * Deterministic when an account somehow has two shared servers: the most
   * recently started wins, so a replacement started after a crash is
   * preferred over the row the crash left behind.
   */
  liveForAccount(accountKey: string): AppServerRegistration | null {
    return (
      this.listLive().find(
        (row) => row.accountKey === accountKey && !row.exclusive,
      ) ?? null
    );
  }

  /** Drops rows for servers that finished longer ago than the audit window. */
  pruneStopped(auditWindowMs: number): number {
    const cutoff = this.clock() - auditWindowMs;
    const result = this.db.handle
      .prepare(
        `DELETE FROM app_servers
         WHERE stopped_at_ms IS NOT NULL AND stopped_at_ms < ?`,
      )
      .run(cutoff);
    return Number(result.changes);
  }

  private isLiveLocked(row: AppServerRegistration): boolean {
    if (row.stoppedAtMs !== null) return false;
    const lease = this.leases.get(row.leaseId);
    if (lease === null) return false;
    return (
      (lease.status === "running" || lease.status === "reserved") &&
      lease.expiresAtMs > this.clock()
    );
  }

  private readLocked(listenUrl: string): AppServerRegistration | null {
    const raw = this.db.handle
      .prepare(`SELECT * FROM app_servers WHERE listen_url = ?`)
      .get(listenUrl) as Record<string, unknown> | undefined;
    return raw === undefined ? null : mapRow(raw);
  }

  private listAllLocked(): AppServerRegistration[] {
    const rows = this.db.handle
      .prepare(`SELECT * FROM app_servers`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }
}

/** Raised when a socket already carries a live registration. */
export class AppServerSocketBusyError extends Error {
  readonly existing: AppServerRegistration;

  constructor(listenUrl: string, existing: AppServerRegistration) {
    super(
      `${listenUrl} already has a live app-server for ${existing.accountKey}` +
        ` (lease ${existing.leaseId}, pid ${existing.ownerPid ?? "unknown"})`,
    );
    this.existing = existing;
  }
}

function mapRow(raw: Record<string, unknown>): AppServerRegistration {
  return {
    listenUrl: raw["listen_url"] as string,
    accountKey: raw["account_key"] as string,
    leaseId: raw["lease_id"] as string,
    upstreamListenUrl: raw["upstream_listen_url"] as string | null,
    ownerPid: raw["owner_pid"] as number | null,
    exclusive: raw["exclusive"] === 1,
    startedAtMs: raw["started_at_ms"] as number,
    stoppedAtMs: raw["stopped_at_ms"] as number | null,
  };
}
