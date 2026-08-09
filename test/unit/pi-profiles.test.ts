import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lstatSync,
  mkdtempSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { profileDir, profileDirName, profilesRoot } from "../../src/pi/paths.ts";
import { readPiCodexIdentity } from "../../src/pi/profile-auth.ts";
import {
  PROFILE_SCHEMA_VERSION,
  ensureProfileSkeleton,
  finalizeProfile,
  listProfiles,
  profileFor,
  readProfile,
  removeProfileDir,
  writeProfileMeta,
} from "../../src/pi/profiles.ts";

function makeEnv(): NodeJS.ProcessEnv {
  return {
    CODEX_SWAP_HOME: mkdtempSync(path.join(os.tmpdir(), "cs-pi-home-")),
    PI_CODING_AGENT_DIR: mkdtempSync(path.join(os.tmpdir(), "cs-pi-agent-")),
  };
}

test("profile dir names are stable, safe, and collision-free", () => {
  const a = profileDirName("account:org-abc");
  assert.equal(a, profileDirName("account:org-abc"));
  assert.match(a, /^account-org-abc-[0-9a-f]{8}$/);
  // Same sanitized prefix, different keys — the hash keeps them apart.
  assert.notEqual(profileDirName("account:org-abc"), profileDirName("account-org-abc"));
});

test("skeleton symlinks shared children, is idempotent, keeps real files", () => {
  const env = makeEnv();
  const dir = profileDir("record:r1", env);
  ensureProfileSkeleton(dir, env);

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const child of ["sessions", "extensions", "skills", "settings.json"]) {
    const link = path.join(dir, child);
    assert.ok(lstatSync(link).isSymbolicLink(), `${child} is a symlink`);
    assert.equal(readlinkSync(link), path.join(env["PI_CODING_AGENT_DIR"]!, child));
  }

  // A real file where a link would go (pi replacing the symlink with its
  // own write) survives a re-ensure.
  const settings = path.join(dir, "settings.json");
  unlinkSync(settings);
  writeFileSync(settings, "{}", { mode: 0o600 });
  ensureProfileSkeleton(dir, env);
  assert.ok(!lstatSync(settings).isSymbolicLink(), "real file preserved");
});

test("profile meta round-trips and finalize promotes staging", () => {
  const env = makeEnv();
  const staging = path.join(profilesRoot(env), ".staging-test");
  ensureProfileSkeleton(staging, env);
  writeProfileMeta(staging, {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    accountKey: "record:r1",
    providerAccountId: "acc_1",
    email: "user1@x.com",
    verifiedAccountId: "acc_1",
    linkedAtMs: 123,
  });

  const finalDir = finalizeProfile(staging, "record:r1", env);
  assert.equal(finalDir, profileDir("record:r1", env));
  const profile = readProfile(finalDir);
  assert.ok(profile !== null);
  assert.equal(profile.accountKey, "record:r1");
  assert.equal(profile.verifiedAccountId, "acc_1");

  assert.ok(profileFor("record:r1", env) !== null);
  assert.equal(profileFor("record:r2", env), null);
  assert.equal(listProfiles(env).length, 1);
});

test("removeProfileDir refuses paths outside the profiles root", () => {
  const env = makeEnv();
  const outside = mkdtempSync(path.join(os.tmpdir(), "cs-pi-outside-"));
  assert.throws(() => removeProfileDir(outside, env), /outside the pi profiles root/);
});

test("identity reader derives claims and never requires network", () => {
  const env = makeEnv();
  const dir = profileDir("record:r9", env);
  ensureProfileSkeleton(dir, env);

  assert.deepEqual(readPiCodexIdentity(dir), { present: false });

  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = `${b64({ alg: "none" })}.${b64({
    "https://api.openai.com/auth": { chatgpt_account_id: "acc_9" },
    email: "user9@x.com",
  })}.sig`;
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      "openai-codex": { type: "oauth", refresh: "r", access, expires: 42 },
    }),
  );
  const identity = readPiCodexIdentity(dir);
  assert.ok(identity.present);
  assert.equal(identity.accountId, "acc_9");
  assert.equal(identity.email, "user9@x.com");
  assert.equal(identity.expiresAtMs, 42);

  // An api_key entry or garbage token is not a linkable credential.
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ "openai-codex": { type: "api_key", key: "k" } }),
  );
  assert.deepEqual(readPiCodexIdentity(dir), { present: false });
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ "openai-codex": { type: "oauth", access: "not-a-jwt" } }),
  );
  const unreadable = readPiCodexIdentity(dir);
  assert.ok(unreadable.present);
  assert.equal(unreadable.accountId, null);
});
