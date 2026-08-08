import { parseArgs } from "node:util";
import { SnapshotService } from "../../snapshot/service.ts";
import { identityConflictKeys } from "../../accounts/catalog.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { toIsoUtc } from "../../util/clock.ts";

const USAGE = `Usage: codex-swap accounts [--json]

Redacted account inventory from the reconciled catalog. Never triggers a
live usage sweep and never contains tokens.
`;

export async function runAccountsCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap accounts: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("accounts", parsed.values.json);
  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const rows = await service.reconcile();
    const conflicts = identityConflictKeys(rows.filter((r) => r.present));

    const accounts = rows.map((row) => ({
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
      identityConflict: conflicts.has(row.accountKey),
      addedAt: row.addedAtMs !== null ? toIsoUtc(row.addedAtMs) : null,
      firstSeenAt: toIsoUtc(row.firstSeenAtMs),
      lastSeenAt: toIsoUtc(row.lastSeenAtMs),
    }));

    emitSuccess(io, { count: accounts.length, accounts });
    if (!io.json) {
      for (const account of accounts) {
        const flags = [
          account.present ? null : "absent",
          account.enabled ? null : "disabled",
          account.auth.reloginRequired ? "re-login required" : null,
          account.auth.status === "no_credentials" ? "no credentials" : null,
          account.identityConflict ? "identity conflict" : null,
        ].filter((f): f is string => f !== null);
        process.stdout.write(
          `${account.accountKey}  ${account.email ?? account.label ?? "?"}${
            flags.length > 0 ? `  [${flags.join(", ")}]` : ""
          }\n`,
        );
      }
      process.stdout.write(`${accounts.length} account(s)\n`);
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}
