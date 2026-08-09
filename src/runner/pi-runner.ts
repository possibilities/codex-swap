import { runInteractive } from "../ndy/spawn.ts";
import type {
  InvocationLease,
  InvocationLeaseStore,
} from "../selection/leases.ts";
import { piBinary } from "../pi/paths.ts";
import { runLeased } from "./leased.ts";

/**
 * Launches pi pinned to one account's profile under an invocation lease.
 * The pin is the environment: PI_CODING_AGENT_DIR points at the account's
 * profile, whose auth.json is the only credential pi can see and whose
 * `sessions` symlink resolves into the canonical store — history stays
 * account-independent with pi's own project-nested layout intact
 * (PI_CODING_AGENT_SESSION_DIR is deliberately NOT set: pi treats it as a
 * flat final directory, which would break project-scoped pickers and
 * id-pattern lookups). The runner injects nothing else: forwarded args
 * reach pi verbatim.
 */
export async function runLeasedPi(options: {
  leases: InvocationLeaseStore;
  lease: InvocationLease;
  profileDir: string;
  args: string[];
  heartbeatIntervalMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string | undefined;
}): Promise<number> {
  const baseEnv = options.env ?? process.env;
  return runLeased({
    leases: options.leases,
    lease: options.lease,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    launch: () =>
      runInteractive(piBinary(baseEnv), options.args, {
        env: {
          ...baseEnv,
          PI_CODING_AGENT_DIR: options.profileDir,
        },
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      }),
  });
}
