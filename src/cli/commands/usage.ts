import { parseArgs } from "node:util";
import { resolveExplicitSelector } from "../../accounts/selector.ts";
import type { RedactedNdyAccount } from "../../accounts/redaction.ts";
import type { CatalogRow } from "../../accounts/catalog.ts";
import { SnapshotService } from "../../snapshot/service.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap usage [selector] [--json]
       codex-swap usage refresh [selector] [--json]

Store-governed usage view. Plain 'usage' fetches only accounts that are due
under their poll plans; 'refresh' bypasses the poll plan but still honors
claims, backoff, and quarantine. Selector: account key, provider account ID,
record ID, or unique email.
`;

function selectorView(rows: CatalogRow[]): RedactedNdyAccount[] {
  return rows
    .filter((row) => row.present)
    .map((row) => {
      const view: RedactedNdyAccount = {
        accountKey: row.accountKey,
        enabled: row.enabled,
        hasCredentials: row.authStatus !== "no_credentials",
        ndyIndex: row.ndyIndex ?? 0,
      };
      if (row.recordId !== null) view.recordId = row.recordId;
      if (row.providerAccountId !== null) {
        view.providerAccountId = row.providerAccountId;
      }
      if (row.email !== null) view.email = row.email;
      return view;
    });
}

export async function runUsageCommand(args: string[]): Promise<number> {
  const force = args[0] === "refresh";
  const rest = force ? args.slice(1) : args;

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap usage: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo(force ? "usage refresh" : "usage", parsed.values.json);
  const selector = parsed.positionals[0];

  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const rows = await service.reconcile();

    let only: string[] | undefined;
    if (selector !== undefined) {
      const resolution = resolveExplicitSelector(selectorView(rows), selector);
      if (resolution.kind === "not_found") {
        return emitFailure(
          io,
          {
            code: "ACCOUNT_NOT_FOUND",
            message: `no account matches selector '${selector}'`,
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
            message: `selector '${selector}' matches multiple accounts (${resolution.candidates.join(", ")})`,
            retryable: false,
          },
          ExitCode.reloginRequired,
        );
      }
      only = [resolution.account.accountKey];
    }

    await service.collectUsage({
      rows,
      ...(only !== undefined ? { only } : {}),
      force,
    });
    const snapshot = await service.build(process.env, { fetchUsage: false });
    const accounts =
      only !== undefined
        ? snapshot.accounts.filter((a) => only.includes(a.accountKey))
        : snapshot.accounts;

    emitSuccess(io, {
      accounts: accounts.map((account) => ({
        accountKey: account.accountKey,
        email: account.email,
        usage: account.usage,
        lastGoodUsage: account.lastGoodUsage,
      })),
    });
    if (!io.json) {
      for (const account of accounts) {
        const windows =
          account.usage.measurement?.windows
            .map((w) => `${w.label} ${w.usedPercent}% used`)
            .join(" · ") ??
          account.lastGoodUsage?.measurement.windows
            .map((w) => `${w.label} ${w.usedPercent}% used`)
            .join(" · ");
        const age =
          account.usage.ageSeconds !== null
            ? ` (${account.usage.ageSeconds}s ago)`
            : "";
        const status = account.usage.decisionGrade
          ? ""
          : ` [${account.usage.status}${
              account.usage.lastError !== null
                ? `: ${account.usage.lastError.code}`
                : ""
            }]`;
        process.stdout.write(
          `${account.accountKey}  ${account.email ?? "?"}  ${windows ?? "no data"}${age}${status}\n`,
        );
      }
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}
