import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  resolveExplicitSelector,
  wrapperSelectorFor,
} from "../../accounts/selector.ts";
import { resolveAppServerCapability } from "../../appserver/capability.ts";
import { renderRateLimits } from "../../appserver/identity.ts";
import {
  clearStaleSocket,
  startIdentityProxy,
  type AppServerIdentity,
  type IdentityProxy,
} from "../../appserver/identity-proxy.ts";
import { readLoadedThreads } from "../../appserver/probe.ts";
import {
  AppServerRegistry,
  AppServerSocketBusyError,
} from "../../appserver/registry.ts";
import { createNdyAdapter } from "../../ndy/adapter.ts";
import { resolveCodexHome } from "../../ndy/environment.ts";
import { NdyStoreReader } from "../../ndy/store-reader.ts";
import { runLeased } from "../../runner/leased.ts";
import { RESIDENT_LEASE_PURPOSE } from "../../selection/leases.ts";
import { SnapshotService } from "../../snapshot/service.ts";
import { ensurePrivateDir } from "../../storage/permissions.ts";
import { dataRoot } from "../../storage/paths.ts";
import type { UsageMeasurement } from "../../usage/types.ts";
import { toIsoUtc } from "../../util/clock.ts";
import { commandIo, emitFailure, emitSuccess, splitForwardedArgs } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap app-server run --account <selector> --listen <unix-url> [--exclusive] [--parent-pid <pid>] [-- codex args...]
       codex-swap app-server check [--json] [--force]
       codex-swap app-server list [--json]
       codex-swap app-server threads --listen <unix-url> [--json]

Runs a resident Codex app-server pinned to one account. The account bound to
the server process is the one that bills every session an attached client
drives, so a shared unpinned app-server would silently defeat balancing.

  run     Foreground child; holds a heartbeated resident lease for its
          lifetime, registers its socket so 'codex-swap run' can attach, and
          forwards SIGTERM/SIGHUP. The pin is fail-hard: a refused pin exits
          rather than falling back to another account. --exclusive marks the
          registration as one session's own: attachment composition will
          never hand its socket to another launch. --parent-pid names a
          process whose death takes this server with it, so a wrapper killed
          without cleanup cannot leave an orphan.
  check   Whether the resolved codex-multi-auth can host one at all. Exit 0
          when it can, ${ExitCode.dependencyUnavailable} with a reason when it cannot. Probe this before
          supervising servers: 'app-server --help' only says the surface
          exists, not that runs will work.
  list    Live registered app-servers and the accounts they are pinned to.
  threads The threads a server currently holds, from thread/loaded/list plus
          thread/read — the only pre-turn view of a codex session anywhere.
`;

export async function runAppServerCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (
    subcommand === undefined ||
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === "help"
  ) {
    // The deployed supervisor probes for this surface with `--help` exiting 0.
    process.stdout.write(USAGE);
    return ExitCode.success;
  }

  switch (subcommand) {
    case "run":
      return runRun(rest);
    case "check":
      return runCheck(rest);
    case "list":
      return runList(rest);
    case "threads":
      return runThreads(rest);
    default:
      process.stderr.write(
        `codex-swap app-server: unknown subcommand '${subcommand}'\n${USAGE}`,
      );
      return ExitCode.usage;
  }
}

/**
 * Where the wrapper's own server listens, behind the public socket. Kept
 * short and inside the private data root: `sockaddr_un` allows about 100
 * bytes, and the caller's path has already spent most of them.
 */
export function upstreamSocketPath(
  publicPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const digest = createHash("sha256").update(publicPath).digest("hex").slice(0, 12);
  const dir = path.join(dataRoot(env), "app-servers");
  ensurePrivateDir(dir);
  return path.join(dir, `${digest}.sock`);
}

function lastGoodMeasurement(
  service: SnapshotService,
  accountKey: string,
): UsageMeasurement | null {
  const row = service.store.readAll().get(accountKey);
  if (row === undefined || row.lastGoodJson === null) return null;
  try {
    return JSON.parse(row.lastGoodJson) as UsageMeasurement;
  } catch {
    return null;
  }
}

/**
 * Waits for the wrapped server to bind before fronting it. The rotation
 * proxy takes a while to come up, so the deadline is generous; a child that
 * dies first ends the wait immediately rather than burning it.
 */
async function armIdentityProxy(options: {
  publicSocketPath: string;
  upstreamSocketPath: string;
  identity: AppServerIdentity;
  isChildAlive: () => boolean;
}): Promise<IdentityProxy | undefined> {
  const deadline = Date.now() + UPSTREAM_WAIT_MS;
  for (;;) {
    if (!options.isChildAlive()) return undefined;
    if (existsSync(options.upstreamSocketPath)) break;
    if (Date.now() > deadline) {
      throw new Error(
        `the app-server did not bind ${options.upstreamSocketPath} within ${UPSTREAM_WAIT_MS}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return startIdentityProxy({
    publicSocketPath: options.publicSocketPath,
    upstreamSocketPath: options.upstreamSocketPath,
    identity: options.identity,
    onError: (message) => process.stderr.write(`codex-swap: ${message}\n`),
  });
}

const UPSTREAM_WAIT_MS = 60_000;

/** `unix://` is the only transport codex-swap registers and composes. */
export function parseListenUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  if (raw.length === 0) return { ok: false, error: "--listen requires a value" };
  if (!raw.startsWith("unix://")) {
    return {
      ok: false,
      error: `--listen must be a unix:// URL (got '${raw}'); codex-swap registers unix sockets so 'codex-swap run' can attach to them`,
    };
  }
  const socketPath = raw.slice("unix://".length);
  if (socketPath.length === 0) {
    return {
      ok: false,
      error:
        "--listen unix:// needs an explicit socket path: codex-swap never places a server on the implicit default socket, where an unwrapped codex would attach to an arbitrary account",
    };
  }
  if (!socketPath.startsWith("/")) {
    return { ok: false, error: `--listen socket path must be absolute (got '${socketPath}')` };
  }
  // sockaddr_un is 104 bytes on macOS and 108 on Linux, including the NUL.
  if (Buffer.byteLength(socketPath) > 100) {
    return {
      ok: false,
      error: `--listen socket path is ${Buffer.byteLength(socketPath)} bytes; the platform limit is around 100`,
    };
  }
  return { ok: true, url: raw };
}

async function runRun(args: string[]): Promise<number> {
  const { own, forwarded } = splitForwardedArgs(args);
  let parsed;
  try {
    parsed = parseArgs({
      args: own,
      options: {
        account: { type: "string" },
        listen: { type: "string" },
        exclusive: { type: "boolean", default: false },
        "parent-pid": { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap app-server run: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("app-server run", false);
  const selector = parsed.values.account;
  if (selector === undefined || selector.length === 0) {
    process.stderr.write(`codex-swap app-server run: --account is required\n${USAGE}`);
    return ExitCode.usage;
  }
  const listen = parseListenUrl(parsed.values.listen ?? "");
  if (!listen.ok) {
    process.stderr.write(`codex-swap app-server run: ${listen.error}\n`);
    return ExitCode.usage;
  }
  let parentPid: number | null = null;
  if (parsed.values["parent-pid"] !== undefined) {
    parentPid = Number.parseInt(parsed.values["parent-pid"], 10);
    if (!Number.isInteger(parentPid) || parentPid <= 0) {
      process.stderr.write(
        `codex-swap app-server run: --parent-pid must be a positive integer (got '${parsed.values["parent-pid"]}')\n`,
      );
      return ExitCode.usage;
    }
  }

  let service: SnapshotService | undefined;
  try {
    const adapter = createNdyAdapter();
    service = await SnapshotService.open();
    const capability = resolveAppServerCapability({
      installation: adapter.installation,
      db: service.database,
      clock: service.now,
    });
    if (!capability.supported) {
      return emitFailure(
        io,
        {
          code: "APP_SERVER_UNSUPPORTED",
          message: capability.detail,
          retryable: false,
          details: {
            ndyVersion: capability.ndyVersion,
            packageRoot: capability.packageRoot,
          },
        },
        ExitCode.dependencyUnavailable,
      );
    }

    const reader = new NdyStoreReader();
    const accounts = await reader.loadRedactedAccounts();
    const resolution = resolveExplicitSelector(accounts, selector);
    if (resolution.kind === "not_found") {
      return emitFailure(
        io,
        {
          code: "ACCOUNT_NOT_FOUND",
          message: `no account matches selector '${selector}' (accounts: ${accounts.length})`,
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
          message: `selector '${selector}' matches multiple accounts (${resolution.candidates.join(", ")}); use the account key`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }

    const account = resolution.account;
    if (!account.hasCredentials) {
      return emitFailure(
        io,
        {
          code: "RELOGIN_REQUIRED",
          message: `${account.accountKey} has no stored credentials; run 'codex-swap auth add'`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }
    if (account.authInvalidatedAt !== undefined) {
      return emitFailure(
        io,
        {
          code: "RELOGIN_REQUIRED",
          message: `${account.accountKey} authentication was invalidated upstream; re-login before use`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }
    const wrapperSelector = wrapperSelectorFor(account, accounts);
    if (wrapperSelector.kind !== "ok") {
      return emitFailure(
        io,
        {
          code: "IDENTITY_CONFLICT",
          message:
            wrapperSelector.kind === "ambiguous_email"
              ? `${account.accountKey} shares its email with another account and has no provider account ID; refusing an ambiguous pin`
              : `${account.accountKey} has neither a provider account ID nor an email; cannot pin it safely`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }

    await service.reconcile();
    const { lease } = service.selectAndClaim({
      strategy: service.settings.selection.strategy,
      allowUnknown: true,
      purpose: RESIDENT_LEASE_PURPOSE,
      cwd: process.cwd(),
      forcedAccountKey: account.accountKey,
    });
    if (lease === null) {
      return emitFailure(
        io,
        {
          code: "INTERNAL_ERROR",
          message: `failed to reserve a resident lease for ${account.accountKey}`,
          retryable: true,
        },
        ExitCode.failure,
      );
    }

    // The wrapper's server listens on a private socket; codex-swap owns the
    // public one the caller named, so it can answer identity questions the
    // proxied server cannot (handoff §39.4). The public path stays exactly
    // what --listen said — the consumer's bridge addresses it by that name.
    const publicPath = listen.url.slice("unix://".length);
    const upstreamPath = upstreamSocketPath(publicPath);
    const upstreamUrl = `unix://${upstreamPath}`;

    // Codex refuses to bind over a leftover socket file, and a supervisor that
    // restarts faster than the old child exits leaves exactly that. Clear it
    // only when nothing is answering there.
    try {
      await clearStaleSocket(upstreamPath);
    } catch (error) {
      return emitFailure(
        io,
        {
          code: "APP_SERVER_SOCKET_BUSY",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        ExitCode.failure,
      );
    }

    const registry = new AppServerRegistry(service.database, service.leases, service.now);
    try {
      registry.register({
        listenUrl: listen.url,
        accountKey: account.accountKey,
        leaseId: lease.leaseId,
        upstreamListenUrl: upstreamUrl,
        exclusive: parsed.values.exclusive,
      });
    } catch (error) {
      service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
      if (error instanceof AppServerSocketBusyError) {
        return emitFailure(
          io,
          { code: "APP_SERVER_SOCKET_BUSY", message: error.message, retryable: true },
          ExitCode.failure,
        );
      }
      throw error;
    }

    process.stderr.write(
      `codex-swap: app-server for ${account.accountKey} on ${listen.url} ` +
        `(codex home ${resolveCodexHome(process.env)}, codex-multi-auth ${capability.ndyVersion})\n`,
    );

    const registered = registry;
    const bound = service;
    let proxy: IdentityProxy | undefined;
    // A wrapper killed without cleanup (SIGKILL, OOM) cannot signal us; the
    // watchdog notices the orphaning and self-terminates through the same
    // signal path a clean shutdown uses, so nothing lingers on the socket.
    let watchdog: ReturnType<typeof setInterval> | undefined;
    if (parentPid !== null) {
      const watched = parentPid;
      watchdog = setInterval(() => {
        try {
          process.kill(watched, 0);
        } catch {
          process.stderr.write(
            `codex-swap: parent ${watched} is gone; shutting the app-server down\n`,
          );
          process.kill(process.pid, "SIGTERM");
          if (watchdog !== undefined) clearInterval(watchdog);
        }
      }, 5_000);
      watchdog.unref();
    }
    try {
      return await runLeased({
        leases: service.leases,
        lease,
        heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
        launch: () => {
          const child = adapter.runAppServer({
            accountSelector: wrapperSelector.selector,
            listenUrl: upstreamUrl,
            args: forwarded ?? [],
          });
          let childAlive = true;
          void child.finally(() => {
            childAlive = false;
          });
          void armIdentityProxy({
            publicSocketPath: publicPath,
            upstreamSocketPath: upstreamPath,
            identity: {
              email: account.email ?? null,
              planType: lastGoodMeasurement(bound, account.accountKey)?.planType ?? null,
              rateLimits: () =>
                renderRateLimits(lastGoodMeasurement(bound, account.accountKey)),
            },
            isChildAlive: () => childAlive,
          })
            .then((started) => {
              proxy = started ?? undefined;
              if (started !== undefined) {
                process.stderr.write(
                  `codex-swap: identity proxy serving ${listen.url}\n`,
                );
              }
            })
            .catch((error: unknown) => {
              process.stderr.write(
                `codex-swap: identity proxy did not start (${String(error)}); ` +
                  `attached TUIs will see the server's own empty identity\n`,
              );
            });
          return child;
        },
      });
    } finally {
      if (watchdog !== undefined) clearInterval(watchdog);
      await proxy?.close();
      try {
        unlinkSync(upstreamPath);
      } catch {
        /* the child normally removes it; a leftover is cleared on next start */
      }
      registered.deregister(listen.url, lease.leaseId);
    }
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

async function runCheck(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean", default: false }, force: { type: "boolean", default: false } },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap app-server check: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("app-server check", parsed.values.json);
  let service: SnapshotService | undefined;
  try {
    const adapter = createNdyAdapter();
    service = await SnapshotService.open();
    const capability = resolveAppServerCapability({
      installation: adapter.installation,
      db: service.database,
      clock: service.now,
      force: parsed.values.force,
    });
    const data = {
      supported: capability.supported,
      reason: capability.detail,
      ndyVersion: capability.ndyVersion,
      packageRoot: capability.packageRoot,
      canonicalCodexHome: resolveCodexHome(process.env),
      cached: capability.cached,
    };
    if (!capability.supported) {
      return emitFailure(
        io,
        {
          code: "APP_SERVER_UNSUPPORTED",
          message: capability.detail,
          retryable: false,
          details: data,
        },
        ExitCode.dependencyUnavailable,
      );
    }
    emitSuccess(io, data);
    if (!io.json) {
      process.stdout.write(
        `app-server surface usable: ${capability.detail}\n` +
          `codex-multi-auth ${capability.ndyVersion} at ${capability.packageRoot}\n` +
          `canonical CODEX_HOME ${data.canonicalCodexHome}\n`,
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

async function runThreads(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        listen: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap app-server threads: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return ExitCode.usage;
  }
  const listen = parseListenUrl(parsed.values.listen ?? "");
  if (!listen.ok) {
    process.stderr.write(`codex-swap app-server threads: ${listen.error}\n`);
    return ExitCode.usage;
  }

  const io = commandIo("app-server threads", parsed.values.json);
  try {
    const threads = await readLoadedThreads(listen.url.slice("unix://".length));
    emitSuccess(io, { listenUrl: listen.url, threads });
    if (!io.json) {
      if (threads.length === 0) {
        process.stdout.write("no loaded threads\n");
      } else {
        for (const thread of threads) {
          process.stdout.write(
            `${thread.id}  ${thread.cwd ?? "-"}  ${thread.name ?? "-"}\n`,
          );
        }
      }
    }
    return ExitCode.success;
  } catch (error) {
    return emitFailure(
      io,
      {
        code: "APP_SERVER_UNREACHABLE",
        message: `could not read threads from ${listen.url}: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      },
      ExitCode.failure,
    );
  }
}

async function runList(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap app-server list: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("app-server list", parsed.values.json);
  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const registry = new AppServerRegistry(service.database, service.leases, service.now);
    const live = registry.listLive().map((row) => ({
      listenUrl: row.listenUrl,
      accountKey: row.accountKey,
      leaseId: row.leaseId,
      ownerPid: row.ownerPid,
      exclusive: row.exclusive,
      startedAt: toIsoUtc(row.startedAtMs),
    }));
    emitSuccess(io, { appServers: live });
    if (!io.json) {
      if (live.length === 0) {
        process.stdout.write("no live app-servers\n");
      } else {
        for (const row of live) {
          process.stdout.write(
            `${row.listenUrl}  ${row.accountKey}  pid ${row.ownerPid ?? "?"}${row.exclusive ? "  exclusive" : ""}\n`,
          );
        }
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
