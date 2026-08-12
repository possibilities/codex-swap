import { existsSync, renameSync } from "node:fs";
import type { RedactedNdyAccount } from "../accounts/redaction.ts";
import { profileDir } from "./paths.ts";
import { readPiCodexIdentity } from "./profile-auth.ts";
import {
  PROFILE_SCHEMA_VERSION,
  ensureProfileSkeleton,
  listProfiles,
  writeProfileMeta,
  type PiProfile,
  type PiProfileRecord,
} from "./profiles.ts";

/**
 * Account keys are derived, not stored (accounts/identity.ts), so a pool
 * account's key changes under it when ndy starts supplying a stronger
 * identity — an account first keyed `account:<providerAccountId>` becomes
 * `record:<recordId>` the day recordIds appear. The profile directory is
 * named from the key, so every previously linked account silently reads as
 * unlinked and its live pi grant is stranded as an orphan.
 *
 * Adoption re-keys such a profile instead of demanding another interactive
 * `/login`: the same claim comparison a link performs (ADR 0005) decides,
 * against the profile's own token rather than a fresh one. It is a rename
 * plus a rewritten profile.json — never a credential change.
 */

export interface PiAdoption {
  accountKey: string;
  email: string | null;
  /** The orphaned key the profile carried before adoption. */
  previousAccountKey: string;
  from: string;
  to: string;
}

export interface PiProfileResolution {
  /** Canonically located profiles, by the owning account's current key. */
  byKey: Map<string, PiProfileRecord>;
  /** Profiles no pool account claims, after adoption ran. */
  orphans: PiProfileRecord[];
  adopted: PiAdoption[];
}

/**
 * The identity a profile must prove to be adopted by this account: the
 * broker-derived claim, falling back to the provider account id where the
 * two id spaces align (pi/identity.ts documents why that is a fallback).
 */
function adoptionClaim(
  account: RedactedNdyAccount,
  claims: ReadonlyMap<string, string | null>,
): string | null {
  const claim = claims.get(account.accountKey) ?? null;
  if (claim !== null && claim.length > 0) return claim;
  const provider = account.providerAccountId;
  return provider !== null && provider !== undefined && provider.length > 0
    ? provider
    : null;
}

/**
 * Pairs pool accounts with their pi profiles, adopting orphans whose
 * identity is unambiguous. Fail-safe like every other identity decision
 * here: no readable claim, no live credential, a recorded verification that
 * disagrees with the profile's own token, more than one candidate, or an
 * occupied destination all decline the adoption and leave the account
 * unlinked for `codex-swap pi link` to handle.
 */
export function resolvePiProfiles(
  accounts: readonly RedactedNdyAccount[],
  claims: ReadonlyMap<string, string | null>,
  env: NodeJS.ProcessEnv = process.env,
): PiProfileResolution {
  const ownedKeys = new Set(accounts.map((account) => account.accountKey));
  const byKey = new Map<string, PiProfileRecord>();
  let unclaimed: PiProfileRecord[] = [];

  for (const record of listProfiles(env)) {
    const key = record.profile.accountKey;
    // A profile only counts as this account's when it sits where the key
    // says it should; anything else is a candidate for adoption, which is
    // what puts a misplaced directory back under its own name.
    if (ownedKeys.has(key) && record.dir === profileDir(key, env) && !byKey.has(key)) {
      byKey.set(key, record);
    } else {
      unclaimed.push(record);
    }
  }

  const adopted: PiAdoption[] = [];
  for (const account of accounts) {
    if (byKey.has(account.accountKey)) continue;
    const claim = adoptionClaim(account, claims);
    if (claim === null) continue;

    const candidates = unclaimed.filter((record) => {
      // Never take a profile another pool account still owns.
      const key = record.profile.accountKey;
      if (ownedKeys.has(key) && key !== account.accountKey) return false;
      if (record.profile.verifiedAccountId !== claim) return false;
      const identity = readPiCodexIdentity(record.dir);
      return identity.present && identity.accountId === claim;
    });
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate === undefined) continue;

    const target = profileDir(account.accountKey, env);
    if (existsSync(target)) continue;

    // Rename first: a crash before the rewrite leaves profile.json carrying
    // the old key, which reads as an orphan again and stays adoptable —
    // matching is by token claim, never by directory name.
    renameSync(candidate.dir, target);
    const profile: PiProfile = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      accountKey: account.accountKey,
      providerAccountId: account.providerAccountId ?? null,
      email: account.email ?? candidate.profile.email ?? null,
      verifiedAccountId: candidate.profile.verifiedAccountId,
      linkedAtMs: candidate.profile.linkedAtMs,
    };
    writeProfileMeta(target, profile);
    ensureProfileSkeleton(target, env);

    byKey.set(account.accountKey, { profile, dir: target });
    unclaimed = unclaimed.filter((record) => record !== candidate);
    adopted.push({
      accountKey: account.accountKey,
      email: profile.email,
      previousAccountKey: candidate.profile.accountKey,
      from: candidate.dir,
      to: target,
    });
  }

  return { byKey, orphans: unclaimed, adopted };
}
