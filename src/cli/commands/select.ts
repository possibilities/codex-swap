import { parseArgs } from "node:util";
import { SnapshotService } from "../../snapshot/service.ts";
import type { SelectionStrategy } from "../../selection/selector.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { toIsoUtc } from "../../util/clock.ts";

const USAGE = `Usage: codex-swap select [--strategy best|next-available] [--claim] [--allow-unknown] [--json]

Explains which account automatic selection would choose — or, with --claim,
atomically reserves an invocation lease on it so concurrent harnesses
balance instead of racing. A claim must be consumed with
'codex-swap run --claim <lease-id> -- ...' before it expires.
`;

export async function runSelectCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        strategy: { type: "string" },
        claim: { type: "boolean", default: false },
        "allow-unknown": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap select: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("select", parsed.values.json);
  const requestedStrategy = parsed.values.strategy;
  if (
    requestedStrategy !== undefined &&
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
    service = await SnapshotService.open();
    const strategy: SelectionStrategy =
      requestedStrategy ?? service.settings.selection.strategy;
    const allowUnknown =
      parsed.values["allow-unknown"] || service.settings.selection.allowUnknown;

    const rows = await service.reconcile();
    await service.collectUsage({ rows });

    if (parsed.values.claim) {
      const { result, lease } = service.selectAndClaim({
        strategy,
        allowUnknown,
        purpose: "harness-claim",
        cwd: process.cwd(),
      });
      if (result.kind !== "selected" || lease === null) {
        return emitFailure(
          io,
          {
            code: "NO_ELIGIBLE_ACCOUNT",
            message:
              "No account has decision-grade quota and usable authentication.",
            retryable: true,
            details: {
              reason: result.kind === "none" ? result.reason : "unknown",
              nextReadyAt: result.kind === "none" ? result.nextReadyAt : null,
              exclusions: result.kind === "none" ? result.exclusions : [],
            },
          },
          ExitCode.noEligibleAccount,
        );
      }
      emitSuccess(io, {
        selection: result,
        lease: {
          leaseId: lease.leaseId,
          ownerNonce: lease.ownerNonce,
          accountKey: lease.accountKey,
          status: lease.status,
          expiresAt: toIsoUtc(lease.expiresAtMs),
        },
      });
      if (!io.json) {
        process.stdout.write(
          `claimed ${result.accountKey} (lease ${lease.leaseId}, expires ${toIsoUtc(lease.expiresAtMs)})\n`,
        );
      }
      return ExitCode.success;
    }

    const result = service.selectReadOnly({ strategy, allowUnknown });
    if (result.kind !== "selected") {
      return emitFailure(
        io,
        {
          code: "NO_ELIGIBLE_ACCOUNT",
          message:
            "No account has decision-grade quota and usable authentication.",
          retryable: true,
          details: {
            reason: result.reason,
            nextReadyAt: result.nextReadyAt,
            exclusions: result.exclusions,
          },
        },
        ExitCode.noEligibleAccount,
      );
    }
    emitSuccess(io, { selection: result, lease: null });
    if (!io.json) {
      process.stdout.write(
        `${result.accountKey}  ${result.reason.summary} (score ${result.reason.score.toFixed(1)})\n`,
      );
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}
