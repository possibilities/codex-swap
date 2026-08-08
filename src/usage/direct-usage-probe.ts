import { packageInfo } from "../package-info.ts";
import { type Clock, systemClock } from "../util/clock.ts";
import { parseRetryAfterMs, UsageFetchError } from "./error-classifier.ts";
import { parseUsageResponse, UsageParseError } from "./parser.ts";
import type { UsageProbe, UsageProbeInput } from "./probe.ts";
import type { ProbeKind, UsageMeasurement } from "./types.ts";

/**
 * Direct usage endpoint probe per handoff §15.1. Two allowlisted
 * https://chatgpt.com paths, tried in order with fallback only on 404
 * (endpoint capability, not account failure). Ten-second budget, 64 KiB
 * response cap, no redirects, and redacted errors.
 */
interface Endpoint {
  url: string;
  probeKind: ProbeKind;
}

export const DEFAULT_USAGE_BASE_URL = "https://chatgpt.com";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

export class DirectUsageProbe implements UsageProbe {
  readonly kind = "direct";

  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly endpoints: readonly Endpoint[];

  constructor(options?: {
    fetchImpl?: typeof fetch;
    clock?: Clock;
    timeoutMs?: number;
    /**
     * Test/dev override (CODEX_SWAP_UNSAFE_USAGE_BASE_URL). Production is
     * always the allowlisted https://chatgpt.com origin.
     */
    baseUrl?: string;
  }) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.clock = options?.clock ?? systemClock;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const base = (options?.baseUrl ?? DEFAULT_USAGE_BASE_URL).replace(/\/$/, "");
    this.endpoints = [
      { url: `${base}/backend-api/wham/usage`, probeKind: "direct-wham" },
      { url: `${base}/api/codex/usage`, probeKind: "direct-codex" },
    ];
  }

  async fetch(input: UsageProbeInput): Promise<UsageMeasurement> {
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);

    let sawNotFound = false;
    for (const endpoint of this.endpoints) {
      const outcome = await this.fetchEndpoint(endpoint, input, signal);
      if (outcome === "not_found") {
        sawNotFound = true;
        continue;
      }
      return outcome;
    }
    if (sawNotFound) {
      throw new UsageFetchError(
        "capability",
        "usage endpoints are not available for this account or deployment (404 on all allowlisted paths)",
        { httpStatus: 404 },
      );
    }
    /* unreachable: fetchEndpoint either returns, throws, or reports 404 */
    throw new UsageFetchError("network", "no usage endpoint produced a result");
  }

  private async fetchEndpoint(
    endpoint: Endpoint,
    input: UsageProbeInput,
    signal: AbortSignal,
  ): Promise<UsageMeasurement | "not_found"> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: "application/json",
      "User-Agent": `codex-swap/${packageInfo().version}`,
    };
    if (input.providerAccountId !== undefined && input.providerAccountId.length > 0) {
      headers["ChatGPT-Account-Id"] = input.providerAccountId;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers,
      });
    } catch (error) {
      throw classifyTransportError(error, endpoint.url);
    }

    const status = response.status;
    const nowMs = this.clock();

    if (status === 404) {
      await drainQuietly(response);
      return "not_found";
    }
    if (status >= 300 && status < 400) {
      await drainQuietly(response);
      throw new UsageFetchError(
        "redirect",
        `usage endpoint attempted a redirect (${status}); refusing to follow with credentials`,
        { httpStatus: status },
      );
    }
    if (status === 401 || status === 403) {
      await drainQuietly(response);
      throw new UsageFetchError(
        "auth",
        `usage endpoint rejected authentication (${status})`,
        { httpStatus: status },
      );
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
        nowMs,
      );
      await drainQuietly(response);
      throw new UsageFetchError("rate_limited", "usage endpoint rate limited (429)", {
        httpStatus: 429,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    if (status >= 500) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
        nowMs,
      );
      await drainQuietly(response);
      throw new UsageFetchError(
        "server",
        `usage endpoint server error (${status})`,
        {
          httpStatus: status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
    if (status !== 200) {
      await drainQuietly(response);
      throw new UsageFetchError(
        "server",
        `usage endpoint returned unexpected status ${status}`,
        { httpStatus: status },
      );
    }

    const bodyText = await readBodyCapped(response, MAX_BODY_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new UsageFetchError(
        "schema",
        "usage endpoint returned a 200 with a non-JSON body",
        { httpStatus: 200 },
      );
    }
    try {
      return parseUsageResponse(body, {
        probeKind: endpoint.probeKind,
        nowMs,
      });
    } catch (error) {
      if (error instanceof UsageParseError) {
        throw new UsageFetchError("schema", error.message, { httpStatus: 200 });
      }
      throw error;
    }
  }
}

function classifyTransportError(error: unknown, url: string): UsageFetchError {
  const name = error instanceof Error ? error.name : "";
  const host = new URL(url).host;
  if (name === "TimeoutError" || name === "AbortError") {
    return new UsageFetchError("timeout", `usage request to ${host} timed out or was aborted`);
  }
  return new UsageFetchError("network", `usage request to ${host} failed before a response`);
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UsageFetchError(
        "schema",
        `usage response exceeded the ${maxBytes}-byte cap`,
        { httpStatus: response.status },
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function drainQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* best effort */
  }
}
