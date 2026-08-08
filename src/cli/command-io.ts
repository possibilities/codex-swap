import { emitEnvelope, errorEnvelope, successEnvelope } from "./output.ts";
import type { EnvelopeError } from "./output.ts";
import { type Clock, systemClock } from "../util/clock.ts";

/**
 * Per-command output discipline: in --json mode exactly one envelope object
 * goes to stdout and everything else to stderr; in human mode stdout carries
 * the report and stderr the diagnostics.
 */
export interface CommandIo {
  command: string;
  json: boolean;
  clock: Clock;
}

export function commandIo(
  command: string,
  json: boolean,
  clock: Clock = systemClock,
): CommandIo {
  return { command, json, clock };
}

export function emitSuccess(io: CommandIo, data: unknown): void {
  if (io.json) {
    emitEnvelope(successEnvelope(io.command, data, io.clock()));
  }
}

/** Emits the error (envelope or stderr line) and returns the exit code. */
export function emitFailure(
  io: CommandIo,
  error: EnvelopeError,
  exitCode: number,
): number {
  if (io.json) {
    emitEnvelope(errorEnvelope(io.command, error, io.clock()));
  } else {
    process.stderr.write(`codex-swap ${io.command}: ${error.message}\n`);
  }
  return exitCode;
}

/** Splits argv at the first bare `--`; everything after is forwarded verbatim. */
export function splitForwardedArgs(args: string[]): {
  own: string[];
  forwarded: string[] | undefined;
} {
  const index = args.indexOf("--");
  if (index === -1) return { own: args, forwarded: undefined };
  return { own: args.slice(0, index), forwarded: args.slice(index + 1) };
}
