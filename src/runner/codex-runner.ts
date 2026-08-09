import type { NdyAdapter } from "../ndy/adapter.ts";
import type {
  InvocationLease,
  InvocationLeaseStore,
} from "../selection/leases.ts";
import { runLeased } from "./leased.ts";

/**
 * Launches the ndy forced-account wrapper under an invocation lease.
 * Fail-hard: a refused pin propagates ndy's failure and marks the lease
 * failed — never a retry without the pin (handoff §22).
 */
export async function runLeasedCodex(options: {
  adapter: NdyAdapter;
  leases: InvocationLeaseStore;
  lease: InvocationLease;
  accountSelector: string;
  args: string[];
  heartbeatIntervalMs: number;
  cwd?: string | undefined;
}): Promise<number> {
  return runLeased({
    leases: options.leases,
    lease: options.lease,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    launch: () =>
      options.adapter.runCodex({
        accountSelector: options.accountSelector,
        args: options.args,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      }),
  });
}
