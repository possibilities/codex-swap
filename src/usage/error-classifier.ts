/**
 * Distinct failure classes per handoff §16.4: permanent auth failures are the
 * only ones that may advance dead-token strikes; 429 is the only one that
 * updates last_429_at; everything else installs plain backoff. Error
 * messages must stay redacted — no headers, no bodies, no tokens.
 */
export type UsageErrorCode =
  | "auth"
  | "rate_limited"
  | "network"
  | "timeout"
  | "server"
  | "schema"
  | "capability"
  | "redirect";

export class UsageFetchError extends Error {
  readonly code: UsageErrorCode;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: UsageErrorCode,
    message: string,
    options?: { httpStatus?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.code = code;
    this.httpStatus = options?.httpStatus;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Parses a Retry-After header value as delta-seconds or an HTTP date.
 * Malformed or negative values yield undefined — the caller must never let a
 * bad header produce infinite backoff (handoff §28.5).
 */
export function parseRetryAfterMs(
  value: string | null,
  nowMs: number,
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return seconds * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}
