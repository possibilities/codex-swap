import assert from "node:assert/strict";
import { test } from "node:test";
import type { RedactedNdyAccount } from "../../src/accounts/redaction.ts";
import { chatgptAccountIdClaim } from "../../src/accounts/credential-broker.ts";
import { matchPiIdentity, profileIdentityConsistent } from "../../src/pi/identity.ts";

function account(overrides: Partial<RedactedNdyAccount>): RedactedNdyAccount {
  return {
    accountKey: "record:r1",
    hasCredentials: true,
    enabled: true,
    ...overrides,
  } as RedactedNdyAccount;
}

const A1 = account({ accountKey: "record:r1", providerAccountId: "org-1", email: "a@x.com" });
const A2 = account({ accountKey: "record:r2", providerAccountId: "org-2", email: "b@x.com" });

test("claim decode reads the identity claim and tolerates garbage", () => {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = `${b64({ alg: "none" })}.${b64({
    "https://api.openai.com/auth": { chatgpt_account_id: "uuid-9" },
  })}.sig`;
  assert.equal(chatgptAccountIdClaim(token), "uuid-9");
  assert.equal(chatgptAccountIdClaim("not-a-jwt"), null);
  assert.equal(chatgptAccountIdClaim(`${b64({})}.${b64({})}.x`), null);
});

test("matching is claim-first with providerAccountId as fallback", () => {
  const claims = new Map<string, string | null>([
    ["record:r1", "uuid-1"],
    ["record:r2", "uuid-2"],
  ]);
  // Production shape: org-style provider ids, uuid claims.
  const matched = matchPiIdentity([A1, A2], claims, "uuid-2");
  assert.equal(matched.kind === "matched" && matched.account.accountKey, "record:r2");

  // Aligned id spaces still match through the provider id even without a
  // readable broker claim.
  const noClaims = new Map<string, string | null>([
    ["record:r1", null],
    ["record:r2", null],
  ]);
  const viaProvider = matchPiIdentity([A1, A2], noClaims, "org-1");
  assert.equal(viaProvider.kind === "matched" && viaProvider.account.accountKey, "record:r1");

  assert.equal(matchPiIdentity([A1, A2], claims, "uuid-3").kind, "unmatched");

  // One underlying identity onboarded twice cannot be pinned apart.
  const dupClaims = new Map<string, string | null>([
    ["record:r1", "uuid-x"],
    ["record:r2", "uuid-x"],
  ]);
  const ambiguous = matchPiIdentity([A1, A2], dupClaims, "uuid-x");
  assert.equal(ambiguous.kind, "ambiguous");
});

test("consistency fails only on positive mismatch", () => {
  assert.equal(profileIdentityConsistent("uuid-1", A1, "uuid-1"), true);
  assert.equal(profileIdentityConsistent("org-1", A1, null), true);
  assert.equal(profileIdentityConsistent("uuid-1", A1, null), null);
  assert.equal(profileIdentityConsistent("uuid-1", A1, "uuid-9"), false);
});
