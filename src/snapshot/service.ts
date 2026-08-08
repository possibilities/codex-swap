import {
  AccountCatalog,
  identityConflictKeys,
  type CatalogRow,
} from "../accounts/catalog.ts";
import { NdyStoreReader } from "../ndy/store-reader.ts";
import { resolveCodexHome } from "../ndy/environment.ts";
import {
  assertSupportedNdyVersion,
  resolveNdyInstallation,
  type NdyInstallation,
} from "../ndy/bin-resolver.ts";
import { Database } from "../storage/database.ts";
import {
  lineageHmac,
  loadOrCreateInstallSecret,
} from "../storage/install-secret.ts";
import { dataRoot, databasePath } from "../storage/paths.ts";
import { type Clock, systemClock, toIsoUtc } from "../util/clock.ts";
import type { UsageMeasurement } from "../usage/types.ts";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type AccountExclusionReason,
  type Snapshot,
  type SnapshotAccountView,
  type SnapshotUsageView,
} from "./types.ts";

/**
 * Assembles one coherent snapshot (handoff §19): reconcile the catalog,
 * derive sentinels, read stored usage, compute eligibility. The usage store
 * decides whether any network fetch happens — this service never fetches on
 * its own in milestone 2; the collector pass is wired in with the usage
 * store milestone.
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
  backoffUntilMs: number | null;
  nextPollAtMs: number | null;
  pollIntervalMs: number | null;
  last429AtMs: number | null;
  authDeadStrikes: number;
}

export interface PolicyRow {
  manuallyDisabled: boolean;
  priority: number;
  weight: number;
  maxConcurrent: number | null;
  cooldownUntilMs: number | null;
}

const DEFAULT_POLICY: PolicyRow = {
  manuallyDisabled: false,
  priority: 0,
  weight: 1,
  maxConcurrent: null,
  cooldownUntilMs: null,
};

export class SnapshotService {
  private readonly db: Database;
  private readonly catalog: AccountCatalog;
  private readonly reader: NdyStoreReader;
  private readonly installation: NdyInstallation;
  private readonly secret: Buffer;
  private readonly clock: Clock;

  constructor(options: {
    db: Database;
    reader: NdyStoreReader;
    installation: NdyInstallation;
    secret: Buffer;
    clock?: Clock;
  }) {
    this.db = options.db;
    this.reader = options.reader;
    this.installation = options.installation;
    this.secret = options.secret;
    this.clock = options.clock ?? systemClock;
    this.catalog = new AccountCatalog(this.db, this.clock);
  }

  static async open(
    env: NodeJS.ProcessEnv = process.env,
    clock: Clock = systemClock,
  ): Promise<SnapshotService> {
    const packageDir = env["CODEX_SWAP_NDY_PACKAGE_DIR"];
    const installation = resolveNdyInstallation(
      packageDir !== undefined && packageDir.length > 0 ? { packageDir } : {},
    );
    assertSupportedNdyVersion(installation);
    const root = dataRoot(env);
    return new SnapshotService({
      db: Database.open(databasePath(root), clock),
      reader: new NdyStoreReader(env),
      installation,
      secret: loadOrCreateInstallSecret(root),
      clock,
    });
  }

  get database(): Database {
    return this.db;
  }

  async reconcile(): Promise<CatalogRow[]> {
    const redacted = await this.reader.loadRedactedAccounts({
      lineage: (token) => lineageHmac(this.secret, token),
    });
    this.catalog.reconcile(redacted);
    return this.catalog.listAll();
  }

  async build(env: NodeJS.ProcessEnv = process.env): Promise<Snapshot> {
    const rows = await this.reconcile();
    const now = this.clock();
    const conflicts = identityConflictKeys(
      rows.filter((row) => row.present),
    );
    const usageStates = this.readUsageStates();
    const policies = this.readPolicies();

    const accounts = rows.map((row) =>
      buildAccountView(
        row,
        usageStates.get(row.accountKey),
        policies.get(row.accountKey) ?? DEFAULT_POLICY,
        conflicts.has(row.accountKey),
        now,
      ),
    );

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      dependency: {
        name: "codex-multi-auth",
        version: this.installation.version,
        healthy: true,
      },
      canonicalCodexHome: resolveCodexHome(env),
      recommendation: null,
      accounts,
    };
  }

  private readUsageStates(): Map<string, UsageStateRow> {
    const rows = this.db.handle
      .prepare(
        `SELECT account_key, last_good_json, fetched_at_ms, last_attempt_at_ms,
                consecutive_failures, last_error_code, last_error_http_status,
                last_error_summary, backoff_until_ms, next_poll_at_ms,
                poll_interval_ms, last_429_at_ms, auth_dead_strikes
         FROM usage_state`,
      )
      .all() as Array<Record<string, unknown>>;
    return new Map(
      rows.map((row) => {
        const state: UsageStateRow = {
          accountKey: row["account_key"] as string,
          lastGoodJson: row["last_good_json"] as string | null,
          fetchedAtMs: row["fetched_at_ms"] as number | null,
          lastAttemptAtMs: row["last_attempt_at_ms"] as number | null,
          consecutiveFailures: row["consecutive_failures"] as number,
          lastErrorCode: row["last_error_code"] as string | null,
          lastErrorHttpStatus: row["last_error_http_status"] as number | null,
          lastErrorSummary: row["last_error_summary"] as string | null,
          backoffUntilMs: row["backoff_until_ms"] as number | null,
          nextPollAtMs: row["next_poll_at_ms"] as number | null,
          pollIntervalMs: row["poll_interval_ms"] as number | null,
          last429AtMs: row["last_429_at_ms"] as number | null,
          authDeadStrikes: row["auth_dead_strikes"] as number,
        };
        return [state.accountKey, state];
      }),
    );
  }

  private readPolicies(): Map<string, PolicyRow> {
    const rows = this.db.handle
      .prepare(
        `SELECT account_key, manually_disabled, priority, weight,
                max_concurrent, cooldown_until_ms
         FROM account_policy`,
      )
      .all() as Array<Record<string, unknown>>;
    return new Map(
      rows.map((row) => [
        row["account_key"] as string,
        {
          manuallyDisabled: row["manually_disabled"] === 1,
          priority: row["priority"] as number,
          weight: row["weight"] as number,
          maxConcurrent: row["max_concurrent"] as number | null,
          cooldownUntilMs: row["cooldown_until_ms"] as number | null,
        },
      ]),
    );
  }

  close(): void {
    this.db.close();
  }
}

function buildAccountView(
  row: CatalogRow,
  usage: UsageStateRow | undefined,
  policy: PolicyRow,
  identityConflict: boolean,
  nowMs: number,
): SnapshotAccountView {
  const usageView = buildUsageView(usage, nowMs);
  const lastGood = buildLastGoodView(usage, nowMs);

  const exclusions: AccountExclusionReason[] = [];
  if (!row.present) exclusions.push("absent");
  if (!row.enabled) exclusions.push("ndy_disabled");
  if (policy.manuallyDisabled) exclusions.push("manually_disabled");
  if (row.authStatus === "no_credentials") exclusions.push("no_credentials");
  if (row.authStatus === "relogin_required") exclusions.push("relogin_required");
  if (identityConflict) exclusions.push("identity_conflict");
  if (
    policy.cooldownUntilMs !== null &&
    policy.cooldownUntilMs > nowMs
  ) {
    exclusions.push("cooldown_active");
  }
  if (!usageView.decisionGrade) exclusions.push("usage_unknown");

  return {
    accountKey: row.accountKey,
    providerAccountId: row.providerAccountId,
    email: row.email,
    label: row.label,
    enabled: row.enabled,
    present: row.present,
    ndyIndex: row.ndyIndex,
    auth: {
      status: row.authStatus,
      reloginRequired: row.authStatus === "relogin_required",
    },
    identityConflict,
    policy: {
      manuallyDisabled: policy.manuallyDisabled,
      priority: policy.priority,
      weight: policy.weight,
      maxConcurrent: policy.maxConcurrent,
    },
    usage: usageView,
    lastGoodUsage: lastGood,
    selection: {
      eligible: exclusions.length === 0,
      exclusions,
      headroomPercent: null,
      activeLeases: 0,
    },
  };
}

function parseMeasurement(json: string | null): UsageMeasurement | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as UsageMeasurement;
  } catch {
    return null;
  }
}

function buildUsageView(
  usage: UsageStateRow | undefined,
  nowMs: number,
): SnapshotUsageView {
  const empty: SnapshotUsageView = {
    status: "unknown",
    decisionGrade: false,
    measurement: null,
    fetchedAt: null,
    ageSeconds: null,
    nextPollAt: null,
    lastError: null,
  };
  if (usage === undefined) return empty;

  const view = { ...empty };
  if (usage.lastErrorCode !== null) {
    view.lastError = {
      code: usage.lastErrorCode,
      httpStatus: usage.lastErrorHttpStatus,
      summary: usage.lastErrorSummary,
      at: usage.lastAttemptAtMs !== null ? toIsoUtc(usage.lastAttemptAtMs) : null,
    };
    view.status = "error";
  }
  if (usage.backoffUntilMs !== null && usage.backoffUntilMs > nowMs) {
    view.status = "backoff";
  }
  if (usage.nextPollAtMs !== null) {
    view.nextPollAt = toIsoUtc(usage.nextPollAtMs);
  }

  const measurement = parseMeasurement(usage.lastGoodJson);
  if (measurement === null || usage.fetchedAtMs === null) {
    return view;
  }
  // Trust rules land with the usage-store milestone; until a collector has
  // stored measurements this path only shapes existing data.
  view.measurement = measurement;
  view.fetchedAt = toIsoUtc(usage.fetchedAtMs);
  view.ageSeconds = Math.max(0, Math.round((nowMs - usage.fetchedAtMs) / 1000));
  view.decisionGrade = true;
  if (view.status === "unknown") view.status = "ok";
  return view;
}

function buildLastGoodView(
  usage: UsageStateRow | undefined,
  nowMs: number,
): Snapshot["accounts"][number]["lastGoodUsage"] {
  if (usage === undefined || usage.fetchedAtMs === null) return null;
  const measurement = parseMeasurement(usage.lastGoodJson);
  if (measurement === null) return null;
  return {
    measurement,
    fetchedAt: toIsoUtc(usage.fetchedAtMs),
    ageSeconds: Math.max(0, Math.round((nowMs - usage.fetchedAtMs) / 1000)),
  };
}
