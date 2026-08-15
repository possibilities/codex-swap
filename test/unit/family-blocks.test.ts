import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RedactedNdyAccount } from "../../src/accounts/redaction.ts";
import {
  computeFamilyBlocks,
  healableBlockedKeys,
  resolveLaunchModel,
} from "../../src/selection/family-blocks.ts";

function account(
  accountKey: string,
  ndyIndex: number,
  rateLimitResetTimes?: Record<string, number>,
): RedactedNdyAccount {
  return {
    accountKey,
    enabled: true,
    hasCredentials: true,
    ndyIndex,
    ...(rateLimitResetTimes !== undefined ? { rateLimitResetTimes } : {}),
  };
}

test("resolveLaunchModel prefers forwarded args, last occurrence winning", () => {
  const env = { CODEX_HOME: "/nonexistent" };
  assert.equal(resolveLaunchModel(["--model", "gpt-5.5"], env), "gpt-5.5");
  assert.equal(resolveLaunchModel(["--model=gpt-5.5"], env), "gpt-5.5");
  assert.equal(resolveLaunchModel(["-m", "gpt-5.5"], env), "gpt-5.5");
  assert.equal(resolveLaunchModel(["-m=gpt-5.5"], env), "gpt-5.5");
  assert.equal(
    resolveLaunchModel(["--model", "gpt-5.5", "exec", "-m", "gpt-5.6-sol"], env),
    "gpt-5.6-sol",
  );
  // A flag directly after --model is not a value.
  assert.equal(resolveLaunchModel(["--model", "--json"], env), null);
});

test("resolveLaunchModel falls back to the top-level config.toml model", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  writeFileSync(
    path.join(home, "config.toml"),
    [
      'approvals_reviewer = "user"',
      'model = "gpt-5.6-sol"',
      "",
      "[profiles.other]",
      'model = "gpt-5.3-codex"',
    ].join("\n"),
  );
  assert.equal(resolveLaunchModel([], { CODEX_HOME: home }), "gpt-5.6-sol");
});

test("resolveLaunchModel ignores model keys inside tables and missing config", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  writeFileSync(
    path.join(home, "config.toml"),
    ["[profiles.other]", 'model = "gpt-5.3-codex"'].join("\n"),
  );
  assert.equal(resolveLaunchModel([], { CODEX_HOME: home }), null);

  const empty = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  mkdirSync(empty, { recursive: true });
  assert.equal(resolveLaunchModel([], { CODEX_HOME: empty }), null);
});

test("computeFamilyBlocks keeps only records for the family that are still active", () => {
  const now = Date.parse("2026-08-15T07:00:00Z");
  const blocks = computeFamilyBlocks(
    [
      account("record:blocked", 0, { "gpt-5.2": now + 60_000 }),
      account("record:expired", 1, { "gpt-5.2": now - 1 }),
      account("record:other-family", 2, { codex: now + 60_000 }),
      account("record:clean", 3),
    ],
    "gpt-5.2",
    now,
  );
  assert.deepEqual(
    [...blocks.entries()],
    [["record:blocked", { family: "gpt-5.2", untilMs: now + 60_000 }]],
  );
});

test("healableBlockedKeys returns only accounts blocked by the record alone", () => {
  assert.deepEqual(
    healableBlockedKeys([
      { accountKey: "record:only-family", exclusions: ["family_rate_limited"] },
      {
        accountKey: "record:also-exhausted",
        exclusions: ["quota_exhausted", "family_rate_limited"],
      },
      { accountKey: "record:unrelated", exclusions: ["relogin_required"] },
    ]),
    ["record:only-family"],
  );
});
