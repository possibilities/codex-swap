import { parseArgs } from "node:util";
import {
  resolveExplicitSelector,
  wrapperSelectorFor,
} from "../../accounts/selector.ts";
import { createNdyAdapter } from "../../ndy/adapter.ts";
import { NdyStoreReader } from "../../ndy/store-reader.ts";
import { runLeasedCodex } from "../../runner/codex-runner.ts";
import type { SelectionStrategy } from "../../selection/selector.ts";
import { SnapshotService } from "../../snapshot/service.ts";
import { commandIo, emitFailure, splitForwardedArgs } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap run --account <selector> -- [codex args...]
       codex-swap run --strategy [best|next-available] [--allow-unknown] -- [codex args...]
       codex-swap run --claim <lease-id> -- [codex args...]

Launches the official Codex CLI pinned to one account through the
codex-multi-auth runtime proxy, under a heartbeated invocation lease. The pin
is invocation-only and fail-hard: it never changes ndy's persisted active
account and never falls back to a different account. --strategy selects and
claims atomically; --claim consumes a lease from 'codex-swap select --claim'.
`;

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
  const modes = [
    parsed.values.account !== undefined,
    parsed.values.strategy !== undefined,
    parsed.values.claim !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1) {
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }
  const requestedStrategy = parsed.values.strategy;
  if (
    requestedStrategy !== undefined &&
    requestedStrategy !== "" &&
    requestedStrategy !== "best" &&
    requestedStrategy !== "next-available"
  ) {
    return emitFailure(
      io,
      {
        code: "INVALID_ARGUMENTS",
        message: `unknown strategy '${requestedStrategy}' (expected best or next-available)`,
        retryable: false,
      },
      ExitCode.usage,
    );
  }

  let service: SnapshotService | undefined;
  try {
    const adapter = createNdyAdapter();
    service = await SnapshotService.open();
    const codexArgs = forwarded ?? [];

    if (parsed.values.claim !== undefined) {
      return await runWithExistingLease(
        service,
        adapter,
        parsed.values.claim,
        codexArgs,
        io,
      );
    }
    if (parsed.values.account !== undefined) {
      return await runExplicit(
        service,
        adapter,
        parsed.values.account,
        codexArgs,
        io,
      );
    }
    const strategy: SelectionStrategy =
      requestedStrategy === undefined || requestedStrategy === ""
        ? service.settings.selection.strategy
        : requestedStrategy;
    return await runWithStrategy(
      service,
      adapter,
      strategy,
      parsed.values["allow-unknown"] || service.settings.selection.allowUnknown,
      codexArgs,
      io,
    );
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

type Io = ReturnType<typeof commandIo>;

async function runExplicit(
  service: SnapshotService,
  adapter: ReturnType<typeof createNdyAdapter>,
  selector: string,
  codexArgs: string[],
  io: Io,
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
  return runLeasedCodex({
    adapter,
    leases: service.leases,
    lease,
    accountSelector: wrapperSelector.selector,
    args: codexArgs,
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}

async function runWithStrategy(
  service: SnapshotService,
  adapter: ReturnType<typeof createNdyAdapter>,
  strategy: SelectionStrategy,
  allowUnknown: boolean,
  codexArgs: string[],
  io: Io,
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
  return runLeasedCodex({
    adapter,
    leases: service.leases,
    lease,
    accountSelector: wrapperSelector.selector,
    args: codexArgs,
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}

async function runWithExistingLease(
  service: SnapshotService,
  adapter: ReturnType<typeof createNdyAdapter>,
  leaseId: string,
  codexArgs: string[],
  io: Io,
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
  return runLeasedCodex({
    adapter,
    leases: service.leases,
    lease,
    accountSelector: wrapperSelector.selector,
    args: codexArgs,
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}
