import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectUsageProbe } from "../../src/usage/direct-usage-probe.ts";
import { UsageFetchError, parseRetryAfterMs } from "../../src/usage/error-classifier.ts";

const NOW_MS = Date.UTC(2026, 7, 8, 20, 0, 0);
const TOKEN = "sk-test-super-secret-token-value";

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

function fakeFetch(
  handler: (url: string, attempt: number) => Response | Error,
): { impl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    requests.push({
      url,
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      ),
      redirect: init?.redirect,
    });
    const result = handler(url, requests.length);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { impl, requests };
}

function probeWith(impl: typeof fetch): DirectUsageProbe {
  return new DirectUsageProbe({ fetchImpl: impl, clock: () => NOW_MS });
}

function input() {
  return {
    accountKey: "record:r1",
    providerAccountId: "acc_123",
    accessToken: TOKEN,
    signal: new AbortController().signal,
  };
}

const GOOD_BODY = JSON.stringify({
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 40,
      limit_window_seconds: 18000,
      reset_after_seconds: 600,
    },
  },
});

test("success on wham endpoint sends exact headers and no redirect following", async () => {
  const { impl, requests } = fakeFetch(() => new Response(GOOD_BODY, { status: 200 }));
  const measurement = await probeWith(impl).fetch(input());

  assert.equal(measurement.probeKind, "direct-wham");
  assert.equal(measurement.planType, "plus");
  assert.equal(measurement.fetchedAt, "2026-08-08T20:00:00.000Z");

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request?.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(request?.redirect, "manual");
  assert.equal(request?.headers["Authorization"], `Bearer ${TOKEN}`);
  assert.equal(request?.headers["ChatGPT-Account-Id"], "acc_123");
  assert.equal(request?.headers["Accept"], "application/json");
  assert.match(request?.headers["User-Agent"] ?? "", /^codex-swap\/\d+\.\d+\.\d+$/);
});

test("404 on wham falls back to the codex endpoint only", async () => {
  const { impl, requests } = fakeFetch((url) =>
    url.includes("wham")
      ? new Response("nope", { status: 404 })
      : new Response(GOOD_BODY, { status: 200 }),
  );
  const measurement = await probeWith(impl).fetch(input());
  assert.equal(measurement.probeKind, "direct-codex");
  assert.deepEqual(
    requests.map((r) => r.url),
    [
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/api/codex/usage",
    ],
  );
});

test("404 on both endpoints is a capability error", async () => {
  const { impl } = fakeFetch(() => new Response("nope", { status: 404 }));
  await assert.rejects(
    probeWith(impl).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError && error.code === "capability",
  );
});

test("401 is an auth error with no endpoint fallback and no token leakage", async () => {
  const { impl, requests } = fakeFetch(() => new Response("denied", { status: 401 }));
  await assert.rejects(
    probeWith(impl).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError &&
      error.code === "auth" &&
      error.httpStatus === 401 &&
      !error.message.includes(TOKEN),
  );
  assert.equal(requests.length, 1);
});

test("429 carries parsed Retry-After seconds", async () => {
  const { impl } = fakeFetch(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  );
  await assert.rejects(
    probeWith(impl).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError &&
      error.code === "rate_limited" &&
      error.retryAfterMs === 120_000,
  );
});

test("5xx is a server error; 302 is a refused redirect", async () => {
  const { impl: server } = fakeFetch(() => new Response("boom", { status: 503 }));
  await assert.rejects(
    probeWith(server).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError && error.code === "server" && error.httpStatus === 503,
  );

  const { impl: redirect } = fakeFetch(
    () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
  );
  await assert.rejects(
    probeWith(redirect).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError && error.code === "redirect",
  );
});

test("transport failure classifies as network without URL secrets", async () => {
  const { impl } = fakeFetch(() => new TypeError("fetch failed"));
  await assert.rejects(
    probeWith(impl).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError &&
      error.code === "network" &&
      !error.message.includes(TOKEN),
  );
});

test("timeout aborts and classifies as timeout", async () => {
  const impl = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    })) as typeof fetch;
  const probe = new DirectUsageProbe({
    fetchImpl: impl,
    clock: () => NOW_MS,
    timeoutMs: 20,
  });
  await assert.rejects(
    probe.fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError && error.code === "timeout",
  );
});

test("non-JSON 200 and oversized bodies are schema errors", async () => {
  const { impl: nonJson } = fakeFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(
    probeWith(nonJson).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError && error.code === "schema",
  );

  const huge = "x".repeat(65 * 1024);
  const { impl: oversized } = fakeFetch(() => new Response(huge, { status: 200 }));
  await assert.rejects(
    probeWith(oversized).fetch(input()),
    (error: unknown) =>
      error instanceof UsageFetchError &&
      error.code === "schema" &&
      /cap/.test(error.message),
  );
});

test("parseRetryAfterMs handles seconds, HTTP dates, and garbage", () => {
  assert.equal(parseRetryAfterMs("90", NOW_MS), 90_000);
  assert.equal(parseRetryAfterMs("0", NOW_MS), 0);
  const future = new Date(NOW_MS + 300_000).toUTCString();
  assert.equal(parseRetryAfterMs(future, NOW_MS), 300_000);
  const past = new Date(NOW_MS - 60_000).toUTCString();
  assert.equal(parseRetryAfterMs(past, NOW_MS), 0);
  assert.equal(parseRetryAfterMs("soonish", NOW_MS), undefined);
  assert.equal(parseRetryAfterMs("", NOW_MS), undefined);
  assert.equal(parseRetryAfterMs(null, NOW_MS), undefined);
});
