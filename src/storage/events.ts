import type { DatabaseSync } from "node:sqlite";

/**
 * Diagnostic event log (handoff §27). Payloads must be redacted before they
 * reach this function — bounded structured fields only, never raw errors,
 * bodies, headers, or tokens.
 */
export function recordEvent(
  handle: DatabaseSync,
  occurredAtMs: number,
  eventType: string,
  accountKey?: string | null,
  payload?: Record<string, unknown>,
): void {
  handle
    .prepare(
      "INSERT INTO events (occurred_at_ms, event_type, account_key, payload_json) VALUES (?, ?, ?, ?)",
    )
    .run(
      occurredAtMs,
      eventType,
      accountKey ?? null,
      payload === undefined ? null : JSON.stringify(payload),
    );
}
