import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../util/clock.ts";

/**
 * Additive migration contract per handoff §11. Version 1 is the initial
 * schema; after first release, changes append new versions rather than
 * rewriting old ones.
 */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE accounts (
    account_key TEXT PRIMARY KEY,
    record_id TEXT,
    provider_account_id TEXT,
    email TEXT,
    label TEXT,
    added_at_ms INTEGER,
    ndy_index INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    present INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1)),
    auth_status TEXT NOT NULL DEFAULT 'unknown',
    auth_invalidated_at_ms INTEGER,
    credential_lineage_hmac TEXT,
    first_seen_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX accounts_record_id_unique
    ON accounts(record_id) WHERE record_id IS NOT NULL;

CREATE INDEX accounts_provider_account_id_idx
    ON accounts(provider_account_id);

CREATE TABLE account_policy (
    account_key TEXT PRIMARY KEY REFERENCES accounts(account_key) ON DELETE CASCADE,
    manually_disabled INTEGER NOT NULL DEFAULT 0 CHECK (manually_disabled IN (0, 1)),
    priority INTEGER NOT NULL DEFAULT 0,
    weight REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0),
    max_concurrent INTEGER,
    cooldown_until_ms INTEGER,
    note TEXT,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE usage_state (
    account_key TEXT PRIMARY KEY REFERENCES accounts(account_key) ON DELETE CASCADE,
    last_good_json TEXT,
    fetched_at_ms INTEGER,
    last_attempt_at_ms INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_error_http_status INTEGER,
    last_error_summary TEXT,
    retry_after_ms INTEGER,
    backoff_until_ms INTEGER,
    next_poll_at_ms INTEGER,
    poll_interval_ms INTEGER,
    last_429_at_ms INTEGER,
    auth_dead_strikes INTEGER NOT NULL DEFAULT 0,
    claim_id TEXT,
    claim_until_ms INTEGER,
    claim_generation INTEGER NOT NULL DEFAULT 0,
    probe_kind TEXT,
    updated_at_ms INTEGER NOT NULL,
    CHECK (last_good_json IS NULL OR json_valid(last_good_json))
);

CREATE INDEX usage_due_idx
    ON usage_state(next_poll_at_ms, backoff_until_ms, claim_until_ms);

CREATE TABLE selection_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL DEFAULT 0,
    last_selected_account_key TEXT REFERENCES accounts(account_key),
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE invocation_leases (
    lease_id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL REFERENCES accounts(account_key),
    owner_pid INTEGER,
    owner_nonce TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'codex-session',
    cwd TEXT,
    acquired_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER,
    status TEXT NOT NULL CHECK (
        status IN ('reserved', 'running', 'released', 'expired', 'failed')
    ),
    selector_reason_json TEXT,
    child_exit_code INTEGER,
    CHECK (selector_reason_json IS NULL OR json_valid(selector_reason_json))
);

CREATE INDEX invocation_active_by_account_idx
    ON invocation_leases(account_key, status, expires_at_ms);

CREATE TABLE events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at_ms INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    account_key TEXT REFERENCES accounts(account_key),
    payload_json TEXT,
    CHECK (payload_json IS NULL OR json_valid(payload_json))
);

CREATE INDEX events_time_idx ON events(occurred_at_ms DESC);
`,
  },
  {
    version: 2,
    sql: `
-- Live app-server registrations (handoff §39). Liveness is derived from the
-- owning resident lease rather than a second heartbeat: one process, one
-- expiry story. The socket URL is the identity — two servers may share an
-- account, but never a socket.
CREATE TABLE app_servers (
    listen_url TEXT PRIMARY KEY,
    account_key TEXT NOT NULL REFERENCES accounts(account_key),
    lease_id TEXT NOT NULL REFERENCES invocation_leases(lease_id),
    upstream_listen_url TEXT,
    owner_pid INTEGER,
    started_at_ms INTEGER NOT NULL,
    stopped_at_ms INTEGER
);

CREATE INDEX app_servers_account_idx
    ON app_servers(account_key, stopped_at_ms);

-- Cached answer to "can the resolved ndy host a canonical-home app-server?".
-- Keyed by the wrapper's identity so a dependency change re-probes, because
-- the answer is a property of that build, not of this machine.
CREATE TABLE ndy_capability (
    package_root TEXT PRIMARY KEY,
    ndy_version TEXT NOT NULL,
    wrapper_size INTEGER NOT NULL,
    wrapper_mtime_ms INTEGER NOT NULL,
    canonical_app_server INTEGER NOT NULL CHECK (canonical_app_server IN (0, 1)),
    detail TEXT,
    checked_at_ms INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    sql: `
-- An exclusive app-server belongs to exactly one session: 'run --server'
-- starts it for the launch it fronts and tears it down with it. Attachment
-- composition must never hand its socket to an unrelated launch, so
-- liveForAccount skips exclusive rows; discovery consumers (app-server list)
-- still see them.
ALTER TABLE app_servers ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0
    CHECK (exclusive IN (0, 1));
`,
  },
  {
    version: 4,
    sql: `
-- App-server sidecars were removed from codex-swap. Existing live resident
-- leases must not continue to influence selection after upgrade, and the
-- registry/capability tables are no longer part of the active schema.
UPDATE invocation_leases
   SET status = 'expired'
 WHERE purpose = 'app-server'
   AND status IN ('reserved', 'running');

DROP TABLE IF EXISTS app_servers;
DROP TABLE IF EXISTS ndy_capability;
`,
  },
  {
    version: 5,
    sql: `
-- Version 5 was a one-time data migration. Existing databases may already
-- record it as applied, so the version remains reserved as an inert step.
SELECT 1;
`,
  },
];

export function appliedSchemaVersion(db: DatabaseSync): number {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
);
`);
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

export function applyMigrations(db: DatabaseSync, clock: Clock): void {
  // Acquire the writer lock before reading the version. Concurrent first-opens
  // can otherwise all observe version 0, serialize only afterward, and replay
  // the same CREATE TABLE migration against the winner's completed schema.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = appliedSchemaVersion(db);
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)",
      ).run(migration.version, clock());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
