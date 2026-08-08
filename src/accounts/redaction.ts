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
  /** True when the stored record currently has a refresh token. */
  hasCredentials: boolean;
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
}

export function redactNdyAccount(
  record: NdyAccountRecordLike,
  ndyIndex: number,
): RedactedNdyAccount {
  const redacted: RedactedNdyAccount = {
    accountKey: deriveAccountKey(record),
    enabled: record.enabled !== false,
    hasCredentials:
      typeof record.refreshToken === "string" && record.refreshToken.length > 0,
    ndyIndex,
  };
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
  return redacted;
}
