import type { UsageMeasurement, UsageWindow } from "../usage/types.ts";

/**
 * Codex's `account/rateLimits/read` shape, rendered from a codex-swap
 * measurement (handoff §39.4).
 *
 * A server behind the rotation proxy reports whatever rate limits its
 * canonical home last cached — which belong to whichever account happened to
 * authenticate there, not to the pinned account. Answering from the usage
 * store makes an attached TUI's headroom meter tell the truth about the
 * account that is actually paying.
 */
export function renderRateLimits(
  measurement: UsageMeasurement | null,
): unknown | null {
  if (measurement === null) return null;
  const primary = measurement.windows.find((w) => w.kind === "primary");
  const secondary = measurement.windows.find((w) => w.kind === "secondary");
  const rateLimits = {
    limitId: "codex",
    limitName: null,
    primary: renderWindow(primary),
    secondary: renderWindow(secondary),
    credits: {
      hasCredits: (measurement.creditsLeft ?? 0) > 0,
      unlimited: measurement.creditsUnlimited === true,
      balance: String(measurement.creditsLeft ?? 0),
    },
    individualLimit: null,
    spendControlReached: false,
    planType: measurement.planType ?? null,
    rateLimitReachedType: measurement.limitReached === true ? "primary" : null,
  };
  // Per-lane windows (the codex-spark lane and friends) keep their own ids so
  // a client rendering per-limit meters sees the same lanes the provider did.
  const byLimitId: Record<string, unknown> = { codex: rateLimits };
  for (const window of measurement.windows) {
    if (window.meteredFeature === undefined) continue;
    byLimitId[window.meteredFeature] = {
      ...rateLimits,
      limitId: window.meteredFeature,
      limitName: window.limitName ?? null,
      primary: renderWindow(window),
      secondary: null,
    };
  }
  return {
    rateLimits,
    rateLimitsByLimitId: byLimitId,
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  };
}

function renderWindow(window: UsageWindow | undefined): unknown | null {
  if (window === undefined) return null;
  const resetsAt =
    window.resetsAt !== undefined
      ? Math.floor(Date.parse(window.resetsAt) / 1000)
      : null;
  return {
    usedPercent: window.usedPercent,
    windowDurationMins:
      window.windowSeconds !== undefined
        ? Math.round(window.windowSeconds / 60)
        : null,
    ...(resetsAt !== null && Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}
