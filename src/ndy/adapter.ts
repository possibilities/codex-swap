import type { z } from "zod";
import {
  assertSupportedNdyVersion,
  resolveNdyInstallation,
  type NdyInstallation,
} from "./bin-resolver.ts";
import { withNdyContainment } from "./environment.ts";
import {
  ndyHistoryDetailSchema,
  ndyHistoryListSchema,
  ndyStatusSchema,
  type NdyHistoryDetail,
  type NdyHistoryList,
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

/**
 * Raised when forwarded app-server args carry their own `--listen`. Codex
 * takes the last one, so a forwarded copy would move the server off the
 * socket codex-swap registered and `run --remote` would compose a dead
 * address.
 */
export class ListenConflictError extends Error {
  constructor() {
    super(
      "forwarded app-server args must not contain --listen: codex-swap registers the socket " +
        "it was given, and a second --listen would move the server off it",
    );
  }
}

export function assertNoListenOverride(args: string[]): void {
  for (const arg of args) {
    if (arg === "--listen" || arg.startsWith("--listen=")) {
      throw new ListenConflictError();
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

  /**
   * Launches a resident, account-pinned Codex app-server through the same
   * forced-account wrapper interactive launches use (handoff §39). The pin is
   * what makes the server's model calls bill the intended account: the server
   * process holds the credentials, and an attached client is only a client.
   *
   * Fail-hard exactly as `runCodex`: a refused pin propagates, never a retry
   * without it. `listenUrl` is passed through byte-for-byte — codex-swap does
   * not own the caller's socket layout.
   */
  async runAppServer(options: {
    accountSelector: string;
    listenUrl: string;
    /** Extra Codex args forwarded after the transport flags. */
    args?: string[];
    cwd?: string;
  }): Promise<InteractiveResult> {
    const extra = options.args ?? [];
    assertNoForcedAccountOverride(extra);
    assertNoListenOverride(extra);
    return this.runCodex({
      accountSelector: options.accountSelector,
      args: ["app-server", "--listen", options.listenUrl, ...extra],
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
