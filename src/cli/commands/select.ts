import { parseArgs } from "node:util";
import { createNdyAdapter } from "../../ndy/adapter.ts";
import { NdyStoreReader } from "../../ndy/store-reader.ts";
import {
  healableBlockedKeys,
  loadFamilyBlockContext,
  verifyAndHealFamilyBlocks,
} from "../../selection/family-blocks.ts";
import {
  isSparkModel,
  SPARK_CLAIM_LEASE_PURPOSE,
  SPARK_METERED_LANE,
} from "../../selection/metered-lane.ts";
import { SnapshotService } from "../../snapshot/service.ts";
import type { FamilyBlock, SelectionStrategy } from "../../selection/selector.ts";
import { dataRoot, familyVerifyStampPath } from "../../storage/paths.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { toIsoUtc } from "../../util/clock.ts";

const USAGE = `Usage: codex-swap select [--strategy best|next-available] [--account <account-key>] [--claim] [--allow-unknown] [--json]
       codex-swap select --account <account-key> --claim --metered-lane codex-spark --model <spark-model> [--json]

Explains which account automatic selection would choose — or, with --claim,
atomically reserves an invocation lease on it so concurrent harnesses
balance instead of racing. A claim must be consumed with
'codex-swap run --claim <lease-id> -- ...' before it expires.

--account restricts the balanced selection to one exact account key. The
account must pass the same eligibility gates as an automatic selection.

--metered-lane codex-spark claims one exact account against the separately
metered Spark lane instead of general quota: it requires --account, --claim,
and --model set to a Spark model, is incompatible with --strategy and
--allow-unknown, waives only general quota exhaustion, and still requires
independent positive headroom on the Spark lane itself.
`;

export async function runSelectCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        strategy: { type: "string" },
        account: { type: "string" },
        claim: { type: "boolean", default: false },
        "allow-unknown": { type: "boolean", default: false },
        "metered-lane": { type: "string" },
        model: { type: "string" },
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

  const meteredLane = parsed.values["metered-lane"];
  const model = parsed.values.model;
  if (meteredLane !== undefined || model !== undefined) {
    const invalid = (message: string) =>
      emitFailure(
        io,
        { code: "INVALID_ARGUMENTS", message, retryable: false },
        ExitCode.usage,
      );
    if (meteredLane === undefined) {
      return invalid("--model requires --metered-lane codex-spark");
    }
    if (meteredLane !== SPARK_METERED_LANE) {
      return invalid(
        `unknown metered lane '${meteredLane}' (expected ${SPARK_METERED_LANE})`,
      );
    }
    if (parsed.values.account === undefined) {
      return invalid("--metered-lane requires --account <account-key>");
    }
    if (!parsed.values.claim) {
      return invalid("--metered-lane requires --claim");
    }
    if (model === undefined || model.length === 0) {
      return invalid("--metered-lane requires --model <spark-model>");
    }
    if (requestedStrategy !== undefined) {
      return invalid("--metered-lane is incompatible with --strategy");
    }
    if (parsed.values["allow-unknown"]) {
      return invalid("--metered-lane is incompatible with --allow-unknown");
    }
    if (!isSparkModel(model)) {
      return invalid(
        `--model '${model}' is not a Spark model (normalized name must contain 'spark')`,
      );
    }
  }

  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const strategy: SelectionStrategy =
      requestedStrategy ?? service.settings.selection.strategy;
    const allowUnknown =
      parsed.values["allow-unknown"] || service.settings.selection.allowUnknown;
    const requiredAccountKey = parsed.values.account;

    const rows = await service.reconcile();
    await service.collectUsage({ rows });

    // Family filtering resolves the model from Codex config alone unless the
    // caller supplied one directly (the metered-lane claim always does, so
    // family context uses the exact model the claim will run under).
    // Dependency failures degrade to null.
    const adapter = createNdyAdapter();
    const familyContext = await loadFamilyBlockContext({
      adapter,
      reader: new NdyStoreReader(),
      forwardedArgs: model !== undefined ? ["--model", model] : [],
      enabled: service.settings.selection.familyFilter,
      warn: io.json
        ? undefined
        : (message) => process.stderr.write(`codex-swap: ${message}\n`),
    });
    const familyFilterReport = (blocks: ReadonlyMap<string, FamilyBlock> | null) =>
      familyContext === null
        ? null
        : {
            model: familyContext.model,
            family: familyContext.family,
            blockedAccounts: [...(blocks ?? familyContext.blocks).keys()],
          };

    if (meteredLane !== undefined) {
      const accountKey = parsed.values.account!;
      let familyBlocks = familyContext?.blocks ?? null;
      let { result, lease } = service.selectAndClaimMeteredLane({
        accountKey,
        lane: meteredLane,
        purpose: SPARK_CLAIM_LEASE_PURPOSE,
        cwd: process.cwd(),
        familyBlocks,
      });
      if (
        result.kind === "none" &&
        result.reason === "eligibility_excluded" &&
        familyContext !== null
      ) {
        const healable = healableBlockedKeys(result.exclusions);
        if (healable.length > 0) {
          const outcome = await verifyAndHealFamilyBlocks({
            adapter,
            reader: new NdyStoreReader(),
            context: familyContext,
            healableKeys: healable,
            stampPath: familyVerifyStampPath(dataRoot()),
            minIntervalMs: service.settings.selection.familyVerifyMinIntervalMs,
          });
          if (outcome.kind === "healed" && outcome.clearedAccountKeys.length > 0) {
            familyBlocks = outcome.blocks;
            ({ result, lease } = service.selectAndClaimMeteredLane({
              accountKey,
              lane: meteredLane,
              purpose: SPARK_CLAIM_LEASE_PURPOSE,
              cwd: process.cwd(),
              familyBlocks,
            }));
          }
        }
      }
      if (result.kind !== "selected" || lease === null) {
        return emitFailure(
          io,
          {
            code: "NO_ELIGIBLE_ACCOUNT",
            message:
              result.kind === "none" && result.reason === "spark_lane_exhausted"
                ? `${accountKey} has no remaining headroom on the ${meteredLane} lane.`
                : result.kind === "none" && result.reason === "spark_lane_unavailable"
                  ? `${accountKey} has no current, decision-grade ${meteredLane} lane data.`
                  : "No account has decision-grade quota and usable authentication.",
            retryable: true,
            details: {
              reason: result.kind === "none" ? result.reason : "unknown",
              exclusions: result.kind === "none" ? result.exclusions : [],
              familyFilter: familyFilterReport(familyBlocks),
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
        familyFilter: familyFilterReport(familyBlocks),
      });
      if (!io.json) {
        process.stdout.write(
          `claimed ${result.accountKey} on ${meteredLane} (lease ${lease.leaseId}, expires ${toIsoUtc(lease.expiresAtMs)})\n`,
        );
      }
      return ExitCode.success;
    }

    if (parsed.values.claim) {
      let familyBlocks = familyContext?.blocks ?? null;
      let { result, lease } = service.selectAndClaim({
        strategy,
        allowUnknown,
        purpose: "harness-claim",
        cwd: process.cwd(),
        requiredAccountKey,
        familyBlocks,
      });
      // A claim is a launch precursor, so the advisory-record contract
      // applies: live-verify records that are the sole obstacle, clear the
      // disproved ones, and retry once. The read-only explain below never
      // probes — explaining must stay side-effect-free.
      if (result.kind === "none" && familyContext !== null) {
        const healable = healableBlockedKeys(result.exclusions);
        if (healable.length > 0) {
          const outcome = await verifyAndHealFamilyBlocks({
            adapter,
            reader: new NdyStoreReader(),
            context: familyContext,
            healableKeys: healable,
            stampPath: familyVerifyStampPath(dataRoot()),
            minIntervalMs: service.settings.selection.familyVerifyMinIntervalMs,
          });
          if (outcome.kind === "healed" && outcome.clearedAccountKeys.length > 0) {
            familyBlocks = outcome.blocks;
            ({ result, lease } = service.selectAndClaim({
              strategy,
              allowUnknown,
              purpose: "harness-claim",
              cwd: process.cwd(),
              requiredAccountKey,
              familyBlocks,
            }));
          }
        }
      }
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
              familyFilter: familyFilterReport(familyBlocks),
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
        familyFilter: familyFilterReport(familyBlocks),
      });
      if (!io.json) {
        process.stdout.write(
          `claimed ${result.accountKey} (lease ${lease.leaseId}, expires ${toIsoUtc(lease.expiresAtMs)})\n`,
        );
      }
      return ExitCode.success;
    }

    const result = service.selectReadOnly({
      strategy,
      allowUnknown,
      requiredAccountKey,
      familyBlocks: familyContext?.blocks ?? null,
    });
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
            familyFilter: familyFilterReport(null),
          },
        },
        ExitCode.noEligibleAccount,
      );
    }
    emitSuccess(io, {
      selection: result,
      lease: null,
      familyFilter: familyFilterReport(null),
    });
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
