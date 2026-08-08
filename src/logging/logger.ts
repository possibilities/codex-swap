import { appendFileSync, renameSync, statSync } from "node:fs";
import { logFilePath, logsDir } from "../storage/paths.ts";
import { ensurePrivateDir, tightenFileMode } from "../storage/permissions.ts";
import { toIsoUtc } from "../util/clock.ts";
import { sanitizeValue } from "./sanitize.ts";

/**
 * Best-effort structured JSONL log (handoff §27). Every record is sanitized
 * before serialization; logging failures never break a command. One rotation
 * generation caps disk use.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface LogRecord {
  event: string;
  level?: "info" | "warn" | "error";
  [key: string]: unknown;
}

export function logToFile(
  root: string,
  record: LogRecord,
  nowMs: number = Date.now(),
): void {
  try {
    ensurePrivateDir(logsDir(root));
    const file = logFilePath(root);
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      /* first write */
    }
    const sanitized = sanitizeValue({
      ts: toIsoUtc(nowMs),
      level: record.level ?? "info",
      ...record,
    });
    appendFileSync(file, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 });
    tightenFileMode(file);
  } catch {
    /* never let logging break a command */
  }
}
