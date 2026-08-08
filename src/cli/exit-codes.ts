/**
 * Exit codes per docs/handoff.md §25.2.
 *
 * For `run` and `resume`, the Codex child's own exit code takes precedence
 * once the child has actually launched; the reserved codes below cover
 * preflight failures only.
 */
export const ExitCode = {
  success: 0,
  /** Operational failure, or the child failed. */
  failure: 1,
  /** Invalid arguments or incompatible JSON contract. */
  usage: 2,
  /** No eligible account / selection blocked. */
  noEligibleAccount: 3,
  /** Re-login required or identity conflict. */
  reloginRequired: 4,
  /** Dependency unavailable or unsupported ndy version. */
  dependencyUnavailable: 5,
  /** Interrupted by SIGINT where no child-specific code is available. */
  interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
