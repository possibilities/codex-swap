import { parseArgs } from "node:util";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { identityConflictKeys } from "../../accounts/catalog.ts";
import {
  assertSupportedNdyVersion,
  resolveNdyInstallation,
  SUPPORTED_NDY_VERSIONS,
} from "../../ndy/bin-resolver.ts";
import {
  NDY_CONTAINMENT_ENV,
  resolveCodexHome,
  resolveMultiAuthDir,
} from "../../ndy/environment.ts";
import { runCapture } from "../../ndy/spawn.ts";
import { SnapshotService } from "../../snapshot/service.ts";
import { dataRoot, databasePath, installSecretPath } from "../../storage/paths.ts";
import { QUARANTINE_DEAD_STRIKES } from "../../usage/trust.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { packageInfo } from "../../package-info.ts";

const USAGE = `Usage: codex-swap doctor [--live] [--fix] [--json]

Non-destructive health report: dependency, storage, permissions, identities,
claims, leases, and history. --live additionally probes the usage endpoint
for one ready account (a real network request). --fix applies safe local
repairs only: expiring stale leases and pruning old finished leases/events.
`;

type CheckStatus = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

const EVENTS_RETENTION_MS = 30 * 24 * 3_600_000;
const LEASE_AUDIT_WINDOW_MS = 7 * 24 * 3_600_000;

export async function runDoctorCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        live: { type: "boolean", default: false },
        fix: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap doctor: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("doctor", parsed.values.json);
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  add("platform", "ok", `${process.platform} node ${process.version}`);
  add("codex-swap", "ok", `version ${packageInfo().version}`);

  let service: SnapshotService | undefined;
  try {
    // Dependency resolution and version guard.
    try {
      const env = process.env;
      const packageDir = env["CODEX_SWAP_NDY_PACKAGE_DIR"];
      const installation = resolveNdyInstallation(
        packageDir !== undefined && packageDir.length > 0 ? { packageDir } : {},
      );
      try {
        assertSupportedNdyVersion(installation);
        add(
          "codex-multi-auth",
          "ok",
          `version ${installation.version} (tested: ${SUPPORTED_NDY_VERSIONS.join(", ")})`,
        );
      } catch {
        add(
          "codex-multi-auth",
          "fail",
          `version ${installation.version} is outside the tested range ${SUPPORTED_NDY_VERSIONS.join(", ")}`,
        );
      }
    } catch (error) {
      add(
        "codex-multi-auth",
        "fail",
        error instanceof Error ? error.message : String(error),
      );
    }

    // Official Codex CLI resolvability.
    try {
      const codex = await runCapture("codex", ["--version"], {
        env: process.env,
        timeoutMs: 10_000,
      });
      add(
        "codex-cli",
        codex.exitCode === 0 ? "ok" : "warn",
        codex.exitCode === 0
          ? codex.stdout.trim().slice(0, 80)
          : `codex --version exited ${codex.exitCode}`,
      );
    } catch {
      add("codex-cli", "warn", "official codex CLI not found on PATH");
    }

    const codexHome = resolveCodexHome();
    add("codex-home", "ok", codexHome);
    add("multi-auth-dir", "ok", resolveMultiAuthDir());

    // Containment environment integrity.
    const containmentKeys = Object.keys(NDY_CONTAINMENT_ENV);
    add(
      "containment-env",
      containmentKeys.length >= 15 ? "ok" : "fail",
      `${containmentKeys.length} opt-outs applied to every ndy child (quota sweep, app bind, launchers, config rewrites, background network)`,
    );

    // History directory.
    try {
      const sessions = countRolloutFiles(path.join(codexHome, "sessions"));
      add("history", "ok", `${sessions} rollout file(s) under sessions/`);
    } catch {
      add("history", "warn", "sessions directory not readable (no sessions yet?)");
    }

    // Storage, catalog, usage, leases — via the service.
    service = await SnapshotService.open();
    const root = dataRoot(process.env);
    const dbPath = databasePath(root);
    const posix = process.platform !== "win32";
    const dbMode = statSync(dbPath).mode & 0o777;
    add(
      "database",
      !posix || dbMode === 0o600 ? "ok" : "warn",
      `${dbPath} mode ${dbMode.toString(8)}`,
    );
    const secretPath = installSecretPath(root);
    try {
      const secretMode = statSync(secretPath).mode & 0o777;
      add(
        "install-secret",
        !posix || secretMode === 0o600 ? "ok" : "warn",
        `${secretPath} mode ${secretMode.toString(8)}`,
      );
    } catch {
      add("install-secret", "warn", "not created yet (first reconcile creates it)");
    }

    const rows = await service.reconcile();
    const present = rows.filter((r) => r.present);
    add(
      "accounts",
      present.length > 0 ? "ok" : "warn",
      `${present.length} present / ${rows.length} known`,
    );
    const conflicts = identityConflictKeys(present);
    add(
      "identities",
      conflicts.size === 0 ? "ok" : "warn",
      conflicts.size === 0
        ? "no ambiguous identities"
        : `${conflicts.size} account(s) share an email without a provider account id`,
    );

    const now = Date.now();
    const usageStates = service.store.readAll();
    let staleClaims = 0;
    let quarantined = 0;
    for (const state of usageStates.values()) {
      if (state.claimUntilMs !== null && state.claimUntilMs <= now) staleClaims += 1;
      if (state.authDeadStrikes >= QUARANTINE_DEAD_STRIKES) quarantined += 1;
    }
    add(
      "fetch-claims",
      staleClaims === 0 ? "ok" : "warn",
      staleClaims === 0 ? "no stale fetch claims" : `${staleClaims} stale claim(s) (expire naturally)`,
    );
    add(
      "quarantine",
      quarantined === 0 ? "ok" : "warn",
      quarantined === 0
        ? "no quarantined credentials"
        : `${quarantined} account(s) quarantined until re-login or credential rotation`,
    );

    const activeLeases = service.database.immediate(() => {
      const expired = service!.leases.expireStaleLocked();
      const active = service!.leases.list();
      return { expired, active };
    });
    add(
      "invocation-leases",
      "ok",
      `${activeLeases.active.length} active, ${activeLeases.expired} expired on this pass`,
    );

    const contractFailures = service.database.handle
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE event_type = 'dependency_contract_failed' AND occurred_at_ms > ?",
      )
      .get(now - 7 * 24 * 3_600_000) as { n: number };
    add(
      "dependency-contract",
      contractFailures.n === 0 ? "ok" : "warn",
      `${contractFailures.n} schema-validation failure(s) in the last 7 days`,
    );

    if (parsed.values.live) {
      const target = present.find((r) => r.authStatus === "ready");
      if (target === undefined) {
        add("usage-endpoint", "warn", "no ready account to probe");
      } else {
        await service.collectUsage({ rows, only: [target.accountKey], force: true });
        const state = service.store.read(target.accountKey);
        if (state?.lastErrorCode === null && state.fetchedAtMs !== null) {
          add("usage-endpoint", "ok", `live probe succeeded for ${target.accountKey}`);
        } else {
          add(
            "usage-endpoint",
            "warn",
            `live probe: ${state?.lastErrorCode ?? "no result"} (${state?.lastErrorSummary ?? ""})`,
          );
        }
      }
    }

    if (parsed.values.fix) {
      const prunedLeases = service.leases.pruneFinished(LEASE_AUDIT_WINDOW_MS);
      const prunedEvents = service.database.handle
        .prepare("DELETE FROM events WHERE occurred_at_ms < ?")
        .run(now - EVENTS_RETENTION_MS);
      add(
        "fix",
        "ok",
        `pruned ${prunedLeases} finished lease(s), ${Number(prunedEvents.changes)} old event(s)`,
      );
    }

    const failed = checks.some((c) => c.status === "fail");
    emitSuccess(io, { healthy: !failed, checks });
    if (!io.json) {
      for (const check of checks) {
        const mark = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
        process.stdout.write(`${mark} ${check.name.padEnd(20)} ${check.detail}\n`);
      }
    }
    return failed ? ExitCode.failure : ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

function countRolloutFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countRolloutFiles(full);
    } else if (/^rollout-.*\.jsonl(\.zst)?$/.test(entry.name)) {
      count += 1;
    }
  }
  return count;
}
