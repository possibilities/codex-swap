import { toIsoUtc } from "../util/clock.ts";

/**
 * Versioned JSON envelope per docs/handoff.md §25.1. Every non-streaming JSON
 * command emits exactly one envelope object on stdout followed by one
 * newline; logs and warnings go to stderr.
 */
export const ENVELOPE_SCHEMA_VERSION = 1;

export interface EnvelopeError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface Envelope<T> {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  command: string;
  generatedAt: string;
  data: T | null;
  error: EnvelopeError | null;
}

export function successEnvelope<T>(
  command: string,
  data: T,
  nowMs: number,
): Envelope<T> {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    command,
    generatedAt: toIsoUtc(nowMs),
    data,
    error: null,
  };
}

export function errorEnvelope(
  command: string,
  error: EnvelopeError,
  nowMs: number,
): Envelope<never> {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    command,
    generatedAt: toIsoUtc(nowMs),
    data: null,
    error,
  };
}

/** One object, one newline. */
export function renderEnvelope(envelope: Envelope<unknown>): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function emitEnvelope(envelope: Envelope<unknown>): void {
  process.stdout.write(renderEnvelope(envelope));
}
