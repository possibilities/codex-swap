import {
  ForcedAccountConflictError,
  NdyCommandError,
  NdyContractError,
} from "../ndy/adapter.ts";
import { NdyResolutionError, NdyVersionError } from "../ndy/bin-resolver.ts";
import type { EnvelopeError } from "./output.ts";
import { ExitCode } from "./exit-codes.ts";

export interface MappedFailure {
  error: EnvelopeError;
  exitCode: number;
}

/** Maps known error classes onto the documented envelope codes and exits. */
export function mapCommandError(error: unknown): MappedFailure {
  if (error instanceof NdyVersionError) {
    return {
      error: {
        code: "DEPENDENCY_UNSUPPORTED",
        message: error.message,
        retryable: false,
      },
      exitCode: ExitCode.dependencyUnavailable,
    };
  }
  if (error instanceof NdyResolutionError) {
    return {
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: error.message,
        retryable: false,
      },
      exitCode: ExitCode.dependencyUnavailable,
    };
  }
  if (error instanceof NdyContractError) {
    return {
      error: {
        code: "DEPENDENCY_CONTRACT_FAILED",
        message: error.message,
        retryable: false,
      },
      exitCode: ExitCode.dependencyUnavailable,
    };
  }
  if (error instanceof NdyCommandError) {
    return {
      error: {
        code: "NDY_COMMAND_FAILED",
        message: error.message,
        retryable: true,
      },
      exitCode: ExitCode.failure,
    };
  }
  if (error instanceof ForcedAccountConflictError) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        message: error.message,
        retryable: false,
      },
      exitCode: ExitCode.usage,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: { code: "INTERNAL_ERROR", message, retryable: false },
    exitCode: ExitCode.failure,
  };
}
