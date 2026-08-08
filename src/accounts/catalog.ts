import type { Database } from "../storage/database.ts";
import { recordEvent } from "../storage/events.ts";
import type { Clock } from "../util/clock.ts";
import { normalizeEmail } from "./identity.ts";
import type { RedactedNdyAccount } from "./redaction.ts";

/**
 * The persistent account catalog (handoff §12): reconciles ndy's store into
 * stable account_key rows, preserves history for absent accounts, detects
 * credential-lineage changes (which release quarantine), and derives
 * identity-conflict sentinels. Never stores tokens — only the keyed lineage
 * fingerprint that arrives pre-computed on the redacted view.
 */
export type AuthStatus = "ready" | "no_credentials" | "relogin_required";

export interface CatalogRow {
  accountKey: string;
  recordId: string | null;
  providerAccountId: string | null;
  email: string | null;
  label: string | null;
  addedAtMs: number | null;
  ndyIndex: number | null;
  enabled: boolean;
  present: boolean;
  authStatus: AuthStatus | "unknown";
  authInvalidatedAtMs: number | null;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

export interface ReconcileResult {
  presentKeys: string[];
  addedKeys: string[];
  removedKeys: string[];
  lineageChangedKeys: string[];
}

export function deriveAuthStatus(account: {
  hasCredentials: boolean;
  authInvalidatedAt?: number | undefined;
}): AuthStatus {
  if (!account.hasCredentials) return "no_credentials";
  if (account.authInvalidatedAt !== undefined) return "relogin_required";
  return "ready";
}

/**
 * Accounts that cannot be pinned unambiguously: they share a normalized
 * email with another present account while lacking their own provider
 * account ID (handoff §12.9). Derived live — a sentinel, never persisted.
 */
export function identityConflictKeys(
  accounts: readonly {
    accountKey: string;
    email?: string | null | undefined;
    providerAccountId?: string | null | undefined;
  }[],
): Set<string> {
  const byEmail = new Map<string, string[]>();
  for (const account of accounts) {
    if (account.email == null || account.email.length === 0) continue;
    const email = normalizeEmail(account.email);
    byEmail.set(email, [...(byEmail.get(email) ?? []), account.accountKey]);
  }
  const conflicted = new Set<string>();
  for (const account of accounts) {
    if (account.email == null || account.email.length === 0) continue;
    const sharing = byEmail.get(normalizeEmail(account.email)) ?? [];
    const hasProviderId =
      account.providerAccountId != null && account.providerAccountId.length > 0;
    if (sharing.length > 1 && !hasProviderId) {
      conflicted.add(account.accountKey);
    }
  }
  return conflicted;
}

export class AccountCatalog {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  reconcile(accounts: readonly RedactedNdyAccount[]): ReconcileResult {
    const now = this.clock();
    return this.db.immediate(() => {
      const handle = this.db.handle;
      const existingRows = handle
        .prepare(
          "SELECT account_key AS accountKey, present, credential_lineage_hmac AS lineageHmac FROM accounts",
        )
        .all() as Array<{
        accountKey: string;
        present: number;
        lineageHmac: string | null;
      }>;
      const existing = new Map(existingRows.map((r) => [r.accountKey, r]));

      const upsert = handle.prepare(`
INSERT INTO accounts (
  account_key, record_id, provider_account_id, email, label, added_at_ms,
  ndy_index, enabled, present, auth_status, auth_invalidated_at_ms,
  credential_lineage_hmac, first_seen_at_ms, last_seen_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_key) DO UPDATE SET
  record_id = excluded.record_id,
  provider_account_id = excluded.provider_account_id,
  email = excluded.email,
  label = excluded.label,
  added_at_ms = excluded.added_at_ms,
  ndy_index = excluded.ndy_index,
  enabled = excluded.enabled,
  present = 1,
  auth_status = excluded.auth_status,
  auth_invalidated_at_ms = excluded.auth_invalidated_at_ms,
  credential_lineage_hmac = excluded.credential_lineage_hmac,
  last_seen_at_ms = excluded.last_seen_at_ms,
  updated_at_ms = excluded.updated_at_ms
`);
      const ensureUsageRow = handle.prepare(
        "INSERT OR IGNORE INTO usage_state (account_key, updated_at_ms) VALUES (?, ?)",
      );
      const releaseQuarantine = handle.prepare(`
UPDATE usage_state SET
  auth_dead_strikes = 0,
  consecutive_failures = 0,
  backoff_until_ms = NULL,
  next_poll_at_ms = NULL,
  updated_at_ms = ?
WHERE account_key = ?
`);

      const addedKeys: string[] = [];
      const lineageChangedKeys: string[] = [];
      const presentKeys: string[] = [];

      for (const account of accounts) {
        presentKeys.push(account.accountKey);
        const previous = existing.get(account.accountKey);
        upsert.run(
          account.accountKey,
          account.recordId ?? null,
          account.providerAccountId ?? null,
          account.email ?? null,
          account.label ?? null,
          account.addedAt ?? null,
          account.ndyIndex,
          account.enabled ? 1 : 0,
          deriveAuthStatus(account),
          account.authInvalidatedAt ?? null,
          account.lineageHmac ?? null,
          now,
          now,
          now,
        );
        ensureUsageRow.run(account.accountKey, now);

        if (previous === undefined) {
          addedKeys.push(account.accountKey);
          recordEvent(handle, now, "account_added", account.accountKey);
        } else if (
          previous.lineageHmac !== null &&
          account.lineageHmac !== undefined &&
          previous.lineageHmac !== account.lineageHmac
        ) {
          lineageChangedKeys.push(account.accountKey);
          releaseQuarantine.run(now, account.accountKey);
          recordEvent(handle, now, "credential_lineage_changed", account.accountKey);
        }
      }

      const removedKeys: string[] = [];
      const presentSet = new Set(presentKeys);
      for (const row of existingRows) {
        if (row.present === 1 && !presentSet.has(row.accountKey)) {
          removedKeys.push(row.accountKey);
        }
      }
      if (removedKeys.length > 0) {
        const markAbsent = handle.prepare(
          "UPDATE accounts SET present = 0, updated_at_ms = ? WHERE account_key = ?",
        );
        for (const key of removedKeys) {
          markAbsent.run(now, key);
          recordEvent(handle, now, "account_absent", key);
        }
      }

      recordEvent(handle, now, "account_catalog_reconciled", null, {
        present: presentKeys.length,
        added: addedKeys.length,
        removed: removedKeys.length,
        lineageChanged: lineageChangedKeys.length,
      });

      return { presentKeys, addedKeys, removedKeys, lineageChangedKeys };
    });
  }

  listAll(): CatalogRow[] {
    const rows = this.db.handle
      .prepare(
        `SELECT account_key, record_id, provider_account_id, email, label,
                added_at_ms, ndy_index, enabled, present, auth_status,
                auth_invalidated_at_ms, first_seen_at_ms, last_seen_at_ms
         FROM accounts
         ORDER BY present DESC, ndy_index ASC, account_key ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      accountKey: row["account_key"] as string,
      recordId: row["record_id"] as string | null,
      providerAccountId: row["provider_account_id"] as string | null,
      email: row["email"] as string | null,
      label: row["label"] as string | null,
      addedAtMs: row["added_at_ms"] as number | null,
      ndyIndex: row["ndy_index"] as number | null,
      enabled: row["enabled"] === 1,
      present: row["present"] === 1,
      authStatus: row["auth_status"] as CatalogRow["authStatus"],
      authInvalidatedAtMs: row["auth_invalidated_at_ms"] as number | null,
      firstSeenAtMs: row["first_seen_at_ms"] as number,
      lastSeenAtMs: row["last_seen_at_ms"] as number,
    }));
  }
}
