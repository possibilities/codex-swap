import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { ensurePrivateDir } from "../storage/permissions.ts";
import { dataRoot } from "../storage/paths.ts";

/**
 * A dedicated app-server: one server, one session, one socket (handoff §39,
 * extended). `run --server` starts it as a child of the launch it fronts and
 * tears it down when the session ends, so its lifetime is the process tree's
 * — no supervisor, no reaper. The child is a full `codex-swap app-server run
 * --exclusive`, so the resident lease, the registry row, and the identity
 * proxy all come along; `--parent-pid` covers the one gap tree-lifetime
 * leaves, a wrapper killed without cleanup.
 *
 * The socket being the session's own is what makes it an identity: the
 * thread that appears on it can only be the session this launch started.
 */

const READY_DEADLINE_MS = 60_000;
const READY_POLL_MS = 100;
const STOP_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 2_000;

/** A short random socket path under the private data root. */
export function autoServerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = path.join(dataRoot(env), "app-servers");
  ensurePrivateDir(dir);
  return path.join(dir, `run-${randomBytes(5).toString("hex")}.sock`);
}

export interface DedicatedServer {
  listenUrl: string;
  stop: () => Promise<void>;
}

export class DedicatedServerError extends Error {}

async function connectOnce(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const settle = (answer: boolean): void => {
      probe.destroy();
      resolve(answer);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    probe.setTimeout(1_000, () => settle(false));
  });
}

/**
 * Starts `codex-swap app-server run --exclusive` for one account and returns
 * once its public socket answers — which the identity proxy binds only after
 * the wrapped server is up, so connect-success is the readiness signal. The
 * child's stderr is buffered, not inherited: the caller usually fronts a
 * full-screen TUI, and a server line through the same tty would corrupt it.
 */
export async function startDedicatedServer(options: {
  accountSelector: string;
  listenUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DedicatedServer> {
  const env = options.env ?? process.env;
  const socketPath = options.listenUrl.slice("unix://".length);
  let stderrTail = "";
  let exited = false;
  let exitCode: number | null = null;

  const child: ChildProcess = spawn(
    process.execPath,
    [
      process.argv[1] as string,
      "app-server",
      "run",
      "--account",
      options.accountSelector,
      "--listen",
      options.listenUrl,
      "--exclusive",
      "--parent-pid",
      String(process.pid),
    ],
    { env, stdio: ["ignore", "ignore", "pipe"], shell: false },
  );
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  child.on("error", () => {
    exited = true;
  });

  const deadline = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    if (exited) {
      throw new DedicatedServerError(
        `the dedicated app-server exited${exitCode !== null ? ` ${exitCode}` : ""} before its socket answered` +
          (stderrTail.trim().length > 0 ? `: ${stderrTail.trim()}` : ""),
      );
    }
    if (await connectOnce(socketPath)) break;
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new DedicatedServerError(
        `the dedicated app-server did not answer ${options.listenUrl} within ${READY_DEADLINE_MS}ms` +
          (stderrTail.trim().length > 0 ? ` (stderr: ${stderrTail.trim()})` : ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (exited) {
        clearTimeout(timer);
        resolve();
      }
    });
  };

  return { listenUrl: options.listenUrl, stop };
}
