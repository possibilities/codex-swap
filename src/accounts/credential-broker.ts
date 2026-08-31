import { deriveAccountKey } from "./identity.ts";
import { ndyAccountsFilePath } from "../ndy/store-reader.ts";
import { type Clock, systemClock } from "../util/clock.ts";

/**
 * The ONLY module allowed to see ndy token fields (handoff §14). Tokens live
 * in local variables for the duration of one acquire and leave only inside
 * the in-memory lease handed to a usage probe. Rotation commits are
 * compare-and-adopt: a stale refresher never overwrites a newer lineage.
 */
export type CredentialLeaseResult =
  | {
      kind: "ready";
      accountKey: string;
      providerAccountId: string | undefined;
      accessToken: string;
      expiresAtMs: number | undefined;
      lineageHmac: string;
      /** False when served from ndy's cached access token without refreshing. */
      refreshed: boolean;
    }
  | { kind: "relogin_required"; reason: string }
  | { kind: "transient_failure"; reason: string; retryAfterMs?: number }
  | { kind: "identity_conflict"; reason: string };

/** Structural mirror of ndy's TokenResult (lib/schemas.ts). */
export type TokenResultLike =
  | {
      type: "success";
      access: string;
      refresh: string;
      expires?: number | undefined;
    }
  | {
      type: "failed";
      reason?: string | undefined;
      statusCode?: number | undefined;
      message?: string | undefined;
    };

export interface NdyAccountRecordShape {
  recordId?: string | undefined;
  accountId?: string | undefined;
  email?: string | undefined;
  addedAt?: number | undefined;
  refreshToken?: string | undefined;
  accessToken?: string | undefined;
  expiresAt?: number | undefined;
}

export interface BrokerDeps {
  loadAccounts(): Promise<{ accounts: NdyAccountRecordShape[] } | null>;
  /**
   * ndy's withAccountStorageTransaction: handler gets the current store and
   * a persist callback; mutations are atomic under ndy's storage lock.
   */
  mutateAccounts<T>(
    handler: (
      current: { accounts: NdyAccountRecordShape[] } | null,
      persist: (storage: { accounts: NdyAccountRecordShape[] }) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
  refresh(refreshToken: string, signal: AbortSignal): Promise<TokenResultLike>;
}

/**
 * Permanent-death predicate mirroring ndy's internal isFlaggableFailure
 * (lib/runtime/account-check-helpers.ts — not exported, reimplemented per
 * its source): missing refresh token, HTTP 401, or HTTP 400 whose message
 * names a dead grant.
 */
export function isPermanentAuthFailure(failure: {
  reason?: string | undefined;
  statusCode?: number | undefined;
  message?: string | undefined;
}): boolean {
  if (failure.reason === "missing_refresh") return true;
  if (failure.statusCode === 401) return true;
  if (failure.statusCode !== 400) return false;
  const message = (failure.message ?? "").toLowerCase();
  return (
    message.includes("invalid_grant") ||
    message.includes("invalid refresh") ||
    message.includes("token has been revoked")
  );
}

const ACCESS_TOKEN_FRESHNESS_BUFFER_MS = 120_000;
const REFRESH_TIMEOUT_MS = 20_000;

async function productionDeps(env: NodeJS.ProcessEnv): Promise<BrokerDeps> {
  const [storage, auth] = await Promise.all([
    import("codex-multi-auth/storage"),
    import("codex-multi-auth/auth"),
  ]);
  storage.setStoragePathDirect(ndyAccountsFilePath(env));
  return {
    loadAccounts: () => storage.loadAccounts(),
    async mutateAccounts<T>(
      handler: (
        current: { accounts: NdyAccountRecordShape[] } | null,
        persist: (s: { accounts: NdyAccountRecordShape[] }) => Promise<void>,
      ) => Promise<T>,
    ): Promise<T> {
      return storage.withAccountStorageTransaction<T>((current, persist) =>
        handler(
          current,
          persist as unknown as (
            s: { accounts: NdyAccountRecordShape[] },
          ) => Promise<void>,
        ),
      );
    },
    refresh: async (refreshToken, signal) =>
      (await auth.refreshAccessToken(refreshToken, { signal })) as TokenResultLike,
  };
}

export class CredentialBroker {
  private readonly lineage: (refreshToken: string) => string;
  private readonly clock: Clock;
  private readonly depsPromise: Promise<BrokerDeps>;

  constructor(options: {
    lineage: (refreshToken: string) => string;
    env?: NodeJS.ProcessEnv;
    deps?: BrokerDeps;
    clock?: Clock;
  }) {
    this.lineage = options.lineage;
    this.clock = options.clock ?? systemClock;
    this.depsPromise =
      options.deps !== undefined
        ? Promise.resolve(options.deps)
        : productionDeps(options.env ?? process.env);
  }

  async acquire(
    accountKey: string,
    options?: { forceRefresh?: boolean },
  ): Promise<CredentialLeaseResult> {
    return this.acquireInner(accountKey, options?.forceRefresh === true, 0);
  }

  private async acquireInner(
    accountKey: string,
    forceRefresh: boolean,
    depth: number,
  ): Promise<CredentialLeaseResult> {
    if (depth > 2) {
      return {
        kind: "transient_failure",
        reason: "credential rotation raced repeatedly; retry later",
      };
    }
    const deps = await this.depsPromise;
    const store = await deps.loadAccounts();
    const record = store?.accounts.find(
      (r) => deriveAccountKey(r) === accountKey,
    );
    if (record === undefined) {
      return {
        kind: "identity_conflict",
        reason: "account is missing from the ndy store",
      };
    }
    const refreshToken = record.refreshToken;
    if (refreshToken === undefined || refreshToken.length === 0) {
      return { kind: "relogin_required", reason: "no stored refresh token" };
    }

    const now = this.clock();
    if (
      !forceRefresh &&
      record.accessToken !== undefined &&
      record.accessToken.length > 0 &&
      record.expiresAt !== undefined &&
      record.expiresAt > now + ACCESS_TOKEN_FRESHNESS_BUFFER_MS
    ) {
      return {
        kind: "ready",
        accountKey,
        providerAccountId: record.accountId,
        accessToken: record.accessToken,
        expiresAtMs: record.expiresAt,
        lineageHmac: this.lineage(refreshToken),
        refreshed: false,
      };
    }

    // Refresh outside any storage lock (handoff §14 step 3).
    let result: TokenResultLike;
    try {
      result = await deps.refresh(refreshToken, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
    } catch {
      return {
        kind: "transient_failure",
        reason: "token refresh threw before completing",
      };
    }

    if (result.type === "success") {
      return this.commitRefresh(accountKey, refreshToken, result, depth);
    }

    if (isPermanentAuthFailure(result)) {
      // Reread once before declaring death — another process may have
      // rotated the lineage successfully (§14 step 8).
      const reread = await deps.loadAccounts();
      const current = reread?.accounts.find(
        (r) => deriveAccountKey(r) === accountKey,
      );
      if (
        current?.refreshToken !== undefined &&
        current.refreshToken !== refreshToken
      ) {
        return this.acquireInner(accountKey, forceRefresh, depth + 1);
      }
      return {
        kind: "relogin_required",
        reason: `refresh rejected permanently (${result.reason ?? "http_error"}${
          result.statusCode !== undefined ? ` ${result.statusCode}` : ""
        })`,
      };
    }
    return {
      kind: "transient_failure",
      reason: `refresh failed transiently (${result.reason ?? "unknown"})`,
    };
  }

  private async commitRefresh(
    accountKey: string,
    snapshotRefreshToken: string,
    result: Extract<TokenResultLike, { type: "success" }>,
    depth: number,
  ): Promise<CredentialLeaseResult> {
    const deps = await this.depsPromise;
    const outcome = await deps.mutateAccounts<
      | { kind: "committed"; providerAccountId: string | undefined }
      | { kind: "adopted" }
      | { kind: "missing" }
    >(async (current, persist) => {
      const record = current?.accounts.find(
        (r) => deriveAccountKey(r) === accountKey,
      );
      if (current === null || record === undefined) return { kind: "missing" };
      if (record.refreshToken !== snapshotRefreshToken) {
        // Another actor rotated the lineage while we refreshed: never
        // persist a predecessor after a successor (§14 steps 6 and 9).
        return { kind: "adopted" };
      }
      record.refreshToken = result.refresh;
      record.accessToken = result.access;
      if (result.expires !== undefined) {
        record.expiresAt = result.expires;
      }
      await persist(current);
      return { kind: "committed", providerAccountId: record.accountId };
    });

    if (outcome.kind === "missing") {
      return {
        kind: "identity_conflict",
        reason: "account disappeared during token rotation",
      };
    }
    if (outcome.kind === "adopted") {
      // Discard our result and use whatever the winner persisted.
      return this.acquireInner(accountKey, false, depth + 1);
    }
    return {
      kind: "ready",
      accountKey,
      providerAccountId: outcome.providerAccountId,
      accessToken: result.access,
      expiresAtMs: result.expires,
      lineageHmac: this.lineage(result.refresh),
      refreshed: true,
    };
  }
}
