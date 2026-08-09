import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { canonicalPiAgentDir, profileDir, profilesRoot } from "./paths.ts";

export const PROFILE_SCHEMA_VERSION = 1;

/**
 * Children of the canonical pi agent dir that every profile shares via
 * symlink, so pi behaves identically under every account. Deliberately
 * dangling links are fine: a target created later in the canonical dir
 * appears in every profile, and pi writing through one lands canonically.
 * auth.json is the one per-profile real file. The sessions symlink is the
 * whole sharing mechanism for history — an explicit
 * PI_CODING_AGENT_SESSION_DIR would flatten pi's project-nested layout, so
 * it is never set.
 */
const SHARED_CHILDREN = [
  "sessions",
  "extensions",
  "skills",
  "themes",
  "prompt-templates",
  "tools",
  "settings.json",
  "models.json",
  "models-store.json",
] as const;

export interface PiProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  accountKey: string;
  providerAccountId: string | null;
  email: string | null;
  /** ChatGPT account id extracted from the profile's own token at link time. */
  verifiedAccountId: string;
  linkedAtMs: number;
}

export interface PiProfileRecord {
  profile: PiProfile;
  dir: string;
}

function profileMetaPath(dir: string): string {
  return path.join(dir, "profile.json");
}

/** Creates the directory skeleton with shared-config symlinks, 0700/0600. */
export function ensureProfileSkeleton(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const canonical = canonicalPiAgentDir(env);
  // A dangling sessions link would fail pi's mkdir-through-symlink; the
  // canonical store must exist before any profile links to it.
  mkdirSync(path.join(canonical, "sessions"), { recursive: true });
  for (const child of SHARED_CHILDREN) {
    const linkPath = path.join(dir, child);
    const target = path.join(canonical, child);
    let existing: ReturnType<typeof lstatSync> | null = null;
    try {
      existing = lstatSync(linkPath);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      // A real file/dir here (e.g. pi created one before the link existed)
      // is left alone; only refresh symlinks that point elsewhere.
      if (!existing.isSymbolicLink()) continue;
      unlinkSync(linkPath);
    }
    symlinkSync(target, linkPath);
  }
}

/** Staging dir for a link attempt whose account is not yet verified. */
export function stagingDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(profilesRoot(env), `.staging-${process.pid}`);
}

export function writeProfileMeta(dir: string, profile: PiProfile): void {
  writeFileSync(profileMetaPath(dir), `${JSON.stringify(profile, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readProfile(dir: string): PiProfile | null {
  let raw: string;
  try {
    raw = readFileSync(profileMetaPath(dir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record["schemaVersion"] !== PROFILE_SCHEMA_VERSION) return null;
    if (typeof record["accountKey"] !== "string") return null;
    if (typeof record["verifiedAccountId"] !== "string") return null;
    if (typeof record["linkedAtMs"] !== "number") return null;
    return {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      accountKey: record["accountKey"],
      providerAccountId:
        typeof record["providerAccountId"] === "string" ? record["providerAccountId"] : null,
      email: typeof record["email"] === "string" ? record["email"] : null,
      verifiedAccountId: record["verifiedAccountId"],
      linkedAtMs: record["linkedAtMs"],
    };
  } catch {
    return null;
  }
}

export function profileFor(
  accountKey: string,
  env: NodeJS.ProcessEnv = process.env,
): PiProfileRecord | null {
  const dir = profileDir(accountKey, env);
  const profile = readProfile(dir);
  if (profile === null || profile.accountKey !== accountKey) return null;
  return { profile, dir };
}

export function listProfiles(env: NodeJS.ProcessEnv = process.env): PiProfileRecord[] {
  const root = profilesRoot(env);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const records: PiProfileRecord[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = path.join(root, entry);
    const profile = readProfile(dir);
    if (profile !== null) records.push({ profile, dir });
  }
  return records;
}

/** Atomically promotes a verified staging dir to the account's profile dir. */
export function finalizeProfile(
  staging: string,
  accountKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = profileDir(accountKey, env);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return dir;
}

export function removeProfileDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const root = profilesRoot(env);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`refusing to remove '${resolved}': outside the pi profiles root`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

export function removeStaging(env: NodeJS.ProcessEnv = process.env): void {
  const dir = stagingDir(env);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
