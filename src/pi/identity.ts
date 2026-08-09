import type { RedactedNdyAccount } from "../accounts/redaction.ts";

/**
 * Pi identity linkage compares chatgpt_account_id claims: the profile's own
 * token claim against each pool account's broker-derived claim (ndy's
 * accountId is an org-style id for workspace logins, so it only matches as
 * a fallback when the two id spaces happen to align). Fail-safe throughout:
 * ambiguity refuses, and consistency only fails on a positive mismatch.
 */
export type PiIdentityMatch =
  | { kind: "matched"; account: RedactedNdyAccount }
  | { kind: "ambiguous"; accountKeys: string[] }
  | { kind: "unmatched" };

export function matchPiIdentity(
  accounts: readonly RedactedNdyAccount[],
  claimByAccountKey: ReadonlyMap<string, string | null>,
  piClaimId: string,
): PiIdentityMatch {
  const matches = accounts.filter(
    (account) =>
      claimByAccountKey.get(account.accountKey) === piClaimId ||
      account.providerAccountId === piClaimId,
  );
  if (matches.length === 1 && matches[0] !== undefined) {
    return { kind: "matched", account: matches[0] };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", accountKeys: matches.map((a) => a.accountKey) };
  }
  return { kind: "unmatched" };
}

/**
 * Whether a linked profile still belongs to the pool account. True when the
 * account's current claim (or provider id) equals the identity verified at
 * link time; null when no current claim is readable (missing ndy token) —
 * the link-time verification stands, nothing contradicts it; false only on
 * a positive mismatch (the account was re-onboarded to another identity).
 */
export function profileIdentityConsistent(
  verifiedAccountId: string,
  account: RedactedNdyAccount,
  currentClaimId: string | null,
): boolean | null {
  if (account.providerAccountId === verifiedAccountId) return true;
  if (currentClaimId === null) return null;
  return currentClaimId === verifiedAccountId;
}
