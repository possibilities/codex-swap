import { normalizeEmail } from "./identity.ts";
import type { RedactedNdyAccount } from "./redaction.ts";

/**
 * Explicit account selector resolution per handoff §24: exact account_key,
 * then exact provider account ID, then exact record ID, then exact unique
 * email. Ambiguity is rejected, never guessed. Bare numeric ndy indexes are
 * deliberately not accepted.
 */
export type SelectorResolution =
  | { kind: "resolved"; account: RedactedNdyAccount }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: string[] };

export function resolveExplicitSelector(
  accounts: readonly RedactedNdyAccount[],
  selector: string,
): SelectorResolution {
  const byKey = accounts.filter((a) => a.accountKey === selector);
  if (byKey.length === 1 && byKey[0]) return { kind: "resolved", account: byKey[0] };

  const byProviderId = accounts.filter(
    (a) => a.providerAccountId !== undefined && a.providerAccountId === selector,
  );
  if (byProviderId.length === 1 && byProviderId[0]) {
    return { kind: "resolved", account: byProviderId[0] };
  }
  if (byProviderId.length > 1) {
    return {
      kind: "ambiguous",
      candidates: byProviderId.map((a) => a.accountKey),
    };
  }

  const byRecordId = accounts.filter(
    (a) => a.recordId !== undefined && a.recordId === selector,
  );
  if (byRecordId.length === 1 && byRecordId[0]) {
    return { kind: "resolved", account: byRecordId[0] };
  }

  const normalized = normalizeEmail(selector);
  const byEmail = accounts.filter(
    (a) => a.email !== undefined && normalizeEmail(a.email) === normalized,
  );
  if (byEmail.length === 1 && byEmail[0]) {
    return { kind: "resolved", account: byEmail[0] };
  }
  if (byEmail.length > 1) {
    return { kind: "ambiguous", candidates: byEmail.map((a) => a.accountKey) };
  }

  return { kind: "not_found" };
}

/**
 * The selector actually passed to `codex-multi-auth-codex --account`: the
 * provider account ID when present, else the account's email — but only when
 * that email is unique across the whole store, because the wrapper resolves
 * emails against its own copy and must land on the same record (§12.8-9).
 */
export type WrapperSelector =
  | { kind: "ok"; selector: string }
  | { kind: "no_selector" }
  | { kind: "ambiguous_email" };

export function wrapperSelectorFor(
  account: RedactedNdyAccount,
  allAccounts: readonly RedactedNdyAccount[],
): WrapperSelector {
  if (
    account.providerAccountId !== undefined &&
    account.providerAccountId.length > 0
  ) {
    return { kind: "ok", selector: account.providerAccountId };
  }
  if (account.email === undefined || account.email.length === 0) {
    return { kind: "no_selector" };
  }
  const normalized = normalizeEmail(account.email);
  const sharingEmail = allAccounts.filter(
    (a) => a.email !== undefined && normalizeEmail(a.email) === normalized,
  );
  if (sharingEmail.length > 1) {
    return { kind: "ambiguous_email" };
  }
  return { kind: "ok", selector: account.email };
}
