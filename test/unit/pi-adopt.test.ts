import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RedactedNdyAccount } from "../../src/accounts/redaction.ts";
import { resolvePiProfiles } from "../../src/pi/adopt.ts";
import { profileDir } from "../../src/pi/paths.ts";
import {
  PROFILE_SCHEMA_VERSION,
  ensureProfileSkeleton,
  profileFor,
  readProfile,
  writeProfileMeta,
} from "../../src/pi/profiles.ts";

function makeEnv(): NodeJS.ProcessEnv {
  return {
    CODEX_SWAP_HOME: mkdtempSync(path.join(os.tmpdir(), "cs-adopt-home-")),
    PI_CODING_AGENT_DIR: mkdtempSync(path.join(os.tmpdir(), "cs-adopt-agent-")),
  };
}

function account(
  accountKey: string,
  overrides: Partial<RedactedNdyAccount> = {},
): RedactedNdyAccount {
  return {
    accountKey,
    enabled: true,
    hasCredentials: true,
    ndyIndex: 0,
    ...overrides,
  };
}

/**
 * A profile as it exists on disk: the skeleton, a pi credential carrying a
 * claim, and the link-time metadata. `claim` is what the profile's own token
 * says; `verified` defaults to it, and differs only in the drift test.
 */
function seedProfile(
  env: NodeJS.ProcessEnv,
  accountKey: string,
  claim: string,
  options: { verified?: string; email?: string } = {},
): string {
  const dir = profileDir(accountKey, env);
  ensureProfileSkeleton(dir, env);
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      "openai-codex": { type: "oauth", access: "header.payload.sig", accountId: claim },
    }),
    { mode: 0o600 },
  );
  writeProfileMeta(dir, {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    accountKey,
    providerAccountId: null,
    email: options.email ?? null,
    verifiedAccountId: options.verified ?? claim,
    linkedAtMs: 1,
  });
  return dir;
}

test("adopts an orphan whose identity matches the account's current claim", () => {
  const env = makeEnv();
  // Linked under the legacy key, then ndy started supplying a recordId.
  const legacyDir = seedProfile(env, "account:org-a", "claim-a", {
    email: "a@example.com",
  });
  const accounts = [account("record:record:a", { email: "a@example.com" })];
  const claims = new Map([["record:record:a", "claim-a"]]);

  const resolution = resolvePiProfiles(accounts, claims, env);

  assert.equal(resolution.adopted.length, 1);
  assert.equal(resolution.adopted[0]?.previousAccountKey, "account:org-a");
  assert.deepEqual(resolution.orphans, []);
  assert.equal(existsSync(legacyDir), false);

  const adoptedDir = profileDir("record:record:a", env);
  assert.equal(resolution.byKey.get("record:record:a")?.dir, adoptedDir);
  const profile = readProfile(adoptedDir);
  assert.equal(profile?.accountKey, "record:record:a");
  // The verification and its timestamp survive the re-key — adoption moves a
  // profile, it never re-verifies or re-credentials one.
  assert.equal(profile?.verifiedAccountId, "claim-a");
  assert.equal(profile?.linkedAtMs, 1);
  assert.equal(profileFor("record:record:a", env)?.dir, adoptedDir);
});

test("adoption falls back to the provider account id when no claim is readable", () => {
  const env = makeEnv();
  seedProfile(env, "account:org-b", "org-b");
  const accounts = [account("record:record:b", { providerAccountId: "org-b" })];

  const resolution = resolvePiProfiles(accounts, new Map([["record:record:b", null]]), env);

  assert.equal(resolution.adopted.length, 1);
  assert.equal(resolution.byKey.has("record:record:b"), true);
});

test("ambiguous orphans are refused, not guessed between", () => {
  const env = makeEnv();
  seedProfile(env, "account:org-c1", "claim-c");
  seedProfile(env, "account:org-c2", "claim-c");
  const accounts = [account("record:record:c")];

  const resolution = resolvePiProfiles(accounts, new Map([["record:record:c", "claim-c"]]), env);

  assert.deepEqual(resolution.adopted, []);
  assert.equal(resolution.byKey.has("record:record:c"), false);
  assert.equal(resolution.orphans.length, 2);
});

test("a profile whose token drifted from its verification is not adopted", () => {
  const env = makeEnv();
  // The credential now belongs to someone else than the link recorded.
  seedProfile(env, "account:org-d", "claim-other", { verified: "claim-d" });
  const accounts = [account("record:record:d")];

  const resolution = resolvePiProfiles(accounts, new Map([["record:record:d", "claim-d"]]), env);

  assert.deepEqual(resolution.adopted, []);
  assert.equal(resolution.orphans.length, 1);
});

test("an orphan without a live credential is not adopted", () => {
  const env = makeEnv();
  const dir = profileDir("account:org-e", env);
  ensureProfileSkeleton(dir, env);
  writeProfileMeta(dir, {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    accountKey: "account:org-e",
    providerAccountId: null,
    email: null,
    verifiedAccountId: "claim-e",
    linkedAtMs: 1,
  });
  const accounts = [account("record:record:e")];

  const resolution = resolvePiProfiles(accounts, new Map([["record:record:e", "claim-e"]]), env);

  assert.deepEqual(resolution.adopted, []);
  assert.equal(resolution.orphans.length, 1);
});

test("a profile another pool account still owns is never taken", () => {
  const env = makeEnv();
  // Both accounts are in the pool and both tokens carry the same claim (an
  // impossible-but-defensive case); the owner keeps its profile.
  seedProfile(env, "record:record:f", "claim-f");
  const accounts = [account("record:record:f"), account("record:record:g")];
  const claims = new Map([
    ["record:record:f", "claim-f"],
    ["record:record:g", "claim-f"],
  ]);

  const resolution = resolvePiProfiles(accounts, claims, env);

  assert.deepEqual(resolution.adopted, []);
  assert.equal(resolution.byKey.get("record:record:f")?.dir, profileDir("record:record:f", env));
  assert.equal(resolution.byKey.has("record:record:g"), false);
});

test("an already-canonical profile is left exactly where it is", () => {
  const env = makeEnv();
  const dir = seedProfile(env, "record:record:h", "claim-h");
  const accounts = [account("record:record:h")];

  const resolution = resolvePiProfiles(accounts, new Map([["record:record:h", "claim-h"]]), env);

  assert.deepEqual(resolution.adopted, []);
  assert.deepEqual(resolution.orphans, []);
  assert.equal(resolution.byKey.get("record:record:h")?.dir, dir);
});

test("an occupied destination declines the adoption", () => {
  const env = makeEnv();
  seedProfile(env, "account:org-i", "claim-i");
  // Something already sits where the account's profile belongs, without
  // readable metadata; clobbering it would destroy a credential.
  const target = profileDir("record:record:i", env);
  ensureProfileSkeleton(target, env);
  const accounts = [account("record:record:i")];

  const resolution = resolvePiProfiles(accounts, new Map([["record:record:i", "claim-i"]]), env);

  assert.deepEqual(resolution.adopted, []);
  assert.equal(resolution.orphans.length, 1);
  assert.equal(existsSync(path.join(target, "sessions")), true);
});
