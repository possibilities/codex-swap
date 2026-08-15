import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RedactedNdyAccount } from "../accounts/redaction.ts";
import type { NdyAdapter } from "../ndy/adapter.ts";
import { resolveCodexHome } from "../ndy/environment.ts";
import type { NdyStoreReader } from "../ndy/store-reader.ts";
import type { AccountExclusion, FamilyBlock } from "./selector.ts";

/**
 * Family rate-limit awareness for launch-time selection (the 2026-08-15
 * incident class): ndy persists per-family rate-limit records in its store,
 * and its pinned runtime proxy refuses every request for a blocked family
 * without ever re-validating — so pinning an account whose record covers the
 * session's model family wedges the whole session behind local 503s.
 *
 * This module resolves the model a launch will actually use, maps it to
 * ndy's prompt family (through the `models` CLI contract), and turns active
 * records into selection-time exclusions. Records are treated as advisory:
 * when they would change the outcome, a live probe gets the final word, and
 * a record the probe disproves is cleared through ndy's own reset command.
 */

export interface FamilyBlockContext {
  model: string;
  family: string;
  blocks: ReadonlyMap<string, FamilyBlock>;
}

/**
 * The model this launch will request, resolved the way Codex itself will:
 * an explicit `-m`/`--model` argument (last occurrence wins, matching clap)
 * over the top-level `model` key in `$CODEX_HOME/config.toml`. Returns null
 * when neither yields one — callers then skip family filtering rather than
 * guess. Config profiles (`--profile`) are not consulted; a profile that
 * overrides the model falls back to the top-level value here.
 */
export function resolveLaunchModel(
  forwardedArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let fromArgs: string | null = null;
  for (let i = 0; i < forwardedArgs.length; i += 1) {
    const arg = forwardedArgs[i]!;
    if (arg === "--model" || arg === "-m") {
      const value = forwardedArgs[i + 1];
      if (value !== undefined && !value.startsWith("-")) fromArgs = value;
    } else if (arg.startsWith("--model=")) {
      fromArgs = arg.slice("--model=".length);
    } else if (arg.startsWith("-m=")) {
      fromArgs = arg.slice("-m=".length);
    }
  }
  if (fromArgs !== null && fromArgs.length > 0) return fromArgs;

  const configPath = path.join(resolveCodexHome(env), "config.toml");
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    // Top-level keys only: stop at the first table header.
    if (trimmed.startsWith("[")) break;
    const match = /^model\s*=\s*"([^"]+)"/.exec(trimmed);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** Accounts whose recorded limit for `family` is still in the future. */
export function computeFamilyBlocks(
  accounts: readonly RedactedNdyAccount[],
  family: string,
  nowMs: number,
): Map<string, FamilyBlock> {
  const blocks = new Map<string, FamilyBlock>();
  for (const account of accounts) {
    const untilMs = account.rateLimitResetTimes?.[family];
    if (typeof untilMs === "number" && untilMs > nowMs) {
      blocks.set(account.accountKey, { family, untilMs });
    }
  }
  return blocks;
}

/**
 * Accounts a live verification could recover: excluded for the family
 * record and nothing else. Any other exclusion means clearing the record
 * would not make the account selectable.
 */
export function healableBlockedKeys(
  exclusions: readonly AccountExclusion[],
): string[] {
  return exclusions
    .filter(
      (entry) =>
        entry.exclusions.length === 1 &&
        entry.exclusions[0] === "family_rate_limited",
    )
    .map((entry) => entry.accountKey);
}

/**
 * Builds the family-block context for one launch, or null when filtering
 * cannot or should not apply (disabled, no resolvable model, unknown
 * family). Dependency failures degrade to null with a warning: selection
 * falling back to pre-family behavior beats a launch refused because a
 * diagnostic subprocess hiccuped.
 */
export async function loadFamilyBlockContext(options: {
  adapter: NdyAdapter;
  reader: NdyStoreReader;
  forwardedArgs: readonly string[];
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  warn?: (message: string) => void;
}): Promise<FamilyBlockContext | null> {
  if (!options.enabled) return null;
  const model = resolveLaunchModel(options.forwardedArgs, options.env ?? process.env);
  if (model === null) return null;
  try {
    const family = await options.adapter.promptFamilyForModel(model);
    if (family === null) return null;
    const accounts = await options.reader.loadRedactedAccounts();
    const blocks = computeFamilyBlocks(accounts, family, options.nowMs ?? Date.now());
    return { model, family, blocks };
  } catch (error) {
    options.warn?.(
      `family filter unavailable (${error instanceof Error ? error.message : String(error)}); selecting without it`,
    );
    return null;
  }
}

export type HealOutcome =
  | { kind: "healed"; clearedAccountKeys: string[]; blocks: Map<string, FamilyBlock> }
  | { kind: "skipped"; reason: "interval" | "nothing-healable" | "verify-failed" };

interface VerifyStamp {
  lastVerifyMs: number;
}

function readStamp(stampPath: string): VerifyStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as VerifyStamp).lastVerifyMs === "number"
    ) {
      return parsed as VerifyStamp;
    }
  } catch {
    // Missing or malformed stamp reads as "never verified".
  }
  return null;
}

function writeStamp(stampPath: string, nowMs: number): void {
  mkdirSync(path.dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${JSON.stringify({ lastVerifyMs: nowMs })}\n`);
}

/**
 * Live-verifies family rate-limit records that are the sole obstacle to a
 * launch, and clears the ones the provider disproves. The stamp gate bounds
 * probe spend across repeated launches; it is stamped before probing so a
 * failing verification still consumes the interval. Returns the recomputed
 * block set after healing so the caller can re-run selection once.
 */
export async function verifyAndHealFamilyBlocks(options: {
  adapter: NdyAdapter;
  reader: NdyStoreReader;
  context: FamilyBlockContext;
  healableKeys: readonly string[];
  stampPath: string;
  minIntervalMs: number;
  nowMs?: number;
  warn?: (message: string) => void;
}): Promise<HealOutcome> {
  if (options.healableKeys.length === 0) {
    return { kind: "skipped", reason: "nothing-healable" };
  }
  const nowMs = options.nowMs ?? Date.now();
  const stamp = readStamp(options.stampPath);
  if (stamp !== null && nowMs - stamp.lastVerifyMs < options.minIntervalMs) {
    return { kind: "skipped", reason: "interval" };
  }
  writeStamp(options.stampPath, nowMs);

  let accounts: RedactedNdyAccount[];
  let liveByIndex: Map<number, number>;
  try {
    accounts = await options.reader.loadRedactedAccounts();
    const live = await options.adapter.forecast(options.context.model, { live: true });
    liveByIndex = new Map(
      live.accounts
        .filter((entry) => entry.liveQuota != null)
        .map((entry) => [entry.index, entry.liveQuota!.status]),
    );
  } catch (error) {
    options.warn?.(
      `family record verification failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return { kind: "skipped", reason: "verify-failed" };
  }

  const clearedAccountKeys: string[] = [];
  for (const accountKey of options.healableKeys) {
    const account = accounts.find((a) => a.accountKey === accountKey);
    if (account === undefined) continue;
    const liveStatus = liveByIndex.get(account.ndyIndex);
    // Only an affirmative 2xx probe disproves the record. A 429 confirms
    // it; a missing or errored probe proves nothing and clears nothing.
    if (liveStatus === undefined || liveStatus < 200 || liveStatus >= 300) continue;
    try {
      await options.adapter.resetRateLimits(account.ndyIndex);
      clearedAccountKeys.push(accountKey);
    } catch (error) {
      options.warn?.(
        `clearing stale family record for ${accountKey} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  const refreshed = await options.reader.loadRedactedAccounts();
  return {
    kind: "healed",
    clearedAccountKeys,
    blocks: computeFamilyBlocks(refreshed, options.context.family, nowMs),
  };
}
