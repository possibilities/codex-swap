import { spawn } from "node:child_process";
import os from "node:os";

/**
 * Child-process helpers for ndy binaries. Always argument arrays, never a
 * shell; JSON stdout is never mixed with stderr.
 */

export interface CaptureResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const CAPTURE_LIMIT_BYTES = 16 * 1024 * 1024;

export async function runCapture(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timer: NodeJS.Timeout | undefined;

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `child process timed out after ${options.timeoutMs}ms: ${command}`,
          ),
        );
      }, options.timeoutMs);
      timer.unref();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > CAPTURE_LIMIT_BYTES) {
        truncated = true;
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length > CAPTURE_LIMIT_BYTES) {
        return;
      }
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (truncated) {
        reject(
          new Error(`child process stdout exceeded capture limit: ${command}`),
        );
        return;
      }
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

export interface InteractiveResult {
  /** Child exit code, or 128 + signal number when killed by a signal. */
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export function signalExitCode(signal: NodeJS.Signals): number {
  const signalNumber = os.constants.signals[signal];
  return 128 + (signalNumber ?? 1);
}

/**
 * Runs a long-lived server child in its own process group, and takes the
 * whole group down on the way out.
 *
 * The wrapper spawns the real Codex server as a grandchild. Under
 * `runInteractive` that grandchild can outlive us — an abrupt parent exit
 * leaves it reparented to init, still holding its listening socket, and the
 * next start finds the address permanently taken. A resident server is
 * supervised and restarts often, so "often" is the operative word.
 *
 * Signalling the negated pid reaches every descendant, so the wrapper and the
 * Codex process it launched both go. SIGINT is forwarded explicitly because a
 * detached child is no longer in the terminal's foreground group.
 */
export async function runServer(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
  },
): Promise<InteractiveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: "inherit",
      shell: false,
      detached: true,
    });

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone, or we lost the race with its exit.
      }
    };
    const forward = (signal: NodeJS.Signals) => (): void => killGroup(signal);
    const onSigint = forward("SIGINT");
    const onSigterm = forward("SIGTERM");
    const onSighup = forward("SIGHUP");
    const onExit = (): void => killGroup("SIGTERM");

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("SIGHUP", onSighup);
    process.on("exit", onExit);

    const cleanup = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGHUP", onSighup);
      process.removeListener("exit", onExit);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      // The wrapper may exit while the server it launched lingers; sweep the
      // group before reporting, so the socket is free for the next start.
      killGroup("SIGTERM");
      cleanup();
      if (exitCode !== null) {
        resolve({ exitCode, signal });
      } else if (signal !== null) {
        resolve({ exitCode: signalExitCode(signal), signal });
      } else {
        resolve({ exitCode: 1, signal: null });
      }
    });
  });
}

/**
 * Runs a child with fully inherited stdio (login prompts, Codex sessions).
 * SIGINT is left to the child (the whole foreground process group receives
 * it; we stay alive to report the child's exit). SIGTERM and SIGHUP are
 * forwarded.
 */
export async function runInteractive(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
  },
): Promise<InteractiveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: "inherit",
      shell: false,
    });

    const onSigint = (): void => {
      /* child receives it via the foreground process group */
    };
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const onSigterm = forward("SIGTERM");
    const onSighup = forward("SIGHUP");

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("SIGHUP", onSighup);

    const cleanup = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGHUP", onSighup);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      if (exitCode !== null) {
        resolve({ exitCode, signal });
      } else if (signal !== null) {
        resolve({ exitCode: signalExitCode(signal), signal });
      } else {
        resolve({ exitCode: 1, signal: null });
      }
    });
  });
}
