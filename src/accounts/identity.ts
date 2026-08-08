import { createHash } from "node:crypto";

/**
 * Stable, secret-free account keys per handoff §12 and CONTEXT.md: prefer
 * the local record identity, then the provider account identity, and only
 * as a legacy fallback a hash of normalized email plus immutable addedAt.
 * Array index and mutable labels are never identity.
 */
export interface AccountIdentitySource {
  recordId?: string | undefined;
  accountId?: string | undefined;
  email?: string | undefined;
  addedAt?: number | undefined;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function deriveAccountKey(source: AccountIdentitySource): string {
  if (source.recordId !== undefined && source.recordId.length > 0) {
    return `record:${source.recordId}`;
  }
  if (source.accountId !== undefined && source.accountId.length > 0) {
    return `account:${source.accountId}`;
  }
  const email = source.email !== undefined ? normalizeEmail(source.email) : "";
  const addedAt = source.addedAt ?? 0;
  const digest = createHash("sha256")
    .update(`${email}\0${addedAt}`)
    .digest("hex");
  return `legacy:${digest}`;
}
