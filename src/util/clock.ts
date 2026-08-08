/**
 * All internal timestamps are integer Unix epoch milliseconds UTC.
 * Components take a Clock so tests can inject deterministic time.
 */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** Render an epoch-ms timestamp as an ISO 8601 UTC string for JSON output. */
export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
