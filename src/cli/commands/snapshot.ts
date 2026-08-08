import { parseArgs } from "node:util";
import { SnapshotService } from "../../snapshot/service.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap snapshot [--no-fetch] [--json]

One coherent account/usage/health snapshot — the primary machine-facing
integration boundary. Repeated calls are safe: the usage store, not the
caller, decides whether any network fetch happens. --no-fetch skips the
collection pass entirely and serves stored state only (cheap repaint reads
for TUIs whose daemon owns fetching).
`;

export async function runSnapshotCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        json: { type: "boolean", default: false },
        "no-fetch": { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap snapshot: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("snapshot", parsed.values.json);
  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const snapshot = await service.build(process.env, {
      fetchUsage: !parsed.values["no-fetch"],
    });
    emitSuccess(io, snapshot);
    if (!io.json) {
      process.stdout.write(
        `codex-multi-auth ${snapshot.dependency.version} · CODEX_HOME ${snapshot.canonicalCodexHome}\n`,
      );
      for (const account of snapshot.accounts) {
        const usage = account.usage.decisionGrade
          ? `usage ${account.usage.measurement?.windows
              .map((w) => `${w.label}:${w.usedPercent}%`)
              .join(" ")}`
          : `usage ${account.usage.status}`;
        const eligibility = account.selection.eligible
          ? "eligible"
          : `excluded: ${account.selection.exclusions.join(",")}`;
        process.stdout.write(
          `${account.accountKey}  ${account.email ?? "?"}  ${usage}  ${eligibility}\n`,
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
