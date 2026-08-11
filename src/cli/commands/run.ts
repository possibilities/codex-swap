import { parseArgs } from "node:util";
import {
  resolveExplicitSelector,
  wrapperSelectorFor,
} from "../../accounts/selector.ts";
import { resolveAppServerCapability } from "../../appserver/capability.ts";
import {
  autoServerSocketPath,
  DedicatedServerError,
  startDedicatedServer,
} from "../../appserver/dedicated.ts";
import { AppServerRegistry } from "../../appserver/registry.ts";
import { createNdyAdapter, type NdyAdapter } from "../../ndy/adapter.ts";
import { NdyStoreReader } from "../../ndy/store-reader.ts";
import { runLeasedCodex } from "../../runner/codex-runner.ts";
import type { InvocationLease } from "../../selection/leases.ts";
import type { SelectionStrategy } from "../../selection/selector.ts";
import { SnapshotService } from "../../snapshot/service.ts";
import { commandIo, emitFailure, splitForwardedArgs } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { parseListenUrl } from "./app-server.ts";

const USAGE = `Usage: codex-swap run --account <selector> [server options] -- [codex args...]
       codex-swap run --strategy [best|next-available] [--allow-unknown] [server options] -- [codex args...]
       codex-swap run --claim <lease-id> [server options] -- [codex args...]

Launches the official Codex CLI pinned to one account through the
codex-multi-auth runtime proxy, under a heartbeated invocation lease. The pin
is invocation-only and fail-hard: it never changes ndy's persisted active
account and never falls back to a different account. --strategy selects and
claims atomically; --claim consumes a lease from 'codex-swap select --claim'.

Server options: --server <unix-url|auto> starts a dedicated, exclusive
app-server for this one session — pinned to the same account, torn down when
the session ends — and attaches the TUI to it, so the session's socket IS its
identity. 'auto' picks a socket under the data root; an explicit unix:// URL
is fail-hard. --no-server forces a plain launch. With neither flag, the
appServer.dedicated setting decides; the legacy shared-server attachment is
composed only when no dedicated server is in play.
`;

/** How a launch wants its app-server: named, derived, refused, or by config. */
export type ServerRequest =
  | { kind: "explicit"; url: string }
  | { kind: "auto" }
  | { kind: "off" }
  | { kind: "default" };

export function parseServerRequest(values: {
  server?: string | undefined;
  noServer: boolean;
}): { request: ServerRequest } | { error: string } {
  if (values.server !== undefined && values.noServer) {
    return { error: "--server and --no-server are mutually exclusive" };
  }
  if (values.noServer) return { request: { kind: "off" } };
  if (values.server === undefined) return { request: { kind: "default" } };
  if (values.server === "auto") return { request: { kind: "auto" } };
  const listen = parseListenUrl(values.server);
  if (!listen.ok) return { error: `--server: ${listen.error}` };
  return { request: { kind: "explicit", url: listen.url } };
}

export type LaunchMode =
  | { kind: "account"; selector: string }
  | { kind: "strategy"; strategy: SelectionStrategy | null; allowUnknown: boolean }
  | { kind: "claim"; leaseId: string };

/** Shared lease-backed launch path for `run` and `resume`. */
export async function executeLaunch(
  mode: LaunchMode,
  codexArgs: string[],
  io: Io,
  server: ServerRequest = { kind: "default" },
): Promise<number> {
  let service: SnapshotService | undefined;
  try {
    const adapter = createNdyAdapter();
    service = await SnapshotService.open();

    if (mode.kind === "claim") {
      return await runWithExistingLease(service, adapter, mode.leaseId, codexArgs, io, server);
    }
    if (mode.kind === "account") {
      return await runExplicit(service, adapter, mode.selector, codexArgs, io, server);
    }
    return await runWithStrategy(
      service,
      adapter,
      mode.strategy ?? service.settings.selection.strategy,
      mode.allowUnknown || service.settings.selection.allowUnknown,
      codexArgs,
      io,
      server,
    );
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

export interface ParsedLaunchFlags {
  mode: LaunchMode | null;
  error?: string;
}

export function parseLaunchMode(values: {
  account?: string | undefined;
  strategy?: string | undefined;
  claim?: string | undefined;
  allowUnknown: boolean;
}): ParsedLaunchFlags {
  const modes = [
    values.account !== undefined,
    values.strategy !== undefined,
    values.claim !== undefined,
  ].filter(Boolean).length;
  if (modes > 1) {
    return { mode: null, error: "--account, --strategy, and --claim are mutually exclusive" };
  }
  if (values.account !== undefined) {
    if (values.account.length === 0) return { mode: null, error: "--account requires a value" };
    return { mode: { kind: "account", selector: values.account } };
  }
  if (values.claim !== undefined) {
    if (values.claim.length === 0) return { mode: null, error: "--claim requires a lease id" };
    return { mode: { kind: "claim", leaseId: values.claim } };
  }
  if (values.strategy !== undefined) {
    if (
      values.strategy !== "" &&
      values.strategy !== "best" &&
      values.strategy !== "next-available"
    ) {
      return {
        mode: null,
        error: `unknown strategy '${values.strategy}' (expected best or next-available)`,
      };
    }
    return {
      mode: {
        kind: "strategy",
        strategy: values.strategy === "" ? null : values.strategy,
        allowUnknown: values.allowUnknown,
      },
    };
  }
  return { mode: null };
}

export async function runRunCommand(args: string[]): Promise<number> {
  const { own, forwarded } = splitForwardedArgs(args);

  let parsed;
  try {
    parsed = parseArgs({
      args: own,
      options: {
        account: { type: "string" },
        strategy: { type: "string" },
        claim: { type: "string" },
        "allow-unknown": { type: "boolean", default: false },
        server: { type: "string" },
        "no-server": { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap run: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("run", false);
  const { mode, error } = parseLaunchMode({
    account: parsed.values.account,
    strategy: parsed.values.strategy,
    claim: parsed.values.claim,
    allowUnknown: parsed.values["allow-unknown"],
  });
  if (mode === null) {
    if (error !== undefined) {
      process.stderr.write(`codex-swap run: ${error}\n`);
    }
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }
  const serverParsed = parseServerRequest({
    server: parsed.values.server,
    noServer: parsed.values["no-server"],
  });
  if ("error" in serverParsed) {
    process.stderr.write(`codex-swap run: ${serverParsed.error}\n${USAGE}`);
    return ExitCode.usage;
  }
  return executeLaunch(mode, forwarded ?? [], io, serverParsed.request);
}

type Io = ReturnType<typeof commandIo>;

/**
 * Composes `--remote` when the leased account already has a resident
 * app-server (handoff §39.5). The server is the process that bills the
 * session, and it is pinned to this same account, so attaching keeps the
 * billing identical to launching standalone while putting the session inside
 * the resident server — where a bus bridge or any other app-server client can
 * see it. With no server registered, the launch is byte-for-byte as before.
 *
 * The flag goes ahead of any forwarded subcommand because it is a global
 * option; `resume <id>` still parses as the forwarded command behind it.
 */
function composeRemoteArgs(
  service: SnapshotService,
  accountKey: string,
  codexArgs: string[],
  io: Io,
): string[] {
  if (!service.settings.appServer.attachTui) return codexArgs;
  // An explicit --remote from the caller always wins: they named a server.
  if (hasRemoteFlag(codexArgs)) {
    return codexArgs;
  }
  const registry = new AppServerRegistry(
    service.database,
    service.leases,
    service.now,
  );
  const registration = registry.liveForAccount(accountKey);
  if (registration === null) return codexArgs;
  if (!io.json) {
    process.stderr.write(
      `codex-swap: attaching to the resident app-server at ${registration.listenUrl}\n`,
    );
  }
  return ["--remote", registration.listenUrl, ...codexArgs];
}

function hasRemoteFlag(codexArgs: string[]): boolean {
  return codexArgs.some((arg) => arg === "--remote" || arg.startsWith("--remote="));
}

/**
 * The tail every launch path shares once an account is pinned and a lease is
 * held: decide the session's server, then run the TUI under the lease.
 *
 * A dedicated server (handoff §39, extended) is one session's own — started
 * here, pinned to the same account the lease names, torn down when the
 * session ends. An explicit `--server unix://…` is fail-hard: the caller is
 * recording that socket as the session's identity, and silently attaching to
 * a shared server instead would quietly reintroduce every ambiguity the
 * dedicated topology exists to end. `auto` and the settings default degrade
 * to the legacy composition only when the capability probe says no dedicated
 * server can exist at all, and say so on stderr.
 */
async function launchSession(
  service: SnapshotService,
  adapter: NdyAdapter,
  lease: InvocationLease,
  accountSelector: string,
  codexArgs: string[],
  io: Io,
  server: ServerRequest,
): Promise<number> {
  const resolved: ServerRequest =
    server.kind === "default"
      ? service.settings.appServer.dedicated
        ? { kind: "auto" }
        : { kind: "off" }
      : server;

  if (resolved.kind !== "off" && hasRemoteFlag(codexArgs)) {
    if (resolved.kind === "explicit") {
      service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
      return emitFailure(
        io,
        {
          code: "SERVER_CONFLICT",
          message:
            "--server and a forwarded --remote name two different servers; pass one or the other",
          retryable: false,
        },
        ExitCode.usage,
      );
    }
    // The caller named a server; theirs wins over the derived one.
    return runLeasedCodex({
      adapter,
      leases: service.leases,
      lease,
      accountSelector,
      args: codexArgs,
      heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
    });
  }

  if (resolved.kind === "explicit" || resolved.kind === "auto") {
    const capability = resolveAppServerCapability({
      installation: adapter.installation,
      db: service.database,
      clock: service.now,
    });
    if (!capability.supported) {
      if (resolved.kind === "explicit") {
        service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
        return emitFailure(
          io,
          {
            code: "APP_SERVER_UNSUPPORTED",
            message: `--server was requested but no dedicated app-server can run: ${capability.detail}`,
            retryable: false,
          },
          ExitCode.dependencyUnavailable,
        );
      }
      if (!io.json) {
        process.stderr.write(
          `codex-swap: no dedicated app-server (${capability.detail}); launching without one\n`,
        );
      }
    } else {
      const listenUrl =
        resolved.kind === "explicit" ? resolved.url : `unix://${autoServerSocketPath()}`;
      let dedicated;
      try {
        dedicated = await startDedicatedServer({
          accountSelector: lease.accountKey,
          listenUrl,
        });
      } catch (error) {
        service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
        return emitFailure(
          io,
          {
            code: "APP_SERVER_UNAVAILABLE",
            message:
              error instanceof DedicatedServerError
                ? error.message
                : `the dedicated app-server did not start: ${String(error)}`,
            retryable: true,
          },
          ExitCode.failure,
        );
      }
      if (!io.json) {
        process.stderr.write(
          `codex-swap: dedicated app-server for ${lease.accountKey} at ${listenUrl}\n`,
        );
      }
      try {
        return await runLeasedCodex({
          adapter,
          leases: service.leases,
          lease,
          accountSelector,
          args: ["--remote", listenUrl, ...codexArgs],
          heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
        });
      } finally {
        await dedicated.stop();
      }
    }
  }

  return runLeasedCodex({
    adapter,
    leases: service.leases,
    lease,
    accountSelector,
    args: composeRemoteArgs(service, lease.accountKey, codexArgs, io),
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}

async function runExplicit(
  service: SnapshotService,
  adapter: ReturnType<typeof createNdyAdapter>,
  selector: string,
  codexArgs: string[],
  io: Io,
  server: ServerRequest,
): Promise<number> {
  const reader = new NdyStoreReader();
  const accounts = await reader.loadRedactedAccounts();

  const resolution = resolveExplicitSelector(accounts, selector);
  if (resolution.kind === "not_found") {
    return emitFailure(
      io,
      {
        code: "ACCOUNT_NOT_FOUND",
        message: `no account matches selector '${selector}' (accounts: ${accounts.length})`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  if (resolution.kind === "ambiguous") {
    return emitFailure(
      io,
      {
        code: "IDENTITY_CONFLICT",
        message: `selector '${selector}' matches multiple accounts (${resolution.candidates.join(", ")}); use the account key`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }

  const account = resolution.account;
  // Explicit selection may bypass manual-disable and unknown usage, but
  // never missing credentials, upstream auth invalidation, or an
  // unenforceable pin (handoff §20.1).
  if (!account.hasCredentials) {
    return emitFailure(
      io,
      {
        code: "RELOGIN_REQUIRED",
        message: `${account.accountKey} has no stored credentials; run 'codex-swap auth add'`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  if (account.authInvalidatedAt !== undefined) {
    return emitFailure(
      io,
      {
        code: "RELOGIN_REQUIRED",
        message: `${account.accountKey} authentication was invalidated upstream; re-login before use`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  const wrapperSelector = wrapperSelectorFor(account, accounts);
  if (wrapperSelector.kind !== "ok") {
    return emitFailure(
      io,
      {
        code: "IDENTITY_CONFLICT",
        message:
          wrapperSelector.kind === "ambiguous_email"
            ? `${account.accountKey} shares its email with another account and has no provider account ID; refusing an ambiguous pin`
            : `${account.accountKey} has neither a provider account ID nor an email; cannot pin it safely`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }

  await service.reconcile();
  const { lease } = service.selectAndClaim({
    strategy: service.settings.selection.strategy,
    allowUnknown: true,
    purpose: "codex-session",
    cwd: process.cwd(),
    forcedAccountKey: account.accountKey,
  });
  if (lease === null) {
    return emitFailure(
      io,
      {
        code: "INTERNAL_ERROR",
        message: `failed to reserve an invocation lease for ${account.accountKey}`,
        retryable: true,
      },
      ExitCode.failure,
    );
  }
  return launchSession(service, adapter, lease, wrapperSelector.selector, codexArgs, io, server);
}

async function runWithStrategy(
  service: SnapshotService,
  adapter: ReturnType<typeof createNdyAdapter>,
  strategy: SelectionStrategy,
  allowUnknown: boolean,
  codexArgs: string[],
  io: Io,
  server: ServerRequest,
): Promise<number> {
  const rows = await service.reconcile();
  await service.collectUsage({ rows });

  const { result, lease } = service.selectAndClaim({
    strategy,
    allowUnknown,
    purpose: "codex-session",
    cwd: process.cwd(),
  });
  if (result.kind !== "selected" || lease === null) {
    return emitFailure(
      io,
      {
        code: "NO_ELIGIBLE_ACCOUNT",
        message: "No account has decision-grade quota and usable authentication.",
        retryable: true,
        details: {
          reason: result.kind === "none" ? result.reason : "unknown",
          nextReadyAt: result.kind === "none" ? result.nextReadyAt : null,
        },
      },
      ExitCode.noEligibleAccount,
    );
  }

  const reader = new NdyStoreReader();
  const accounts = await reader.loadRedactedAccounts();
  const chosen = accounts.find((a) => a.accountKey === result.accountKey);
  const wrapperSelector =
    chosen !== undefined ? wrapperSelectorFor(chosen, accounts) : null;
  if (chosen === undefined || wrapperSelector === null || wrapperSelector.kind !== "ok") {
    service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
    return emitFailure(
      io,
      {
        code: "IDENTITY_CONFLICT",
        message: `selected ${result.accountKey} but its pin selector could not be resolved safely`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }

  process.stderr.write(
    `codex-swap: using ${result.accountKey} — ${result.reason.summary}\n`,
  );
  return launchSession(service, adapter, lease, wrapperSelector.selector, codexArgs, io, server);
}

async function runWithExistingLease(
  service: SnapshotService,
  adapter: ReturnType<typeof createNdyAdapter>,
  leaseId: string,
  codexArgs: string[],
  io: Io,
  server: ServerRequest,
): Promise<number> {
  const lease = service.leases.get(leaseId);
  if (lease === null || lease.status !== "reserved") {
    return emitFailure(
      io,
      {
        code: "LEASE_INVALID",
        message: `lease ${leaseId} is ${lease === null ? "unknown" : lease.status}; claim a fresh one with 'codex-swap select --claim'`,
        retryable: true,
      },
      ExitCode.failure,
    );
  }
  const reader = new NdyStoreReader();
  const accounts = await reader.loadRedactedAccounts();
  const account = accounts.find((a) => a.accountKey === lease.accountKey);
  if (account === undefined) {
    service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
    return emitFailure(
      io,
      {
        code: "ACCOUNT_NOT_FOUND",
        message: `lease ${leaseId} refers to ${lease.accountKey}, which is no longer in the ndy store`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  const wrapperSelector = wrapperSelectorFor(account, accounts);
  if (wrapperSelector.kind !== "ok") {
    service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
    return emitFailure(
      io,
      {
        code: "IDENTITY_CONFLICT",
        message: `${lease.accountKey} cannot be pinned safely`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  return launchSession(service, adapter, lease, wrapperSelector.selector, codexArgs, io, server);
}
