import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { applyMigrations } from "./migrations.ts";
import {
  ensurePrivateDir,
  refuseSymlink,
  tightenFileMode,
} from "./permissions.ts";
import { type Clock, systemClock } from "../util/clock.ts";

/**
 * The one database handle for a codex-swap process. WAL journal, immediate
 * transactions for every read-modify-write, busy timeout instead of retry
 * loops (handoff §10, ADR 0004).
 */
export class Database {
  readonly handle: DatabaseSync;
  readonly path: string;

  private constructor(handle: DatabaseSync, dbPath: string) {
    this.handle = handle;
    this.path = dbPath;
  }

  static open(dbPath: string, clock: Clock = systemClock): Database {
    ensurePrivateDir(path.dirname(dbPath));
    refuseSymlink(dbPath);
    const handle = new DatabaseSync(dbPath);
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("PRAGMA synchronous = NORMAL");
    handle.exec("PRAGMA foreign_keys = ON");
    handle.exec("PRAGMA busy_timeout = 5000");
    for (const suffix of ["", "-wal", "-shm"]) {
      tightenFileMode(`${dbPath}${suffix}`);
    }
    applyMigrations(handle, clock);
    return new Database(handle, dbPath);
  }

  /**
   * Runs fn inside BEGIN IMMEDIATE / COMMIT with rollback on throw. Never
   * perform network I/O inside — the reserve/fetch/record protocol exists so
   * transactions stay short.
   */
  immediate<T>(fn: () => T): T {
    this.handle.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.handle.exec("COMMIT");
      return result;
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.handle.close();
  }
}
