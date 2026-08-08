import { parseArgs } from "node:util";
import { SnapshotService } from "../../snapshot/service.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { toIsoUtc } from "../../util/clock.ts";

const USAGE = `Usage: codex-swap leases [--all] [--json]

Inspects invocation leases. Active (reserved/running) leases influence
selection scoring; --all includes recently finished ones. Stale leases are
expired as part of the read.
`;

export async function runLeasesCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        all: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap leases: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("leases", parsed.values.json);
  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const leases = service.database.immediate(() => {
      service!.leases.expireStaleLocked();
      return service!.leases.list({ includeFinished: parsed.values.all });
    });

    const rows = leases.map((lease) => ({
      leaseId: lease.leaseId,
      accountKey: lease.accountKey,
      status: lease.status,
      purpose: lease.purpose,
      ownerPid: lease.ownerPid,
      cwd: lease.cwd,
      acquiredAt: toIsoUtc(lease.acquiredAtMs),
      heartbeatAt: toIsoUtc(lease.heartbeatAtMs),
      expiresAt: toIsoUtc(lease.expiresAtMs),
      releasedAt: lease.releasedAtMs !== null ? toIsoUtc(lease.releasedAtMs) : null,
      childExitCode: lease.childExitCode,
    }));
    emitSuccess(io, { count: rows.length, leases: rows });
    if (!io.json) {
      for (const row of rows) {
        process.stdout.write(
          `${row.leaseId}  ${row.status.padEnd(8)}  ${row.accountKey}  pid=${row.ownerPid ?? "?"}  expires ${row.expiresAt}\n`,
        );
      }
      process.stdout.write(`${rows.length} lease(s)\n`);
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}
