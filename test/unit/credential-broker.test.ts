import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CredentialBroker,
  isPermanentAuthFailure,
  type BrokerDeps,
  type NdyAccountRecordShape,
  type TokenResultLike,
} from "../../src/accounts/credential-broker.ts";

const NOW = 1_000_000;

function record(overrides?: Partial<NdyAccountRecordShape>): NdyAccountRecordShape {
  return {
    recordId: "r1",
    accountId: "acc_1",
    email: "a@x.com",
    refreshToken: "rt-1",
    ...overrides,
  };
}

interface FakeWorld {
  deps: BrokerDeps;
  refreshCalls: string[];
  store: { accounts: NdyAccountRecordShape[] };
}

function fakeWorld(options: {
  accounts: NdyAccountRecordShape[];
  refresh?: (token: string) => TokenResultLike;
  onLoad?: (loadCount: number, store: { accounts: NdyAccountRecordShape[] }) => void;
}): FakeWorld {
  const store = { accounts: options.accounts };
  const refreshCalls: string[] = [];
  let loadCount = 0;
  const deps: BrokerDeps = {
    async loadAccounts() {
      loadCount += 1;
      options.onLoad?.(loadCount, store);
      return { accounts: store.accounts.map((a) => ({ ...a })) };
    },
    async mutateAccounts(handler) {
      return handler(store, async () => undefined);
    },
    async refresh(token) {
      refreshCalls.push(token);
      return (
        options.refresh?.(token) ?? {
          type: "success",
          access: `access-for-${token}`,
          refresh: `next-${token}`,
          expires: NOW + 3_600_000,
        }
      );
    },
  };
  return { deps, refreshCalls, store };
}

function broker(world: FakeWorld): CredentialBroker {
  return new CredentialBroker({
    lineage: (token) => `hmac(${token})`,
    deps: world.deps,
    clock: () => NOW,
  });
}

test("fresh cached access token is served without any refresh", async () => {
  const world = fakeWorld({
    accounts: [record({ accessToken: "cached-access", expiresAt: NOW + 600_000 })],
  });
  const lease = await broker(world).acquire("record:r1");
  assert.equal(lease.kind, "ready");
  if (lease.kind === "ready") {
    assert.equal(lease.accessToken, "cached-access");
    assert.equal(lease.refreshed, false);
    assert.equal(lease.providerAccountId, "acc_1");
    assert.equal(lease.lineageHmac, "hmac(rt-1)");
  }
  assert.deepEqual(world.refreshCalls, []);
});

test("expired token refreshes and commits the rotated pair", async () => {
  const world = fakeWorld({
    accounts: [record({ accessToken: "old", expiresAt: NOW - 1 })],
  });
  const lease = await broker(world).acquire("record:r1");
  assert.equal(lease.kind, "ready");
  if (lease.kind === "ready") {
    assert.equal(lease.accessToken, "access-for-rt-1");
    assert.equal(lease.refreshed, true);
  }
  assert.deepEqual(world.refreshCalls, ["rt-1"]);
  assert.equal(world.store.accounts[0]?.refreshToken, "next-rt-1");
  assert.equal(world.store.accounts[0]?.accessToken, "access-for-rt-1");
});

test("losing the rotation race adopts the winner instead of overwriting", async () => {
  const world = fakeWorld({
    accounts: [record({ accessToken: "old", expiresAt: NOW - 1 })],
  });
  // Simulate a concurrent winner: by the time our refresh commits, the store
  // already carries a different lineage with a fresh access token.
  const original = world.deps.mutateAccounts.bind(world.deps);
  let raced = false;
  world.deps.mutateAccounts = async (handler) => {
    if (!raced) {
      raced = true;
      world.store.accounts[0] = record({
        refreshToken: "rt-winner",
        accessToken: "winner-access",
        expiresAt: NOW + 3_600_000,
      });
    }
    return original(handler);
  };

  const lease = await broker(world).acquire("record:r1");
  assert.equal(lease.kind, "ready");
  if (lease.kind === "ready") {
    assert.equal(lease.accessToken, "winner-access", "adopted the winner");
  }
  assert.equal(
    world.store.accounts[0]?.refreshToken,
    "rt-winner",
    "our stale successor never overwrites the newer lineage",
  );
  assert.deepEqual(world.refreshCalls, ["rt-1"], "no second refresh needed");
});

test("invalid_grant rereads once, then declares relogin_required", async () => {
  const world = fakeWorld({
    accounts: [record()],
    refresh: () => ({
      type: "failed",
      reason: "http_error",
      statusCode: 400,
      message: "oauth token exchange failed: invalid_grant",
    }),
  });
  const lease = await broker(world).acquire("record:r1");
  assert.equal(lease.kind, "relogin_required");
});

test("invalid_grant with a concurrently rotated lineage retries and succeeds", async () => {
  let rotated = false;
  const world = fakeWorld({
    accounts: [record()],
    refresh: (token) =>
      token === "rt-1"
        ? {
            type: "failed",
            reason: "http_error",
            statusCode: 400,
            message: "invalid_grant",
          }
        : {
            type: "success",
            access: "rotated-access",
            refresh: "rt-2-next",
            expires: NOW + 3_600_000,
          },
    onLoad: (loadCount, store) => {
      // After the first failed refresh, another process rotates the token.
      if (loadCount >= 2 && !rotated) {
        rotated = true;
        store.accounts[0] = record({ refreshToken: "rt-2" });
      }
    },
  });
  const lease = await broker(world).acquire("record:r1");
  assert.equal(lease.kind, "ready");
  if (lease.kind === "ready") {
    assert.equal(lease.accessToken, "rotated-access");
  }
});

test("network failures are transient; missing refresh token demands relogin", async () => {
  const network = fakeWorld({
    accounts: [record()],
    refresh: () => ({ type: "failed", reason: "network_error", message: "fetch failed" }),
  });
  assert.equal((await broker(network).acquire("record:r1")).kind, "transient_failure");

  const missing = fakeWorld({ accounts: [record({ refreshToken: undefined })] });
  assert.equal((await broker(missing).acquire("record:r1")).kind, "relogin_required");

  const absent = fakeWorld({ accounts: [] });
  assert.equal((await broker(absent).acquire("record:r1")).kind, "identity_conflict");
});

test("permanent-failure predicate mirrors ndy semantics", () => {
  assert.equal(isPermanentAuthFailure({ reason: "missing_refresh" }), true);
  assert.equal(isPermanentAuthFailure({ statusCode: 401 }), true);
  assert.equal(
    isPermanentAuthFailure({ statusCode: 400, message: "INVALID_GRANT" }),
    true,
  );
  assert.equal(
    isPermanentAuthFailure({ statusCode: 400, message: "token has been revoked" }),
    true,
  );
  assert.equal(
    isPermanentAuthFailure({ statusCode: 400, message: "something else" }),
    false,
  );
  assert.equal(isPermanentAuthFailure({ reason: "network_error" }), false);
  assert.equal(isPermanentAuthFailure({ statusCode: 500 }), false);
});
