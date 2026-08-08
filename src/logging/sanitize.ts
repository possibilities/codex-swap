/**
 * Redaction for every logging path (handoff §27-28): tokens, JWTs,
 * authorization headers, OAuth callback URLs, long secret-looking runs, and
 * email-like strings never reach the log file. Applied to whole structured
 * records before serialization.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers / bearer prefixes, whatever follows them.
  [/\b(authorization\s*[:=]\s*)("?bearer\s+)?[^\s",;]+/gi, "$1[redacted]"],
  [/\bbearer\s+[a-z0-9._~+/=-]+/gi, "bearer [redacted]"],
  // JWTs: three dot-separated base64url segments.
  [
    /\beyJ[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\b/g,
    "[jwt]",
  ],
  // Token-ish key/value pairs in JSON or query fragments.
  [
    /("?(?:refresh|access|id)_?token"?\s*[:=]\s*)"[^"]+"/gi,
    '$1"[redacted]"',
  ],
  [/([?&](?:code|token|access_token|refresh_token|state)=)[^&\s"']+/gi, "$1[redacted]"],
  // Email-like strings.
  [/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "[email]"],
  // Long uninterrupted secret-looking runs (base64/hex >= 40 chars).
  [/\b[A-Za-z0-9+/_=-]{40,}\b/g, "[secret?]"],
];

export function sanitizeString(value: string): string {
  let result = value;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|authorization|password|credential/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeValue(inner, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
