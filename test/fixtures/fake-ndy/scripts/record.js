import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Records one bin invocation so tests can assert exact argv/env fidelity. */
export function recordInvocation(bin, argv) {
  const dir = process.env.FAKE_NDY_RECORD_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const envPicks = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("CODEX_MULTI_AUTH_") ||
      key.startsWith("CODEX_AUTH_") ||
      key === "CODEX_SKIP_EMAIL_HYDRATE" ||
      key === "AGENTSURFACE_LAUNCH" ||
      key === "CODEX_HOME"
    ) {
      envPicks[key] = value;
    }
  }
  appendFileSync(
    path.join(dir, "invocations.jsonl"),
    `${JSON.stringify({ bin, argv, pid: process.pid, env: envPicks, stdinIsTTY: Boolean(process.stdin.isTTY) })}\n`,
  );
}
