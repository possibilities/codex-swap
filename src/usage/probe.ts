import type { UsageMeasurement } from "./types.ts";

/**
 * Provider-mechanism boundary per handoff §15: storage and selection never
 * know how usage was fetched. The access token enters here and must never
 * outlive the request or appear in errors.
 */
export interface UsageProbeInput {
  accountKey: string;
  /** Omitted for accounts without a workspace/account id — bearer-only. */
  providerAccountId: string | undefined;
  accessToken: string;
  signal: AbortSignal;
}

export interface UsageProbe {
  readonly kind: string;
  fetch(input: UsageProbeInput): Promise<UsageMeasurement>;
}
