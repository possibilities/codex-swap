import os from "node:os";
import path from "node:path";

/**
 * Data root per handoff §10. `CODEX_SWAP_HOME` overrides for tests and
 * isolated automation.
 */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CODEX_SWAP_HOME"];
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "codex-swap",
      );
    case "win32": {
      const localAppData =
        env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
      return path.join(localAppData, "codex-swap");
    }
    default: {
      const xdgData =
        env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share");
      return path.join(xdgData, "codex-swap");
    }
  }
}

export function databasePath(root: string): string {
  return path.join(root, "codex-swap.db");
}

export function installSecretPath(root: string): string {
  return path.join(root, "install-secret.bin");
}

export function settingsPath(root: string): string {
  return path.join(root, "settings.json");
}

export function logsDir(root: string): string {
  return path.join(root, "logs");
}

export function logFilePath(root: string): string {
  return path.join(logsDir(root), "codex-swap.jsonl");
}
