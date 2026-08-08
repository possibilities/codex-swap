import { parseArgs } from "node:util";
import { createNdyAdapter, type LoginMode } from "../../ndy/adapter.ts";
import { NdyStoreReader } from "../../ndy/store-reader.ts";
import type { RedactedNdyAccount } from "../../accounts/redaction.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap auth add [--device-auth | --manual] [--org <org-id>] [--json]

Adds a Codex account through codex-multi-auth's OAuth flows and reports the
resulting account-store change. Default is ndy's interactive browser login
(add the account, then exit its dashboard); --device-auth and --manual
complete on their own. Success requires exit 0 AND a store diff — login also
exits 0 on user cancel.
`;

interface AccountDiff {
  added: RedactedNdyAccount[];
  changed: RedactedNdyAccount[];
}

function fingerprint(account: RedactedNdyAccount): string {
  return JSON.stringify([
    account.providerAccountId ?? null,
    account.email ?? null,
    account.label ?? null,
    account.enabled,
    account.hasCredentials,
    account.authInvalidatedAt ?? null,
  ]);
}

export function diffAccounts(
  before: readonly RedactedNdyAccount[],
  after: readonly RedactedNdyAccount[],
): AccountDiff {
  const beforeByKey = new Map(before.map((a) => [a.accountKey, a]));
  const added: RedactedNdyAccount[] = [];
  const changed: RedactedNdyAccount[] = [];
  for (const account of after) {
    const previous = beforeByKey.get(account.accountKey);
    if (previous === undefined) {
      added.push(account);
    } else if (fingerprint(previous) !== fingerprint(account)) {
      changed.push(account);
    }
  }
  return { added, changed };
}

export async function runAuthCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "add") {
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        "device-auth": { type: "boolean", default: false },
        manual: { type: "boolean", default: false },
        org: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap auth: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("auth add", parsed.values.json);
  if (parsed.values["device-auth"] && parsed.values.manual) {
    return emitFailure(
      io,
      {
        code: "INVALID_ARGUMENTS",
        message: "--device-auth and --manual are mutually exclusive",
        retryable: false,
      },
      ExitCode.usage,
    );
  }
  const mode: LoginMode = parsed.values["device-auth"]
    ? "device"
    : parsed.values.manual
      ? "manual"
      : "browser";

  try {
    const adapter = createNdyAdapter();
    const reader = new NdyStoreReader();
    const before = await reader.loadRedactedAccounts();

    const result = await adapter.login(
      mode,
      parsed.values.org !== undefined ? { orgId: parsed.values.org } : {},
    );
    if (result.exitCode !== 0) {
      return emitFailure(
        io,
        {
          code: "AUTH_LOGIN_FAILED",
          message: `codex-multi-auth login exited ${result.exitCode}`,
          retryable: true,
        },
        ExitCode.failure,
      );
    }

    const after = await reader.loadRedactedAccounts();
    const diff = diffAccounts(before, after);
    emitSuccess(io, {
      mode,
      accountCount: after.length,
      added: diff.added,
      changed: diff.changed,
    });
    if (!io.json) {
      for (const account of diff.added) {
        process.stdout.write(
          `Added ${account.email ?? account.label ?? "account"} (${account.accountKey})\n`,
        );
      }
      for (const account of diff.changed) {
        process.stdout.write(
          `Updated ${account.email ?? account.label ?? "account"} (${account.accountKey})\n`,
        );
      }
      if (diff.added.length === 0 && diff.changed.length === 0) {
        process.stdout.write(
          "Login completed but the account store did not change (cancelled?).\n",
        );
      }
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  }
}
