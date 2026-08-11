import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectWrapperSource } from "../../src/appserver/capability.ts";
import {
  encodeServerTextFrame,
  ProxySession,
  readFrame,
  stripExtensionsHeader,
} from "../../src/appserver/identity-proxy.ts";
import { renderRateLimits } from "../../src/appserver/identity.ts";
import {
  AppServerRegistry,
  AppServerSocketBusyError,
} from "../../src/appserver/registry.ts";
import { parseListenUrl } from "../../src/cli/commands/app-server.ts";
import {
  InvocationLeaseStore,
  RESIDENT_LEASE_PURPOSE,
} from "../../src/selection/leases.ts";
import { Database } from "../../src/storage/database.ts";
import type { UsageMeasurement } from "../../src/usage/types.ts";

const LEASE_SETTINGS = {
  reservationTtlMs: 30_000,
  heartbeatIntervalMs: 30_000,
  runningExpiryMs: 120_000,
};

function world(): { db: Database; leases: InvocationLeaseStore; now: () => number } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cs-appserver-"));
  let clock = 1_000_000;
  const now = (): number => clock;
  const db = Database.open(path.join(root, "db.sqlite"), now);
  db.handle
    .prepare(
      `INSERT INTO accounts (account_key, first_seen_at_ms, last_seen_at_ms, updated_at_ms)
       VALUES ('record:a', 0, 0, 0), ('record:b', 0, 0, 0)`,
    )
    .run();
  const leases = new InvocationLeaseStore(db, LEASE_SETTINGS, now);
  return {
    db,
    leases,
    now: Object.assign(now, {
      advance: (ms: number) => {
        clock += ms;
      },
    }),
  };
}

test("capability detection separates a shadow-home wrapper from a canonical one", () => {
  const shadow = `
    if (isCodexInteractiveTuiCommand(rawArgs) || isCodexInteractiveResumeCommand(rawArgs)) {
      return createRuntimeRotationAppHelperContext(base, toml, { useCanonicalHome: true });
    }
    function isCodexAppServerCommand(rawArgs) { return true; }
  `;
  const canonical = `
    if (isCodexAppServerCommand(rawArgs)) {
      return createRuntimeRotationAppHelperContext(base, toml, {
        detachOnExit: false,
        useCanonicalHome: true,
      });
    }
  `;
  assert.equal(inspectWrapperSource(shadow).supported, false);
  // A "no" always carries a reason, so a supervisor can log why it idles.
  assert.match(inspectWrapperSource(shadow).detail, /shadow home/);
  assert.equal(inspectWrapperSource(canonical).supported, true);
});

test("parseListenUrl accepts absolute unix sockets and rejects the rest", () => {
  assert.deepEqual(parseListenUrl("unix:///tmp/a.sock"), {
    ok: true,
    url: "unix:///tmp/a.sock",
  });
  // The implicit default socket is refused: an unwrapped codex attaching there
  // would ride whichever account the server happened to be pinned to.
  assert.equal(parseListenUrl("unix://").ok, false);
  assert.equal(parseListenUrl("stdio://").ok, false);
  assert.equal(parseListenUrl("unix://relative.sock").ok, false);
  assert.equal(parseListenUrl(`unix:///${"x".repeat(120)}`).ok, false);
});

test("resident leases are counted apart from interactive ones", () => {
  const { db, leases } = world();
  db.immediate(() => {
    leases.reserveLocked({ accountKey: "record:a", purpose: RESIDENT_LEASE_PURPOSE });
    leases.reserveLocked({ accountKey: "record:a", purpose: "codex-session" });
    leases.reserveLocked({ accountKey: "record:b", purpose: RESIDENT_LEASE_PURPOSE });
  });
  const active = db.immediate(() => leases.activeCountsLocked());
  const resident = db.immediate(() => leases.residentCountsLocked());
  // A standing server must not spend the account's interactive headroom.
  assert.equal(active.get("record:a"), 1);
  assert.equal(active.get("record:b"), undefined);
  assert.equal(resident.get("record:a"), 1);
  assert.equal(resident.get("record:b"), 1);
  db.close();
});

test("registry tracks live servers and refuses to displace one", () => {
  const { db, leases, now } = world();
  const registry = new AppServerRegistry(db, leases, now);
  const lease = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: RESIDENT_LEASE_PURPOSE }),
  );
  registry.register({
    listenUrl: "unix:///tmp/a.sock",
    accountKey: "record:a",
    leaseId: lease.leaseId,
  });

  assert.equal(registry.listLive().length, 1);
  assert.equal(registry.liveForAccount("record:a")?.listenUrl, "unix:///tmp/a.sock");
  assert.equal(registry.liveForAccount("record:b"), null);

  const second = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:b", purpose: RESIDENT_LEASE_PURPOSE }),
  );
  assert.throws(
    () =>
      registry.register({
        listenUrl: "unix:///tmp/a.sock",
        accountKey: "record:b",
        leaseId: second.leaseId,
      }),
    AppServerSocketBusyError,
  );

  registry.deregister("unix:///tmp/a.sock", lease.leaseId);
  assert.equal(registry.listLive().length, 0);
  db.close();
});

test("a crashed server's registration dies with its lease, unswept", () => {
  const { db, leases, now } = world();
  const registry = new AppServerRegistry(db, leases, now);
  const lease = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: RESIDENT_LEASE_PURPOSE }),
  );
  registry.register({
    listenUrl: "unix:///tmp/a.sock",
    accountKey: "record:a",
    leaseId: lease.leaseId,
  });
  assert.equal(registry.listLive().length, 1);

  // Nobody deregisters after a crash; the lease simply stops being renewed.
  (now as unknown as { advance: (ms: number) => void }).advance(60_000);
  assert.equal(registry.listLive().length, 0);
  assert.equal(registry.liveForAccount("record:a"), null);
  db.close();
});

test("websocket frames round-trip, unmasking client frames", () => {
  const text = JSON.stringify({ id: 7, method: "account/read", params: {} });
  const encoded = encodeServerTextFrame(text);
  const frame = readFrame(encoded);
  assert.equal(frame?.opcode, 1);
  assert.equal(frame?.fin, true);
  assert.equal(frame?.payload.toString("utf8"), text);
  assert.equal(frame?.totalLength, encoded.length);
  // A partial frame yields null rather than a truncated read.
  assert.equal(readFrame(encoded.subarray(0, encoded.length - 1)), null);
});

test("the upgrade request loses its extensions so payloads stay readable", () => {
  const head =
    "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n" +
    "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n";
  const stripped = stripExtensionsHeader(head);
  assert.ok(!/permessage-deflate/.test(stripped));
  assert.match(stripped, /Upgrade: websocket/);
});

test("the proxy answers identity questions and passes everything else through", () => {
  const session = new ProxySession({
    email: "user@example.com",
    planType: "pro",
    rateLimits: () => ({ rateLimits: { limitId: "codex" } }),
  });
  assert.deepEqual(session.synthesize("getAuthStatus"), {
    authMethod: "chatgpt",
    authToken: null,
    requiresOpenaiAuth: true,
  });
  assert.deepEqual(session.synthesize("account/read"), {
    account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
    requiresOpenaiAuth: true,
  });
  // Everything the bridge actually speaks is left alone.
  assert.equal(session.synthesize("thread/loaded/list"), null);
  assert.equal(session.synthesize("turn/start"), null);
});

test("rate limits render into the shape Codex clients expect", () => {
  const measurement: UsageMeasurement = {
    schemaVersion: 1,
    probeKind: "direct-wham",
    planType: "pro",
    windows: [
      {
        kind: "primary",
        label: "weekly",
        windowSeconds: 604_800,
        usedPercent: 12,
        remainingPercent: 88,
        resetsAt: "2026-08-16T03:42:15.000Z",
      },
      {
        kind: "other",
        label: "weekly",
        windowSeconds: 604_800,
        usedPercent: 3,
        remainingPercent: 97,
        limitName: "GPT-5.3-Codex-Spark",
        meteredFeature: "codex_bengalfox",
      },
    ],
    fetchedAt: "2026-08-10T00:00:00.000Z",
  };
  const rendered = renderRateLimits(measurement) as {
    rateLimits: { primary: { usedPercent: number; windowDurationMins: number }; planType: string };
    rateLimitsByLimitId: Record<string, { limitName: string | null }>;
  };
  assert.equal(rendered.rateLimits.primary.usedPercent, 12);
  assert.equal(rendered.rateLimits.primary.windowDurationMins, 10_080);
  assert.equal(rendered.rateLimits.planType, "pro");
  // Per-lane windows keep their own ids so per-limit meters still render.
  assert.equal(
    rendered.rateLimitsByLimitId["codex_bengalfox"]?.limitName,
    "GPT-5.3-Codex-Spark",
  );
  // Unknown usage passes the server's own answer through instead of inventing one.
  assert.equal(renderRateLimits(null), null);
});

test("an exclusive registration is listed but never composed onto another launch", () => {
  const { db, leases, now } = world();
  const registry = new AppServerRegistry(db, leases, now);
  const dedicated = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: RESIDENT_LEASE_PURPOSE }),
  );
  registry.register({
    listenUrl: "unix:///tmp/run-1.sock",
    accountKey: "record:a",
    leaseId: dedicated.leaseId,
    exclusive: true,
  });

  // Discovery consumers (the bus bridge) see the socket…
  assert.equal(registry.listLive().length, 1);
  assert.equal(registry.listLive()[0]?.exclusive, true);
  // …but attachment composition never hands one session's server to another.
  assert.equal(registry.liveForAccount("record:a"), null);

  const shared = db.immediate(() =>
    leases.reserveLocked({ accountKey: "record:a", purpose: RESIDENT_LEASE_PURPOSE }),
  );
  registry.register({
    listenUrl: "unix:///tmp/shared.sock",
    accountKey: "record:a",
    leaseId: shared.leaseId,
  });
  // With both registered, only the shared one is attachable.
  assert.equal(registry.liveForAccount("record:a")?.listenUrl, "unix:///tmp/shared.sock");
  db.close();
});
