import { z } from "zod";

/**
 * Zod validation for ndy CLI JSON output (handoff §13.4). Shapes verified
 * against 2.8.3 source: status/list share one stable shape whose accounts
 * carry only a 0-based `index` and a human `label` (which normally embeds
 * the email) — no recordId/accountId — so status is used for health and
 * display, never identity. Unknown fields are tolerated but not forwarded
 * as our public contract.
 */
export const ndyStatusAccountSchema = z.looseObject({
  index: z.int().nonnegative(),
  label: z.string(),
  enabled: z.boolean(),
  current: z.boolean().nullish(),
  markers: z.array(z.string()).nullish(),
  lastUsed: z.number().nullish(),
  reason: z.string().nullish(),
});

export const ndyStatusSchema = z.looseObject({
  storagePath: z.string().nullish(),
  storageHealth: z.string().nullish(),
  accountCount: z.int().nonnegative(),
  activeIndex: z.int().nullish(),
  pinnedAccountIndex: z.int().nullish(),
  recommendedIndex: z.int().nullish(),
  recommendationReason: z.string().nullish(),
  runtimeInUseIndex: z.int().nullish(),
  accounts: z.array(ndyStatusAccountSchema),
});

export type NdyStatus = z.infer<typeof ndyStatusSchema>;

export const ndyHistorySummarySchema = z.looseObject({
  id: z.string().min(1),
  threadName: z.string(),
  updatedAt: z.string(),
  provider: z.string().nullable(),
  originator: z.string().nullable(),
  cwd: z.string().nullable(),
  path: z.string(),
});

export type NdyHistorySummary = z.infer<typeof ndyHistorySummarySchema>;

export const ndyHistoryListSchema = z.looseObject({
  count: z.int().nonnegative(),
  sessions: z.array(ndyHistorySummarySchema),
});

export type NdyHistoryList = z.infer<typeof ndyHistoryListSchema>;

export const ndyHistoryDetailSchema = ndyHistorySummarySchema.extend({
  cliVersion: z.string().nullable(),
  messages: z.array(z.string()),
});

export type NdyHistoryDetail = z.infer<typeof ndyHistoryDetailSchema>;
