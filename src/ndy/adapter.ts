import type { z } from "zod";
import {
  assertSupportedNdyVersion,
  resolveNdyInstallation,
  type NdyInstallation,
} from "./bin-resolver.ts";
import { withNdyContainment } from "./environment.ts";
import {
  ndyForecastSchema,
  ndyHistoryDetailSchema,
  ndyHistoryListSchema,
  ndyModelsMatrixSchema,
  ndyRateLimitResetSchema,
  ndyStatusSchema,
  type NdyForecast,
  type NdyHistoryDetail,
  type NdyHistoryList,
  type NdyRateLimitReset,
  type NdyStatus,
} from "./schemas.ts";
import {
  runCapture,
  runInteractive,
  type InteractiveResult,
} from "./spawn.ts";

/** Raised when ndy emits JSON that fails our contract validation. */
export class NdyContractError extends Error {}

/** Raised when an ndy manager command exits non-zero. */
export class NdyCommandError extends Error {
  readonly exitCode: number | null;

  constructor(command: string, exitCode: number | null, stderrTail: string) {
    super(
      `codex-multi-auth ${command} exited ${exitCode ?? "by signal"}${
        stderrTail.length > 0 ? `: ${stderrTail}` : ""
      }`,
    );
    this.exitCode = exitCode;
  }
}

/**
 * Raised before spawn when forwarded Codex args contain a --account token.
 * The 2.8.3 wrapper's extractor is `--`-unaware and last-occurrence-wins, so
 * a forwarded --account would silently override our pin and break the
 * fail-hard guarantee.
 */
export class ForcedAccountConflictError extends Error {
  constructor() {
    super(
      "forwarded Codex args must not contain --account: the codex-multi-auth wrapper would " +
        "reinterpret it and override codex-swap's account pin",
    );
  }
}

export function assertNoForcedAccountOverride(args: string[]): void {
  for (const arg of args) {
    if (arg === "--account" || arg.startsWith("--account=")) {
      throw new ForcedAccountConflictError();
    }
  }
}

export type LoginMode = "browser" | "device" | "manual";

const MANAGER_JSON_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 1_000;

export class NdyAdapter {
  readonly installation: NdyInstallation;
  private readonly env: NodeJS.ProcessEnv;

  constructor(installation: NdyInstallation, baseEnv: NodeJS.ProcessEnv) {
    this.installation = installation;
    this.env = withNdyContainment(baseEnv);
  }

  version(): string {
    return this.installation.version;
  }

  /**
   * Spawns ndy login with inherited stdio. Browser mode is ndy's interactive
   * dashboard (it returns only when the user exits it); device and manual
   * modes return as soon as the flow completes. Exit 0 does NOT imply an
   * account was added — ndy also exits 0 on user cancel — so callers must
   * diff the account store (handoff §13.5).
   */
  async login(
    mode: LoginMode,
    options?: { orgId?: string },
  ): Promise<InteractiveResult> {
    const args = ["login"];
    if (mode === "device") args.push("--device-auth");
    if (mode === "manual") args.push("--manual");
    if (options?.orgId !== undefined) args.push("--org", options.orgId);
    return runInteractive(
      process.execPath,
      [this.installation.bins.manager, ...args],
      { env: this.env },
    );
  }

  async status(): Promise<NdyStatus> {
    return this.managerJson(["status", "--json"], ndyStatusSchema);
  }

  /**
   * Resolves a model id to ndy's prompt-family key — the key its per-family
   * rate-limit records are stored under. Returns null when ndy reports no
   * family (an unknown model), so callers degrade to unfiltered selection
   * rather than guessing.
   */
  async promptFamilyForModel(model: string): Promise<string | null> {
    if (model.length === 0 || model.startsWith("-")) {
      throw new NdyContractError(`invalid model id: '${model}'`);
    }
    const parsed = await this.managerJson(
      ["models", "--json", "--model", model],
      ndyModelsMatrixSchema,
    );
    for (const entry of parsed.matrix.entries) {
      if (typeof entry.promptFamily === "string" && entry.promptFamily.length > 0) {
        return entry.promptFamily;
      }
    }
    return null;
  }

  /**
   * Per-account availability forecast. Live mode probes the provider with
   * the given model and is the only trustworthy verdict on a persisted
   * family rate-limit record: 2.8.5's cached forecast cross-checks records
   * against the codex family regardless of the model asked about.
   */
  async forecast(
    model: string | null,
    options?: { live?: boolean },
  ): Promise<NdyForecast> {
    if (model !== null && (model.length === 0 || model.startsWith("-"))) {
      throw new NdyContractError(`invalid model id: '${model}'`);
    }
    const args = ["forecast", "--json"];
    if (model !== null) args.push("--model", model);
    if (options?.live === true) args.push("--live");
    return this.managerJson(args, ndyForecastSchema);
  }

  /**
   * Clears an account's persisted per-family rate-limit records. Only called
   * after a live probe disproves the record — clearing a record the provider
   * still enforces would just move the failure back to mid-session. Takes
   * the 0-based ndy store index; the CLI flag counts from 1.
   */
  async resetRateLimits(ndyIndex: number): Promise<NdyRateLimitReset> {
    if (!Number.isInteger(ndyIndex) || ndyIndex < 0) {
      throw new NdyContractError(`invalid ndy account index: ${ndyIndex}`);
    }
    return this.managerJson(
      ["rotation", "reset-rate-limits", "--account", String(ndyIndex + 1), "--json"],
      ndyRateLimitResetSchema,
    );
  }

  async historyList(): Promise<NdyHistoryList> {
    return this.managerJson(["history", "list", "--json"], ndyHistoryListSchema);
  }

  async historyShow(sessionId: string): Promise<NdyHistoryDetail> {
    if (sessionId.length === 0 || sessionId.startsWith("-")) {
      throw new NdyContractError(`invalid session id: '${sessionId}'`);
    }
    return this.managerJson(
      ["history", "show", sessionId, "--json"],
      ndyHistoryDetailSchema,
    );
  }

  /**
   * Launches the forced-account Codex wrapper with inherited stdio. The
   * selector must be a provider account ID or (uniquely resolving) email —
   * never a bare index. Fail-hard: if ndy cannot honor the pin it exits 1
   * without launching Codex, and callers must never retry unpinned
   * (handoff §22).
   */
  async runCodex(options: {
    accountSelector: string;
    args: string[];
    cwd?: string;
  }): Promise<InteractiveResult> {
    assertNoForcedAccountOverride(options.args);
    const argv = [
      this.installation.bins.codexWrapper,
      "--account",
      options.accountSelector,
      ...options.args,
    ];
    return runInteractive(process.execPath, argv, {
      env: this.env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  }

  private async managerJson<Schema extends z.ZodType>(
    args: string[],
    schema: Schema,
  ): Promise<z.infer<Schema>> {
    const result = await runCapture(
      process.execPath,
      [this.installation.bins.manager, ...args],
      { env: this.env, timeoutMs: MANAGER_JSON_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new NdyCommandError(
        args.join(" "),
        result.exitCode,
        result.stderr.slice(-STDERR_TAIL_CHARS).trim(),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new NdyContractError(
        `codex-multi-auth ${args.join(" ")} did not emit valid JSON on stdout`,
      );
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.code}`)
        .join("; ");
      throw new NdyContractError(
        `codex-multi-auth ${args.join(" ")} JSON failed contract validation (${issues})`,
      );
    }
    return validated.data;
  }
}

/**
 * Standard adapter construction: package-local resolution (or the
 * CODEX_SWAP_NDY_PACKAGE_DIR override, intended for tests) plus the exact
 * version guard.
 */
export function createNdyAdapter(
  env: NodeJS.ProcessEnv = process.env,
): NdyAdapter {
  const packageDir = env["CODEX_SWAP_NDY_PACKAGE_DIR"];
  const installation = resolveNdyInstallation(
    packageDir !== undefined && packageDir.length > 0 ? { packageDir } : {},
  );
  assertSupportedNdyVersion(installation);
  return new NdyAdapter(installation, env);
}
