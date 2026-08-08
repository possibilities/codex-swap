import { parseArgs } from "node:util";
import { createNdyAdapter } from "../../ndy/adapter.ts";
import { NdyStoreReader } from "../../ndy/store-reader.ts";
import {
  resolveExplicitSelector,
  wrapperSelectorFor,
} from "../../accounts/selector.ts";
import { commandIo, emitFailure, splitForwardedArgs } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap run --account <selector> -- [codex args...]

Launches the official Codex CLI pinned to one account through the
codex-multi-auth runtime proxy. The pin is invocation-only and fail-hard: it
never changes ndy's persisted active account, and it never falls back to a
different account. Selectors: account key, provider account ID, record ID,
or a unique email. (--strategy arrives with the selection engine.)
`;

export async function runRunCommand(args: string[]): Promise<number> {
  const { own, forwarded } = splitForwardedArgs(args);

  let parsed;
  try {
    parsed = parseArgs({
      args: own,
      options: {
        account: { type: "string" },
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
  const selector = parsed.values.account;
  if (selector === undefined || selector.length === 0) {
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }

  try {
    const adapter = createNdyAdapter();
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
    if (wrapperSelector.kind === "no_selector") {
      return emitFailure(
        io,
        {
          code: "IDENTITY_CONFLICT",
          message: `${account.accountKey} has neither a provider account ID nor an email; cannot pin it safely`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }
    if (wrapperSelector.kind === "ambiguous_email") {
      return emitFailure(
        io,
        {
          code: "IDENTITY_CONFLICT",
          message: `${account.accountKey} shares its email with another account and has no provider account ID; refusing an ambiguous pin`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }

    const result = await adapter.runCodex({
      accountSelector: wrapperSelector.selector,
      args: forwarded ?? [],
    });
    return result.exitCode;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  }
}
