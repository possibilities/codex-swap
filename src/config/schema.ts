import { z } from "zod";

/**
 * Validated settings per handoff §26. Unknown fields are preserved on round
 * trip (the loader keeps the raw object; only known fields are validated).
 * A corrupt file produces a visible diagnostic and safe defaults — never
 * silently disabled backoff or unlimited concurrency.
 */
export const settingsSchema = z.looseObject({
  schemaVersion: z.int().default(1),
  selection: z
    .looseObject({
      strategy: z.enum(["best", "next-available"]).default("best"),
      allowUnknown: z.boolean().default(false),
      concurrencyPenaltyPercent: z.number().min(0).max(100).default(10),
      defaultMaxConcurrent: z.int().positive().nullable().default(null),
    })
    .prefault({}),
  usage: z
    .looseObject({
      serveTtlMs: z.int().min(1_000).default(180_000),
      normalTrustMaxAgeMs: z.int().min(60_000).default(3_600_000),
      rateLimitTrustMaxAgeMs: z.int().min(60_000).default(7_200_000),
      fetchClaimTtlMs: z.int().min(5_000).default(90_000),
      minimumIntervalMs: z.int().min(10_000).default(180_000),
      activeDefaultIntervalMs: z.int().min(10_000).default(180_000),
      activeMaximumIntervalMs: z.int().min(10_000).default(300_000),
      candidateDefaultIntervalMs: z.int().min(10_000).default(300_000),
      candidateMaximumIntervalMs: z.int().min(10_000).default(600_000),
      exhaustedIntervalMs: z.int().min(10_000).default(600_000),
      urgentIntervalMs: z.int().min(5_000).default(60_000),
      movementDeltaPercent: z.number().min(0.1).max(50).default(1),
      jitterFraction: z.number().min(0).max(0.5).default(0.1),
      post429MinimumIntervalMs: z.int().min(10_000).default(360_000),
      post429MaximumIntervalMs: z.int().min(60_000).default(1_800_000),
      recent429WindowMs: z.int().min(60_000).default(3_600_000),
      resetSlackMs: z.int().min(0).default(60_000),
      retryAfterCapMs: z.int().min(60_000).default(3_600_000),
      probeFallback: z.enum(["disabled", "header-probe"]).default("disabled"),
    })
    .prefault({}),
  leases: z
    .looseObject({
      reservationTtlMs: z.int().min(1_000).default(30_000),
      heartbeatIntervalMs: z.int().min(1_000).default(30_000),
      runningExpiryMs: z.int().min(5_000).default(120_000),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type UsageSettings = Settings["usage"];
export type SelectionSettings = Settings["selection"];
export type LeaseSettings = Settings["leases"];

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}
