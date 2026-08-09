import type {
  InvocationLease,
  InvocationLeaseStore,
} from "../selection/leases.ts";

/**
 * The invocation-lease choreography every runner shares (handoff §22):
 * mark running only after deciding to launch, heartbeat while the child
 * lives, release in every exit path. Launch failures mark the lease failed;
 * there is never a retry under the same lease.
 */
export async function runLeased(options: {
  leases: InvocationLeaseStore;
  lease: InvocationLease;
  heartbeatIntervalMs: number;
  launch: () => Promise<{ exitCode: number }>;
}): Promise<number> {
  const { lease, leases } = options;
  if (!leases.markRunning(lease.leaseId, lease.ownerNonce)) {
    throw new Error(
      `invocation lease ${lease.leaseId} expired or was taken before launch; not starting the child`,
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
    const result = await options.launch();
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
