import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { dataRoot } from "../storage/paths.ts";

/**
 * Pi profile layout (ADR 0001-pi-profiles): one directory per account key
 * under the codex-swap data root. Each profile is a complete
 * PI_CODING_AGENT_DIR whose auth.json holds that account's own pi OAuth
 * grant; shared pi configuration is symlinked from the canonical agent dir.
 */
export function piRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRoot(env), "pi");
}

export function profilesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(piRoot(env), "profiles");
}

/**
 * Directory names must be filesystem-safe and collision-free while account
 * keys contain `:`; a readable sanitized prefix plus a content hash gives
 * both. profile.json inside stays the authoritative reverse mapping.
 */
export function profileDirName(accountKey: string): string {
  const sanitized = accountKey.replace(/[^A-Za-z0-9._-]+/g, "-");
  const digest = createHash("sha256").update(accountKey).digest("hex").slice(0, 8);
  return `${sanitized}-${digest}`;
}

export function profileDir(
  accountKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(profilesRoot(env), profileDirName(accountKey));
}

/**
 * The user's real pi agent dir — the target of shared-config symlinks and
 * the canonical session store. A caller-level PI_CODING_AGENT_DIR is
 * honored: a user who relocated pi's home keeps one home, not two.
 */
export function canonicalPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["PI_CODING_AGENT_DIR"];
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function canonicalPiSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(canonicalPiAgentDir(env), "sessions");
}

/** The pi binary to spawn; overridable so tests never launch the real pi. */
export function piBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CODEX_SWAP_PI_BIN"];
  if (override !== undefined && override.length > 0) return override;
  return "pi";
}
