import { chmodSync, lstatSync, mkdirSync } from "node:fs";

/**
 * Private-file discipline per handoff §10: directories 0700, files 0600
 * where POSIX permissions apply, and no symlink following for files we
 * create or open for state.
 */
const POSIX = process.platform !== "win32";

export class SymlinkRefusedError extends Error {
  constructor(target: string) {
    super(
      `refusing to use ${target}: it is a symlink; codex-swap state files must be regular files`,
    );
  }
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) {
    chmodSync(dir, 0o700);
  }
}

/** Throws if the path exists and is a symlink; missing paths are fine. */
export function refuseSymlink(target: string): void {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new SymlinkRefusedError(target);
  }
}

/** Best-effort 0600 on files that may not exist yet (e.g. -wal/-shm). */
export function tightenFileMode(target: string): void {
  if (!POSIX) return;
  try {
    chmodSync(target, 0o600);
  } catch {
    /* ENOENT before first write is expected */
  }
}
