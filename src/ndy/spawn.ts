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
