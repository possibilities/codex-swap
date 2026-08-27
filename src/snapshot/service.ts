import {
  AccountCatalog,
  identityConflictKeys,
  type CatalogRow,
} from "../accounts/catalog.ts";
import { CredentialBroker } from "../accounts/credential-broker.ts";
import { loadSettings } from "../config/load.ts";
import type { Settings } from "../config/schema.ts";
import {
  assertSupportedNdyVersion,
  resolveNdyInstallation,
  type NdyInstallation,
} from "../ndy/bin-resolver.ts";
import { resolveCodexHome } from "../ndy/environment.ts";
import { NdyStoreReader } from "../ndy/store-reader.ts";
import { Database } from "../storage/database.ts";
import {
  lineageHmac,
  loadOrCreateInstallSecret,
} from "../storage/install-secret.ts";
import { dataRoot, databasePath } from "../storage/paths.ts";
import { InvocationLeaseStore, type InvocationLease } from "../selection/leases.ts";
import {
  selectAccount,
  type FamilyBlock,
  type SelectionResult,
  type SelectionStrategy,
} from "../selection/selector.ts";
import { type Clock, systemClock, toIsoUtc } from "../util/clock.ts";
import { UsageCollector, adaptivePlanner, type PollPlanner } from "../usage/collector.ts";
import { selectFetchSet } from "../usage/scheduler.ts";
import {
  DEFAULT_USAGE_BASE_URL,
  DirectUsageProbe,
} from "../usage/direct-usage-probe.ts";
import type { UsageProbe } from "../usage/probe.ts";
import { UsageStore, type UsageStateRow } from "../usage/store.ts";
import { evaluateTrust } from "../usage/trust.ts";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type AccountExclusionReason,
  type Snapshot,
  type SnapshotAccountView,
  type SnapshotLastGoodView,
  type SnapshotUsageView,
} from "./types.ts";

/**
 * Assembles one coherent snapshot (handoff §19): reconcile the catalog,
 * run the store-governed collector over eligible due accounts, then read
 * everything and compute trust and eligibility. Repeated calls are safe —
 * the usage store decides whether any network request happens.
 */
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

/** Bounded operator-initiated broader refresh (handoff §18.1). */
const OPERATOR_REFRESH_BUDGET = 10;

export class SnapshotService {
  readonly settings: Settings;
  private readonly db: Database;
  private readonly catalog: AccountCatalog;
  private readonly reader: NdyStoreReader;
  private readonly installation: NdyInstallation;
  private readonly secret: Buffer;
  private readonly clock: Clock;
  private readonly usageStore: UsageStore;
  private readonly collector: UsageCollector;
  private readonly broker: CredentialBroker;
  readonly leases: InvocationLeaseStore;

  /** Derived non-secret identity claim for one account (broker-mediated). */
  async identityClaimId(accountKey: string): Promise<string | null> {
    return this.broker.identityClaimId(accountKey);
  }

  constructor(options: {
    db: Database;
    reader: NdyStoreReader;
    installation: NdyInstallation;
    secret: Buffer;
    settings: Settings;
    clock?: Clock;
    probe?: UsageProbe;
    broker?: CredentialBroker;
    planner?: PollPlanner;
  }) {
    this.db = options.db;
    this.reader = options.reader;
    this.installation = options.installation;
    this.secret = options.secret;
    this.settings = options.settings;
    this.clock = options.clock ?? systemClock;
    this.catalog = new AccountCatalog(this.db, this.clock);
    this.leases = new InvocationLeaseStore(
      this.db,
      this.settings.leases,
      this.clock,
    );
    this.usageStore = new UsageStore({
      db: this.db,
      settings: this.settings.usage,
      clock: this.clock,
    });
    this.broker =
      options.broker ??
      new CredentialBroker({
        lineage: (token) => lineageHmac(this.secret, token),
        clock: this.clock,
      });
    const probe = options.probe ?? new DirectUsageProbe({ clock: this.clock });
    this.collector = new UsageCollector({
      store: this.usageStore,
      broker: this.broker,
      probe,
      planner:
        options.planner ??
        adaptivePlanner(this.settings.usage, (accountKey) =>
          accountKey === this.activeAccountKey() ? "active" : "candidate",
        ),
      clock: this.clock,
    });
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
    const { settings } = loadSettings(root);
    const secret = loadOrCreateInstallSecret(root);

    const unsafeBaseUrl = env["CODEX_SWAP_UNSAFE_USAGE_BASE_URL"];
    let probe: UsageProbe | undefined;
    if (unsafeBaseUrl !== undefined && unsafeBaseUrl.length > 0) {
      process.stderr.write(
        `codex-swap: CODEX_SWAP_UNSAFE_USAGE_BASE_URL overrides the usage endpoint (${unsafeBaseUrl}); development only\n`,
      );
      probe = new DirectUsageProbe({ baseUrl: unsafeBaseUrl, clock });
    } else {
      probe = new DirectUsageProbe({ baseUrl: DEFAULT_USAGE_BASE_URL, clock });
    }

    return new SnapshotService({
      db: Database.open(databasePath(root), clock),
      reader: new NdyStoreReader(env),
      installation,
      secret,
      settings,
      clock,
      probe,
      broker: new CredentialBroker({
        lineage: (token) => lineageHmac(secret, token),
        env,
        clock,
      }),
    });
  }

  get database(): Database {
    return this.db;
  }

  get store(): UsageStore {
    return this.usageStore;
  }

  /** The service's clock, so collaborators share one notion of now. */
  get now(): Clock {
    return this.clock;
  }

  async reconcile(): Promise<CatalogRow[]> {
    const redacted = await this.reader.loadRedactedAccounts({
      lineage: (token) => lineageHmac(this.secret, token),
    });
    this.catalog.reconcile(redacted);
    return this.catalog.listAll();
  }

  /** The most recently selected account (selection_state), or null. */
  activeAccountKey(): string | null {
    const row = this.db.handle
      .prepare(
        "SELECT last_selected_account_key AS k FROM selection_state WHERE id = 1",
      )
      .get() as { k: string | null } | undefined;
    return row?.k ?? null;
  }

  /**
   * Store-governed collection pass: reserve/fetch/record for each selected
   * account. A normal scheduler pass respects the traffic invariant (the
   * active account plus at most one due alternate, §18.1); an operator
   * refresh (`force`) may go broader but stays bounded and still honors
   * claims, backoff, and quarantine inside the store.
   */
  async collectUsage(options?: {
    rows?: CatalogRow[];
    only?: readonly string[];
    force?: boolean;
  }): Promise<void> {
    const rows = options?.rows ?? this.catalog.listAll();
    const conflicts = identityConflictKeys(rows.filter((r) => r.present));
    const fetchable = rows
      .filter(
        (row) =>
          row.present &&
          row.authStatus === "ready" &&
          !conflicts.has(row.accountKey),
      )
      .map((row) => row.accountKey);

    let keys: string[];
    if (options?.only !== undefined) {
      const allow = new Set(options.only);
      keys = fetchable.filter((key) => allow.has(key));
    } else if (options?.force === true) {
      keys = fetchable.slice(0, OPERATOR_REFRESH_BUDGET);
    } else {
      const usageStates = this.usageStore.readAll();
      keys = selectFetchSet(
        fetchable.map((accountKey) => ({
          accountKey,
          usage: usageStates.get(accountKey),
        })),
        this.activeAccountKey(),
        this.settings.usage,
        this.clock(),
      );
    }
    await this.collector.collect(keys, {
      ...(options?.force !== undefined ? { force: options.force } : {}),
    });
  }

  async build(
    env: NodeJS.ProcessEnv = process.env,
    options?: { fetchUsage?: boolean },
  ): Promise<Snapshot> {
    const rows = await this.reconcile();
    if (options?.fetchUsage !== false) {
      await this.collectUsage({ rows });
    }
    const { accounts, sequence, lastSelected } = this.db.immediate(() => {
      this.leases.expireStaleLocked();
      return {
        accounts: this.assembleViewsLocked(this.catalog.listAll()),
        sequence: this.selectionSequenceLocked(),
        lastSelected: this.activeAccountKey(),
      };
    });

    const readOnlySelection = selectAccount({
      accounts: accounts.filter((a) => a.present),
      strategy: this.settings.selection.strategy,
      settings: this.settings.selection,
      allowUnknown: this.settings.selection.allowUnknown,
      lastSelectedAccountKey: lastSelected,
      sequence,
    });

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      dependency: {
        name: "codex-multi-auth",
        version: this.installation.version,
        healthy: true,
      },
      canonicalCodexHome: resolveCodexHome(env),
      recommendation:
        readOnlySelection.kind === "selected"
          ? {
              accountKey: readOnlySelection.accountKey,
              providerAccountId: readOnlySelection.providerAccountId,
              strategy: readOnlySelection.reason.strategy,
              reason: readOnlySelection.reason.summary,
              headroomPercent: readOnlySelection.reason.headroomPercent,
              activeLeases: readOnlySelection.reason.activeLeases,
            }
          : null,
      accounts,
    };
  }

  /**
   * Assembles account views from current DB state. Must run inside an
   * immediate transaction so lease counts and usage rows are one coherent
   * read (build, selectReadOnly, and selectAndClaim all share this).
   */
  private assembleViewsLocked(rows: CatalogRow[]): SnapshotAccountView[] {
    const now = this.clock();
    const conflicts = identityConflictKeys(rows.filter((row) => row.present));
    const usageStates = this.usageStore.readAll();
    const policies = this.readPolicies();
    const leaseCounts = this.leases.activeCountsLocked();
    return rows.map((row) =>
      this.buildAccountView(
        row,
        usageStates.get(row.accountKey),
        policies.get(row.accountKey) ?? DEFAULT_POLICY,
        conflicts.has(row.accountKey),
        leaseCounts.get(row.accountKey) ?? 0,
        now,
      ),
    );
  }

  private selectionSequenceLocked(): number {
    const row = this.db.handle
      .prepare("SELECT sequence FROM selection_state WHERE id = 1")
      .get() as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  /**
   * Atomic selection + invocation claim (handoff §21.1): expire stale
   * leases, read one coherent state, select, insert a reserved lease, and
   * advance rotation state — all in one immediate transaction. Callers
   * freshen usage (collectUsage) before invoking.
   */
  selectAndClaim(options: {
    strategy: SelectionStrategy;
    allowUnknown: boolean;
    purpose: string;
    cwd?: string | undefined;
    /** Skip selection: claim this specific account (explicit targeting). */
    forcedAccountKey?: string;
    /** Restrict normal eligibility/scoring to this account (balanced pinning). */
    requiredAccountKey?: string;
    /**
     * Harness capability gate: accounts outside `keys` are excluded with
     * `reason` (e.g. pi_profile_missing — quota alone cannot make an
     * account launchable by a harness it was never linked to).
     */
    restrict?: { keys: ReadonlySet<string>; reason: AccountExclusionReason };
    /**
     * Active family rate-limit records for the launch's model family,
     * excluding their accounts with `family_rate_limited`. Never applied to
     * a forced account — explicit targeting is gated by its own caller.
     */
    familyBlocks?: ReadonlyMap<string, FamilyBlock> | null;
  }): { result: SelectionResult; lease: InvocationLease | null } {
    return this.db.immediate(() => {
      this.leases.expireStaleLocked();
      const rows = this.catalog.listAll();
      let views = this.assembleViewsLocked(rows);
      if (options.restrict !== undefined) {
        const { keys, reason } = options.restrict;
        views = views.map((view) =>
          keys.has(view.accountKey)
            ? view
            : {
                ...view,
                selection: {
                  ...view.selection,
                  eligible: false,
                  exclusions: [...view.selection.exclusions, reason],
                },
              },
        );
      }

      let result: SelectionResult;
      if (options.forcedAccountKey !== undefined) {
        const view = views.find((v) => v.accountKey === options.forcedAccountKey);
        if (view === undefined) {
          return {
            result: {
              kind: "none",
              reason: "no_accounts",
              nextReadyAt: null,
              exclusions: [],
            },
            lease: null,
          };
        }
        result = {
          kind: "selected",
          accountKey: view.accountKey,
          providerAccountId: view.providerAccountId,
          reason: {
            strategy: options.strategy,
            summary: "explicitly targeted account",
            headroomPercent: view.selection.headroomPercent,
            rawHeadroomPercent: view.selection.headroomPercent,
            concurrencyPenaltyPercent: 0,
            priority: view.policy.priority,
            weight: view.policy.weight,
            score: view.selection.headroomPercent ?? 0,
            activeLeases: view.selection.activeLeases,
            tieBreak: "none",
          },
          exclusions: [],
        };
      } else {
        result = selectAccount({
          accounts: views.filter(
            (account) =>
              account.present &&
              (options.requiredAccountKey === undefined || account.accountKey === options.requiredAccountKey),
          ),
          strategy: options.strategy,
          settings: this.settings.selection,
          allowUnknown: options.allowUnknown,
          lastSelectedAccountKey: this.activeAccountKey(),
          sequence: this.selectionSequenceLocked(),
          familyBlocks: options.familyBlocks ?? null,
        });
      }

      if (result.kind !== "selected") {
        return { result, lease: null };
      }
      const lease = this.leases.reserveLocked({
        accountKey: result.accountKey,
        purpose: options.purpose,
        cwd: options.cwd,
        selectorReason: result.reason,
      });
      this.db.handle
        .prepare(
          `INSERT INTO selection_state (id, sequence, last_selected_account_key, updated_at_ms)
           VALUES (1, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             sequence = sequence + 1,
             last_selected_account_key = excluded.last_selected_account_key,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(result.accountKey, this.clock());
      return { result, lease };
    });
  }

  /** Read-only selection explanation — no lease, no rotation mutation. */
  selectReadOnly(options: {
    strategy: SelectionStrategy;
    allowUnknown: boolean;
    /** Restrict normal eligibility/scoring to this account (balanced pinning). */
    requiredAccountKey?: string;
    familyBlocks?: ReadonlyMap<string, FamilyBlock> | null;
  }): SelectionResult {
    return this.db.immediate(() => {
      this.leases.expireStaleLocked();
      const views = this.assembleViewsLocked(this.catalog.listAll());
      return selectAccount({
        accounts: views.filter(
          (account) =>
            account.present &&
            (options.requiredAccountKey === undefined || account.accountKey === options.requiredAccountKey),
        ),
        strategy: options.strategy,
        settings: this.settings.selection,
        allowUnknown: options.allowUnknown,
        lastSelectedAccountKey: this.activeAccountKey(),
        sequence: this.selectionSequenceLocked(),
        familyBlocks: options.familyBlocks ?? null,
      });
    });
  }

  private buildAccountView(
    row: CatalogRow,
    usage: UsageStateRow | undefined,
    policy: PolicyRow,
    identityConflict: boolean,
    activeLeases: number,
    nowMs: number,
  ): SnapshotAccountView {
    const usageView = this.buildUsageView(usage, nowMs);
    const lastGood = buildLastGoodView(usage, nowMs);
    const quarantined = usageView.status === "quarantined";

    const exclusions: AccountExclusionReason[] = [];
    if (!row.present) exclusions.push("absent");
    if (!row.enabled) exclusions.push("ndy_disabled");
    if (policy.manuallyDisabled) exclusions.push("manually_disabled");
    if (row.authStatus === "no_credentials") exclusions.push("no_credentials");
    if (row.authStatus === "relogin_required" || quarantined) {
      exclusions.push("relogin_required");
    }
    if (identityConflict) exclusions.push("identity_conflict");
    if (policy.cooldownUntilMs !== null && policy.cooldownUntilMs > nowMs) {
      exclusions.push("cooldown_active");
    }
    if (!usageView.decisionGrade) {
      exclusions.push("usage_unknown");
    } else if (usageView.measurement !== null) {
      const exhausted =
        usageView.measurement.limitReached === true ||
        usageView.measurement.windows.some(
          (w) =>
            (w.kind === "primary" || w.kind === "secondary") &&
            w.remainingPercent <= 0,
        );
      if (exhausted) exclusions.push("quota_exhausted");
    }

    const headroom =
      usageView.decisionGrade && usageView.measurement !== null
        ? computeHeadroom(usageView.measurement)
        : null;

    return {
      accountKey: row.accountKey,
      providerAccountId: row.providerAccountId,
      email: row.email,
      label: row.label,
      enabled: row.enabled,
      present: row.present,
      ndyIndex: row.ndyIndex,
      auth: {
        status: quarantined ? "relogin_required" : row.authStatus,
        reloginRequired: row.authStatus === "relogin_required" || quarantined,
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
        headroomPercent: headroom,
        activeLeases,
      },
    };
  }

  private buildUsageView(
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
      pollIntervalMs: null,
      lastError: null,
    };
    if (usage === undefined) return empty;

    const trust = evaluateTrust(usage, this.settings.usage, nowMs);
    const view: SnapshotUsageView = {
      ...empty,
      status: trust.status,
      decisionGrade: trust.decisionGrade,
      measurement: trust.decisionGrade ? trust.measurement : null,
    };
    if (usage.lastErrorCode !== null) {
      view.lastError = {
        code: usage.lastErrorCode,
        httpStatus: usage.lastErrorHttpStatus,
        summary: usage.lastErrorSummary,
        at:
          usage.lastAttemptAtMs !== null ? toIsoUtc(usage.lastAttemptAtMs) : null,
      };
      if (
        view.status !== "quarantined" &&
        usage.backoffUntilMs !== null &&
        usage.backoffUntilMs > nowMs &&
        !trust.decisionGrade
      ) {
        view.status = "backoff";
      }
    }
    if (usage.nextPollAtMs !== null) {
      view.nextPollAt = toIsoUtc(usage.nextPollAtMs);
    }
    if (usage.pollIntervalMs !== null) {
      view.pollIntervalMs = usage.pollIntervalMs;
    }
    if (usage.fetchedAtMs !== null) {
      view.fetchedAt = toIsoUtc(usage.fetchedAtMs);
      view.ageSeconds = Math.max(0, Math.round((nowMs - usage.fetchedAtMs) / 1000));
    }
    return view;
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

function computeHeadroom(measurement: {
  windows: Array<{ kind: string; usedPercent: number }>;
}): number | null {
  const relevant = measurement.windows.filter(
    (w) => w.kind === "primary" || w.kind === "secondary",
  );
  if (relevant.length === 0) return null;
  const worst = Math.max(
    ...relevant.map((w) => Math.min(100, Math.max(0, w.usedPercent))),
  );
  return 100 - worst;
}

function buildLastGoodView(
  usage: UsageStateRow | undefined,
  nowMs: number,
): SnapshotLastGoodView | null {
  if (usage === undefined || usage.fetchedAtMs === null || usage.lastGoodJson === null) {
    return null;
  }
  try {
    const measurement = JSON.parse(usage.lastGoodJson) as SnapshotLastGoodView["measurement"];
    return {
      measurement,
      fetchedAt: toIsoUtc(usage.fetchedAtMs),
      ageSeconds: Math.max(0, Math.round((nowMs - usage.fetchedAtMs) / 1000)),
    };
  } catch {
    return null;
  }
}
