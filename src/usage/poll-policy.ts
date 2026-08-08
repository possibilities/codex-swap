import type { UsageSettings } from "../config/schema.ts";
import type { Rng } from "../util/rng.ts";
import type { PollPlan, UsageStateRow } from "./store.ts";
import { parseStoredMeasurement } from "./trust.ts";
import { bindingUsedPercent, type UsageMeasurement } from "./types.ts";

/**
 * Adaptive plan-after-success per handoff §18.3: movement tightens, calm
 * widens toward a role ceiling, urgent mode is bounded to an active account
 * demonstrably moving toward exhaustion, recent 429s floor and widen the
 * cadence multiplicatively, exhausted accounts stay on a bounded slow
 * cadence, and a known future reset can pull the next poll earlier. Jitter
 * keeps processes and machines out of lockstep.
 *
 * The Anthropic-tuned constants from Claude Swap were NOT copied — these
 * are conservative Codex placeholders from validated settings (§18.2).
 */
export type PollRole = "active" | "candidate";

const URGENT_NEAR_THRESHOLD_PERCENT = 75;

export interface PollPolicyInput {
  role: PollRole;
  previous: UsageStateRow;
  measurement: UsageMeasurement;
  nowMs: number;
  settings: UsageSettings;
  rng: Rng;
}

export function planAfterSuccess(input: PollPolicyInput): PollPlan {
  const { settings, role, nowMs } = input;
  const roleDefault =
    role === "active"
      ? settings.activeDefaultIntervalMs
      : settings.candidateDefaultIntervalMs;
  const roleCeiling =
    role === "active"
      ? settings.activeMaximumIntervalMs
      : settings.candidateMaximumIntervalMs;

  const previousMeasurement = parseStoredMeasurement(input.previous.lastGoodJson);
  const previousBinding =
    previousMeasurement !== null
      ? bindingUsedPercent(previousMeasurement)
      : undefined;
  const newBinding = bindingUsedPercent(input.measurement);
  const previousInterval = input.previous.pollIntervalMs ?? roleDefault;

  const comparable = previousBinding !== undefined && newBinding !== undefined;
  const moving =
    comparable &&
    Math.abs(newBinding - previousBinding) >= settings.movementDeltaPercent;
  const movingUp = moving && newBinding > previousBinding;

  let interval: number;
  if (!comparable) {
    interval = roleDefault;
  } else if (moving) {
    interval = Math.max(settings.minimumIntervalMs, Math.round(previousInterval / 2));
  } else {
    interval = Math.min(
      roleCeiling,
      Math.max(settings.minimumIntervalMs, Math.round(previousInterval * 1.5)),
    );
  }

  const recent429 =
    input.previous.last429AtMs !== null &&
    nowMs - input.previous.last429AtMs < settings.recent429WindowMs;

  if (
    role === "active" &&
    movingUp &&
    newBinding !== undefined &&
    newBinding >= URGENT_NEAR_THRESHOLD_PERCENT &&
    !recent429
  ) {
    interval = settings.urgentIntervalMs;
  }

  if (recent429) {
    interval = Math.min(
      settings.post429MaximumIntervalMs,
      Math.max(
        interval,
        Math.round(previousInterval * 1.5),
        settings.post429MinimumIntervalMs,
      ),
    );
  }

  const exhausted =
    input.measurement.limitReached === true ||
    (newBinding !== undefined && newBinding >= 100);
  if (exhausted) {
    interval = Math.max(interval, settings.exhaustedIntervalMs);
  }

  const jittered = Math.round(
    interval * (1 + settings.jitterFraction * (input.rng() * 2 - 1)),
  );
  let nextPollAtMs = nowMs + jittered;

  const earliestFutureResetMs = earliestGeneralFutureReset(
    input.measurement,
    nowMs,
  );
  if (earliestFutureResetMs !== undefined) {
    const resetPoll = earliestFutureResetMs + settings.resetSlackMs;
    if (resetPoll > nowMs && resetPoll < nextPollAtMs) {
      nextPollAtMs = resetPoll;
    }
  }

  return { nextPollAtMs, pollIntervalMs: interval };
}

function earliestGeneralFutureReset(
  measurement: UsageMeasurement,
  nowMs: number,
): number | undefined {
  const resets = measurement.windows
    .filter((w) => w.kind === "primary" || w.kind === "secondary")
    .map((w) => (w.resetsAt !== undefined ? Date.parse(w.resetsAt) : NaN))
    .filter((ms) => Number.isFinite(ms) && ms > nowMs);
  return resets.length > 0 ? Math.min(...resets) : undefined;
}
