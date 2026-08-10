import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Milestone 5 gate: concurrent selectors acquire different accounts when
 * capacity allows, max concurrency is enforced, leases release on child
 * exit, and a crashed parent's lease expires.
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));

const RUNNING_EXPIRY_MS = 5_000;

function usageBody(usedPercent: number): string {
  return JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  });
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const account = req.headers["chatgpt-account-id"];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(usageBody(account === "acc_1" ? 40 : 70));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface World {
  env: NodeJS.ProcessEnv;
  recordDir: string;
}

function makeWorld(serverUrl: string): World {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cs5-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cs5-home-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "cs5-rec-"));
  const accounts = [1, 2].map((n) => ({
    recordId: `r${n}`,
    accountId: `acc_${n}`,
    email: `user${n}@x.com`,
    refreshToken: `refresh-token-secret-S-${n}`,
    accessToken: `access-token-S-${n}`,
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
    addedAt: 1700000000000 + n,
    lastUsed: 1700000001000 + n,
  }));
  writeFileSync(
    path.join(multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({ version: 3, accounts, activeIndex: 0 }),
  );
  writeFileSync(
    path.join(swapHome, "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      selection: { defaultMaxConcurrent: 1 },
      leases: {
        reservationTtlMs: 30_000,
        heartbeatIntervalMs: 1_000,
        runningExpiryMs: RUNNING_EXPIRY_MS,
      },
    }),
  );
  return {
    recordDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? os.homedir(),
      CODEX_SWAP_NDY_PACKAGE_DIR: FIXTURE_DIR,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      CODEX_SWAP_HOME: swapHome,
      CODEX_HOME: path.join(swapHome, "codex-home"),
      CODEX_SWAP_UNSAFE_USAGE_BASE_URL: serverUrl,
      FAKE_NDY_RECORD_DIR: recordDir,
    },
  };
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function wrapperInvocations(
  recordDir: string,
): Array<{ bin: string; argv: string[]; pid?: number }> {
  try {
    return readFileSync(path.join(recordDir, "invocations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { bin: string; argv: string[]; pid?: number })
      .filter((r) => r.bin === "codex");
  } catch {
    return [];
  }
}

interface ClaimEnvelope {
  data: {
    selection: { accountKey: string };
    lease: { leaseId: string; ownerNonce: string; accountKey: string };
  } | null;
  error: { code: string; details?: Record<string, unknown> } | null;
}

test("sequential claims distribute under capacity, then fail closed", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    await runCli(["usage", "refresh", "--json"], world.env); // seed both

    const first = await runCli(["select", "--claim", "--json"], world.env);
    assert.equal(first.code, 0, first.stderr);
    const firstEnvelope = JSON.parse(first.stdout) as ClaimEnvelope;
    assert.equal(firstEnvelope.data?.selection.accountKey, "record:r1", "best headroom first");

    const second = await runCli(["select", "--claim", "--json"], world.env);
    assert.equal(second.code, 0, second.stderr);
    const secondEnvelope = JSON.parse(second.stdout) as ClaimEnvelope;
    assert.equal(
      secondEnvelope.data?.selection.accountKey,
      "record:r2",
      "capacity moves the second claim to the alternate",
    );

    const third = await runCli(["select", "--claim", "--json"], world.env);
    assert.equal(third.code, 3, "no capacity anywhere fails closed");
    const thirdEnvelope = JSON.parse(third.stdout) as ClaimEnvelope;
    assert.equal(thirdEnvelope.error?.code, "NO_ELIGIBLE_ACCOUNT");
    const exclusions = thirdEnvelope.error?.details?.["exclusions"] as Array<{
      exclusions: string[];
    }>;
    assert.ok(
      exclusions.every((e) => e.exclusions.includes("max_concurrent_reached")),
      "exclusions explain the capacity block",
    );
  } finally {
    await server.close();
  }
});

test("concurrent claims acquire different accounts", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    await runCli(["usage", "refresh", "--json"], world.env);

    const [a, b] = await Promise.all([
      runCli(["select", "--claim", "--json"], world.env),
      runCli(["select", "--claim", "--json"], world.env),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const keyA = (JSON.parse(a.stdout) as ClaimEnvelope).data?.selection.accountKey;
    const keyB = (JSON.parse(b.stdout) as ClaimEnvelope).data?.selection.accountKey;
    assert.notEqual(keyA, keyB, "atomic claims never double-book capacity");
  } finally {
    await server.close();
  }
});

test("run --strategy claims, pins, launches, and releases with the child exit code", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    await runCli(["usage", "refresh", "--json"], world.env);

    const result = await runCli(["run", "--strategy", "best", "--", "exec", "hi"], world.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /using record:r1/);

    const calls = wrapperInvocations(world.recordDir);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ["--account", "acc_1", "exec", "hi"]);

    const leases = await runCli(["leases", "--all", "--json"], world.env);
    const envelope = JSON.parse(leases.stdout) as {
      data: {
        leases: Array<{
          accountKey: string;
          status: string;
          purpose: string;
          childExitCode: number | null;
        }>;
      };
    };
    const sessionLease = envelope.data.leases.find((l) => l.purpose === "codex-session");
    assert.equal(sessionLease?.accountKey, "record:r1");
    assert.equal(sessionLease?.status, "released");
    assert.equal(sessionLease?.childExitCode, 0);
  } finally {
    await server.close();
  }
});

test("run --claim consumes a harness-claimed lease; invalid leases fail", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    await runCli(["usage", "refresh", "--json"], world.env);

    const claim = await runCli(["select", "--claim", "--json"], world.env);
    const claimEnvelope = JSON.parse(claim.stdout) as ClaimEnvelope;
    const leaseId = claimEnvelope.data?.lease.leaseId;
    assert.ok(leaseId);

    const run = await runCli(["run", "--claim", leaseId, "--"], world.env);
    assert.equal(run.code, 0, run.stderr);
    const calls = wrapperInvocations(world.recordDir);
    assert.deepEqual(calls[0]?.argv, ["--account", "acc_1"]);

    const again = await runCli(["run", "--claim", leaseId, "--"], world.env);
    assert.equal(again.code, 1, "a consumed lease cannot be reused");
    assert.match(again.stderr, /is released/);
  } finally {
    await server.close();
  }
});

test("a crashed run's lease expires instead of blocking capacity forever", async () => {
  const server = await startServer();
  let recordDir: string | undefined;
  try {
    const world = makeWorld(server.url);
    recordDir = world.recordDir;
    await runCli(["usage", "refresh", "--json"], world.env);
    world.env["FAKE_NDY_CODEX_MODE"] = "hang";

    const child = spawn(
      process.execPath,
      [MAIN, "run", "--strategy", "best", "--"],
      { env: world.env, stdio: ["ignore", "ignore", "ignore"], detached: true },
    );
    for (let i = 0; i < 100 && wrapperInvocations(world.recordDir).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(wrapperInvocations(world.recordDir).length > 0, "session started");

    // Kill the run process itself and nothing else, so no release path can
    // run — exactly like a real crash, where the parent dies mid-flight and
    // whatever it launched is orphaned.
    //
    // Killing the whole tree instead looks equivalent and is not: on Windows
    // `taskkill /T` reaps the child first, the parent lives long enough to
    // see it exit, and it dutifully releases the lease as `failed`. That is
    // a well-behaved shutdown, which is the opposite of what this test needs.
    // The orphaned wrapper exits on its own ceiling (see the fake's hang mode).
    assert.ok(child.pid !== undefined);
    if (process.platform === "win32") {
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/F"], {
        stdio: "ignore",
      });
      assert.equal(killed.status, 0, "taskkill terminated the crashed run");
    } else {
      process.kill(child.pid, "SIGKILL");
    }

    delete world.env["FAKE_NDY_CODEX_MODE"];
    // What matters after a crash is that no release path ran: the lease is
    // either still held or has aged out on its own, never released or failed.
    // Asserting it is still *held* would be a race — `leases` expires stale
    // rows before listing, and on a slow runner the running expiry can elapse
    // between the kill and this query, which is the correct behavior arriving
    // early rather than a regression.
    const immediately = await runCli(["leases", "--all", "--json"], world.env);
    const active = JSON.parse(immediately.stdout) as {
      data: { leases: Array<{ status: string; leaseId: string }> };
    };
    assert.equal(active.data.leases.length, 1, "the crashed run's lease is still on record");
    const crashed = active.data.leases[0];
    assert.ok(
      crashed !== undefined && ["running", "reserved", "expired"].includes(crashed.status),
      `a crash must not release its lease, got ${crashed?.status}`,
    );

    await new Promise((r) => setTimeout(r, RUNNING_EXPIRY_MS + 1_200));
    const later = await runCli(["leases", "--all", "--json"], world.env);
    const finished = JSON.parse(later.stdout) as {
      data: { leases: Array<{ status: string }> };
    };
    const statuses = finished.data.leases.map((l) => l.status);
    assert.ok(statuses.includes("expired"), `expected an expired lease, got ${statuses.join(",")}`);
    const stillActive = await runCli(["leases", "--json"], world.env);
    const remaining = JSON.parse(stillActive.stdout) as {
      data: { leases: Array<{ status: string }> };
    };
    assert.equal(remaining.data.leases.length, 0, "capacity fully recovered");
  } finally {
    // The crash orphaned the wrapper on purpose; nothing else will reap it.
    for (const call of recordDir === undefined ? [] : wrapperInvocations(recordDir)) {
      if (call.pid === undefined) continue;
      try {
        process.kill(call.pid, "SIGKILL");
      } catch {
        // Already gone, which is the common case.
      }
    }
    await server.close();
  }
});
