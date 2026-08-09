import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The only module that reads a pi profile's auth.json. It returns derived
 * identity facts and never the credential material itself: token strings
 * must not reach envelopes, logs, errors, or the database (the same
 * discipline credential-broker.ts applies to ndy token fields).
 */

/** Identity claim pi's ChatGPT OAuth access token carries. */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const PI_CODEX_PROVIDER_ID = "openai-codex";

export type PiCodexIdentity =
  | { present: false }
  | {
      present: true;
      /** ChatGPT account/workspace id from the token claim; ndy's accountId space. */
      accountId: string | null;
      email: string | null;
      /** Epoch ms expiry of the access token; pi refreshes on its own. */
      expiresAtMs: number | null;
    };

export function readPiCodexIdentity(profileDirPath: string): PiCodexIdentity {
  let raw: string;
  try {
    raw = readFileSync(path.join(profileDirPath, "auth.json"), "utf8");
  } catch {
    return { present: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { present: false };

  const entry = (parsed as Record<string, unknown>)[PI_CODEX_PROVIDER_ID];
  if (typeof entry !== "object" || entry === null) return { present: false };
  const credential = entry as Record<string, unknown>;
  if (credential["type"] !== "oauth" || typeof credential["access"] !== "string") {
    return { present: false };
  }

  const payload = decodeJwtPayload(credential["access"]);
  const claim = payload?.[JWT_CLAIM_PATH];
  const claimRecord =
    typeof claim === "object" && claim !== null
      ? (claim as Record<string, unknown>)
      : undefined;
  const claimAccountId = claimRecord?.["chatgpt_account_id"];
  // Pi stores the extracted claim as `accountId` on the credential; prefer
  // it and fall back to decoding the claim ourselves.
  const storedAccountId = credential["accountId"];
  const accountId =
    typeof storedAccountId === "string" && storedAccountId.length > 0
      ? storedAccountId
      : typeof claimAccountId === "string" && claimAccountId.length > 0
        ? claimAccountId
        : null;
  const email = payload?.["email"];
  const expires = credential["expires"];

  return {
    present: true,
    accountId,
    email: typeof email === "string" ? email : null,
    expiresAtMs: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
  };
}

/** Claims-only decode; signature verification is the provider's job. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3 || segments[1] === undefined) return null;
  try {
    const json = Buffer.from(segments[1], "base64url").toString("utf8");
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}
