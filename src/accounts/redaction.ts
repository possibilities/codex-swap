import { deriveAccountKey } from "./identity.ts";

/**
 * The only account shape allowed to leave the storage boundary. Token
 * fields, token expiry, and anything derived from credential material stay
 * behind src/ndy/store-reader.ts and (later) the credential broker.
 */
export interface RedactedNdyAccount {
  accountKey: string;
  recordId?: string;
  providerAccountId?: string;
  email?: string;
  label?: string;
  enabled: boolean;
  addedAt?: number;
  lastUsed?: number;
  authInvalidatedAt?: number;
  authInvalidationErrorCode?: string;
  coolingDownUntil?: number;
  cooldownReason?: string;
  /**
   * ndy's per-family rate-limit records: prompt-family key → epoch ms when
   * the recorded limit ends. Written by ndy from provider responses and
   * preemptive quota marks; advisory (a record can outlive the real limit).
   */
  rateLimitResetTimes?: Record<string, number>;
  /** True when the stored record currently has a refresh token. */
  hasCredentials: boolean;
  /**
   * Keyed fingerprint of the refresh token (HMAC with the local install
   * secret) for rotation detection. Database-only — never public JSON.
   */
  lineageHmac?: string;
  /** Position in ndy's array at read time — display metadata only. */
  ndyIndex: number;
}

/** Fields we accept from ndy's AccountMetadataV3; everything else is dropped. */
export interface NdyAccountRecordLike {
  recordId?: string | undefined;
  accountId?: string | undefined;
  accountLabel?: string | undefined;
  email?: string | undefined;
  refreshToken?: string | undefined;
  enabled?: boolean | undefined;
  addedAt?: number | undefined;
  lastUsed?: number | undefined;
  authInvalidatedAt?: number | undefined;
  authInvalidationErrorCode?: string | undefined;
  coolingDownUntil?: number | undefined;
  cooldownReason?: string | undefined;
  rateLimitResetTimes?: Record<string, unknown> | undefined;
}

export function redactNdyAccount(
  record: NdyAccountRecordLike,
  ndyIndex: number,
  /** Computes the lineage HMAC in place so the raw token never leaves. */
  lineage?: (refreshToken: string) => string,
): RedactedNdyAccount {
  const hasCredentials =
    typeof record.refreshToken === "string" && record.refreshToken.length > 0;
  const redacted: RedactedNdyAccount = {
    accountKey: deriveAccountKey(record),
    enabled: record.enabled !== false,
    hasCredentials,
    ndyIndex,
  };
  if (hasCredentials && lineage !== undefined) {
    redacted.lineageHmac = lineage(record.refreshToken as string);
  }
  if (record.recordId !== undefined) redacted.recordId = record.recordId;
  if (record.accountId !== undefined) {
    redacted.providerAccountId = record.accountId;
  }
  if (record.email !== undefined) redacted.email = record.email;
  if (record.accountLabel !== undefined) redacted.label = record.accountLabel;
  if (record.addedAt !== undefined) redacted.addedAt = record.addedAt;
  if (record.lastUsed !== undefined) redacted.lastUsed = record.lastUsed;
  if (record.authInvalidatedAt !== undefined) {
    redacted.authInvalidatedAt = record.authInvalidatedAt;
  }
  if (record.authInvalidationErrorCode !== undefined) {
    redacted.authInvalidationErrorCode = record.authInvalidationErrorCode;
  }
  if (record.coolingDownUntil !== undefined) {
    redacted.coolingDownUntil = record.coolingDownUntil;
  }
  if (record.cooldownReason !== undefined) {
    redacted.cooldownReason = record.cooldownReason;
  }
  if (record.rateLimitResetTimes !== undefined) {
    const resetTimes: Record<string, number> = {};
    for (const [family, resetAt] of Object.entries(record.rateLimitResetTimes)) {
      if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
        resetTimes[family] = resetAt;
      }
    }
    if (Object.keys(resetTimes).length > 0) {
      redacted.rateLimitResetTimes = resetTimes;
    }
  }
  return redacted;
}
