import { z } from "zod";

/**
 * Validated settings per handoff §26. Unknown fields are preserved on round
 * trip (the loader keeps the raw object; only known fields are validated).
 * A corrupt file produces a visible diagnostic and safe defaults — never
 * silently disabled backoff or unlimited concurrency.
 */
export const settingsSchema = z.looseObject({
  // Never read by codex-swap. `.catch(undefined)` keeps a malformed value
  // inert: without it a typo in an editor hint would fail validation and
  // degrade every real setting to its default.
  $schema: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      "Reserved for editor tooling: path or URL of the JSON Schema describing this file. Ignored by codex-swap.",
    ),
  schemaVersion: z
    .int()
    .default(1)
    .describe("Version of the settings file format."),
  selection: z
    .looseObject({
      strategy: z
        .enum(["best", "next-available"])
        .default("best")
        .describe(
          "Default automatic selection strategy, overridable per invocation.",
        ),
      allowUnknown: z
        .boolean()
        .default(false)
        .describe(
          "Let accounts with unknown usage be selected automatically. They score as zero headroom, so any account with known headroom still wins. Equivalent to passing --allow-unknown on every invocation.",
        ),
      concurrencyPenaltyPercent: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe(
          "Headroom percentage points subtracted from an account's score for each of its active invocation leases, so work spreads across accounts instead of stacking on one.",
        ),
      defaultMaxConcurrent: z
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe(
          "Fallback cap on simultaneous invocation leases per account, applied only to accounts with no maxConcurrent policy of their own. null means no cap.",
        ),
      familyFilter: z
        .boolean()
        .default(true)
        .describe(
          "Exclude accounts whose ndy per-family rate-limit record covers the launch's model family, so a pinned session is never wedged behind the runtime proxy's local 503s. Records are advisory: launch paths live-verify before refusing outright.",
        ),
      familyVerifyMinIntervalMs: z
        .int()
        .min(0)
        .default(300_000)
        .describe(
          "Minimum interval between live verifications of family rate-limit records. Verification runs only when the records are the sole obstacle to a launch, and clears the ones the live probe disproves.",
        ),
    })
    .prefault({})
    .describe("How an account is chosen when none is forced."),
  usage: z
    .looseObject({
      serveTtlMs: z
        .int()
        .min(1_000)
        .default(180_000)
        .describe(
          "A measurement younger than this is fresh: it is served without a network request and is decision-grade regardless of poll state.",
        ),
      normalTrustMaxAgeMs: z
        .int()
        .min(60_000)
        .default(3_600_000)
        .describe(
          "Age ceiling past which a deliberately stale measurement stops being decision-grade after a network, timeout, parse, or server failure. Also caps a Retry-After honored on a non-429 response.",
        ),
      rateLimitTrustMaxAgeMs: z
        .int()
        .min(60_000)
        .default(7_200_000)
        .describe(
          "Age ceiling that applies instead after a 429. Longer than the normal ceiling because usage only rises within a rate-limit window, so last-good stays a conservative lower bound.",
        ),
      fetchClaimTtlMs: z
        .int()
        .min(5_000)
        .default(90_000)
        .describe(
          "How long one collector's claim to fetch an account's usage lasts, keeping concurrent processes from probing the same account at once.",
        ),
      minimumIntervalMs: z
        .int()
        .min(10_000)
        .default(180_000)
        .describe(
          "Floor on the adaptive poll interval. Movement tightens pacing to this and no further.",
        ),
      activeDefaultIntervalMs: z
        .int()
        .min(10_000)
        .default(180_000)
        .describe(
          "Starting poll interval for the active (most recently selected) account.",
        ),
      activeMaximumIntervalMs: z
        .int()
        .min(10_000)
        .default(300_000)
        .describe(
          "Ceiling the active account's interval widens toward while its usage is calm.",
        ),
      candidateDefaultIntervalMs: z
        .int()
        .min(10_000)
        .default(300_000)
        .describe("Starting poll interval for candidate (non-active) accounts."),
      candidateMaximumIntervalMs: z
        .int()
        .min(10_000)
        .default(600_000)
        .describe(
          "Ceiling a candidate account's interval widens toward while its usage is calm.",
        ),
      exhaustedIntervalMs: z
        .int()
        .min(10_000)
        .default(600_000)
        .describe(
          "Floor on the poll interval for an account at or past its limit, holding exhausted accounts to a slow cadence.",
        ),
      urgentIntervalMs: z
        .int()
        .min(5_000)
        .default(60_000)
        .describe(
          "Poll interval for an active account whose binding window is past the near-exhaustion threshold and still rising. Suppressed while a 429 is recent.",
        ),
      movementDeltaPercent: z
        .number()
        .min(0.1)
        .max(50)
        .default(1)
        .describe(
          "Change in the binding window's used percentage that counts as movement. Movement halves the interval; calm widens it by half again toward the role ceiling.",
        ),
      jitterFraction: z
        .number()
        .min(0)
        .max(0.5)
        .default(0.1)
        .describe(
          "Random spread applied to poll intervals and failure backoff, plus or minus this fraction, keeping processes and machines out of lockstep.",
        ),
      post429MinimumIntervalMs: z
        .int()
        .min(10_000)
        .default(360_000)
        .describe("Floor on the poll interval while a 429 is recent."),
      post429MaximumIntervalMs: z
        .int()
        .min(60_000)
        .default(1_800_000)
        .describe("Ceiling on the poll interval while a 429 is recent."),
      recent429WindowMs: z
        .int()
        .min(60_000)
        .default(3_600_000)
        .describe(
          "How long after a 429 an account counts as recently rate-limited, applying post-429 pacing and suppressing urgent mode.",
        ),
      resetSlackMs: z
        .int()
        .min(0)
        .default(60_000)
        .describe(
          "Grace period added after a known future window reset before polling for the refreshed quota. A reset can only pull the next poll earlier, never later.",
        ),
      retryAfterCapMs: z
        .int()
        .min(60_000)
        .default(3_600_000)
        .describe(
          "Upper bound on a Retry-After honored from a 429, so a malformed value cannot park an account indefinitely.",
        ),
      probeFallback: z
        .enum(["disabled", "header-probe"])
        .default("disabled")
        .describe(
          "What to do when the direct usage endpoint is unavailable. 'disabled' returns a clear capability error; 'header-probe' falls back to a real inference request read for quota headers, which consumes quota.",
        ),
    })
    .prefault({})
    .describe("Usage freshness, trust ceilings, and adaptive poll pacing."),
  leases: z
    .looseObject({
      reservationTtlMs: z
        .int()
        .min(1_000)
        .default(30_000)
        .describe(
          "How long a reserved invocation lease stays valid before its child process is marked running.",
        ),
      heartbeatIntervalMs: z
        .int()
        .min(1_000)
        .default(30_000)
        .describe("How often a running invocation heartbeats its lease."),
      runningExpiryMs: z
        .int()
        .min(5_000)
        .default(120_000)
        .describe(
          "How long a running lease stays valid after its last heartbeat before another process may treat it as expired.",
        ),
    })
    .prefault({})
    .describe("Invocation lease lifetimes."),
});

export type Settings = z.infer<typeof settingsSchema>;
export type UsageSettings = Settings["usage"];
export type SelectionSettings = Settings["selection"];
export type LeaseSettings = Settings["leases"];

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}
