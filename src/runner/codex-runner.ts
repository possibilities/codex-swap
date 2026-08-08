import type { NdyAdapter } from "../ndy/adapter.ts";
import type {
  InvocationLease,
  InvocationLeaseStore,
} from "../selection/leases.ts";

/**
 * Launches the ndy forced-account wrapper under an invocation lease
 * (handoff §22): mark running only after spawn, heartbeat while the child
 * lives, release in every exit path. Fail-hard: a refused pin propagates
 * ndy's failure and marks the lease failed — never a retry without the pin.
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
  const { lease, leases } = options;
  if (!leases.markRunning(lease.leaseId, lease.ownerNonce)) {
    throw new Error(
      `invocation lease ${lease.leaseId} expired or was taken before launch; not starting Codex`,
    );
  }
  const heartbeatTimer = setInterval(() => {
    try {
      leases.heartbeat(lease.leaseId, lease.ownerNonce);
    } catch {
      /* a missed heartbeat lets the lease expire naturally */
    }
  }, options.heartbeatIntervalMs);
  heartbeatTimer.unref();

  try {
    const result = await options.adapter.runCodex({
      accountSelector: options.accountSelector,
      args: options.args,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    leases.release(lease.leaseId, lease.ownerNonce, {
      status: result.exitCode === 0 ? "released" : "failed",
      childExitCode: result.exitCode,
    });
    return result.exitCode;
  } catch (error) {
    leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}
