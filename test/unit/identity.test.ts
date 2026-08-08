import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAccountKey } from "../../src/accounts/identity.ts";
import { redactNdyAccount } from "../../src/accounts/redaction.ts";
import {
  resolveExplicitSelector,
  wrapperSelectorFor,
} from "../../src/accounts/selector.ts";

test("account key prefers recordId, then accountId, then legacy hash", () => {
  assert.equal(
    deriveAccountKey({ recordId: "r1", accountId: "acc_1", email: "a@x.com" }),
    "record:r1",
  );
  assert.equal(
    deriveAccountKey({ accountId: "acc_1", email: "a@x.com" }),
    "account:acc_1",
  );
  const legacy = deriveAccountKey({ email: "A@X.com ", addedAt: 123 });
  assert.match(legacy, /^legacy:[0-9a-f]{64}$/);
  assert.equal(legacy, deriveAccountKey({ email: "a@x.com", addedAt: 123 }));
  assert.notEqual(legacy, deriveAccountKey({ email: "a@x.com", addedAt: 124 }));
});

test("same email different accountId stays distinct; index does not matter", () => {
  const a = deriveAccountKey({ accountId: "acc_1", email: "same@x.com" });
  const b = deriveAccountKey({ accountId: "acc_2", email: "same@x.com" });
  assert.notEqual(a, b);
});

test("redaction never carries token material and derives hasCredentials", () => {
  const redacted = redactNdyAccount(
    {
      recordId: "r1",
      accountId: "acc_1",
      email: "a@x.com",
      refreshToken: "super-secret-refresh",
      enabled: true,
      addedAt: 1,
      lastUsed: 2,
    },
    0,
  );
  assert.equal(redacted.accountKey, "record:r1");
  assert.equal(redacted.hasCredentials, true);
  assert.ok(!JSON.stringify(redacted).includes("super-secret-refresh"));

  const noCreds = redactNdyAccount({ recordId: "r2", addedAt: 1, lastUsed: 1 }, 1);
  assert.equal(noCreds.hasCredentials, false);
});

const ACCOUNTS = [
  redactNdyAccount(
    { recordId: "r1", accountId: "acc_1", email: "a@x.com", refreshToken: "t1", addedAt: 1, lastUsed: 1 },
    0,
  ),
  redactNdyAccount(
    { recordId: "r2", accountId: "acc_2", email: "dup@x.com", refreshToken: "t2", addedAt: 2, lastUsed: 2 },
    1,
  ),
  redactNdyAccount(
    { recordId: "r3", accountId: "acc_3", email: "DUP@x.com", refreshToken: "t3", addedAt: 3, lastUsed: 3 },
    2,
  ),
  redactNdyAccount(
    { recordId: "r4", email: "solo@x.com", refreshToken: "t4", addedAt: 4, lastUsed: 4 },
    3,
  ),
];

test("explicit selector resolves key, provider id, record id, unique email", () => {
  for (const selector of ["record:r1", "acc_1", "r1", "a@x.com", "A@X.COM"]) {
    const result = resolveExplicitSelector(ACCOUNTS, selector);
    assert.equal(result.kind, "resolved", `selector ${selector}`);
    if (result.kind === "resolved") {
      assert.equal(result.account.accountKey, "record:r1");
    }
  }
});

test("ambiguous email is rejected with candidates; unknown is not_found", () => {
  const ambiguous = resolveExplicitSelector(ACCOUNTS, "dup@x.com");
  assert.equal(ambiguous.kind, "ambiguous");
  if (ambiguous.kind === "ambiguous") {
    assert.deepEqual(ambiguous.candidates.sort(), ["record:r2", "record:r3"]);
  }
  assert.equal(resolveExplicitSelector(ACCOUNTS, "nobody@x.com").kind, "not_found");
});

test("wrapper selector prefers provider account id, allows unique email, rejects ambiguity", () => {
  const withId = wrapperSelectorFor(ACCOUNTS[0]!, ACCOUNTS);
  assert.deepEqual(withId, { kind: "ok", selector: "acc_1" });

  const soloEmail = wrapperSelectorFor(ACCOUNTS[3]!, ACCOUNTS);
  assert.deepEqual(soloEmail, { kind: "ok", selector: "solo@x.com" });

  const dupNoId = wrapperSelectorFor(
    redactNdyAccount({ recordId: "r9", email: "dup@x.com", refreshToken: "t9", addedAt: 9, lastUsed: 9 }, 4),
    ACCOUNTS,
  );
  assert.equal(dupNoId.kind, "ambiguous_email");

  const nothing = wrapperSelectorFor(
    redactNdyAccount({ recordId: "r10", refreshToken: "t10", addedAt: 10, lastUsed: 10 }, 5),
    ACCOUNTS,
  );
  assert.equal(nothing.kind, "no_selector");
});
