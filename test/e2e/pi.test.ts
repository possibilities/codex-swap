import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi vertical: link verifies identity against the pool, run pins the
 * profile through the environment under a released lease, strategy
 * selection only considers linked accounts, and the runner injects nothing
 * into pi's argv.
 */
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const NDY_FIXTURE = fileURLToPath(new URL("../fixtures/fake-ndy", import.meta.url));
const PI_FIXTURE = fileURLToPath(new URL("../fixtures/fake-pi/fake-pi.js", import.meta.url));

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
  piAgentDir: string;
  recordPath: string;
}

function makeWorld(serverUrl: string): World {
  const multiAuthDir = mkdtempSync(path.join(os.tmpdir(), "cspi-store-"));
  const swapHome = mkdtempSync(path.join(os.tmpdir(), "cspi-home-"));
  const piAgentDir = mkdtempSync(path.join(os.tmpdir(), "cspi-agent-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "cspi-rec-"));
  mkdirSync(path.join(piAgentDir, "sessions"), { recursive: true });
  // Mirrors production: ndy's accountId is an org-style id while the token
  // claim (what pi's grant carries too) is a distinct uuid. Linking must
  // match on claims, never on accountId equality.
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const claimToken = (n: number): string =>
    `${b64({ alg: "none" })}.${b64({
      "https://api.openai.com/auth": { chatgpt_account_id: `uuid-${n}` },
    })}.sig`;
  const accounts = [1, 2].map((n) => ({
    recordId: `r${n}`,
    accountId: `acc_${n}`,
    email: `user${n}@x.com`,
    refreshToken: `refresh-token-secret-S-${n}`,
    accessToken: claimToken(n),
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
    addedAt: 1700000000000 + n,
    lastUsed: 1700000001000 + n,
  }));
  writeFileSync(
    path.join(multiAuthDir, "openai-codex-accounts.json"),
    JSON.stringify({ version: 3, accounts, activeIndex: 0 }),
  );
  return {
    piAgentDir,
    recordPath: path.join(recordDir, "pi-invocations.jsonl"),
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? os.homedir(),
      CODEX_SWAP_NDY_PACKAGE_DIR: NDY_FIXTURE,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      CODEX_SWAP_HOME: swapHome,
      CODEX_HOME: path.join(swapHome, "codex-home"),
      CODEX_SWAP_UNSAFE_USAGE_BASE_URL: serverUrl,
      CODEX_SWAP_PI_BIN: PI_FIXTURE,
      PI_CODING_AGENT_DIR: piAgentDir,
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

interface PiInvocation {
  argv: string[];
  agentDir: string | null;
  sessionDir: string | null;
}

function piInvocations(recordPath: string): PiInvocation[] {
  try {
    return readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as PiInvocation);
  } catch {
    return [];
  }
}

test("link verifies identity, run pins the profile env verbatim", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);

    // Login lands on acc_1; no --account means identity decides the link.
    const link = await runCli(["pi", "link"], {
      ...world.env,
      FAKE_PI_LOGIN_AS: "uuid-1",
      FAKE_PI_LOGIN_EMAIL: "user1@x.com",
    });
    assert.equal(link.code, 0, link.stderr);
    assert.match(link.stdout, /linked user1@x\.com/);

    const status = await runCli(["pi", "status", "--json"], world.env);
    assert.equal(status.code, 0, status.stderr);
    const statusEnvelope = JSON.parse(status.stdout) as {
      data: {
        accounts: Array<{
          accountKey: string;
          linked: boolean;
          credentialPresent: boolean;
          identityMatch: boolean | null;
        }>;
      };
    };
    const linkedRow = statusEnvelope.data.accounts.find((r) => r.accountKey === "record:r1");
    assert.ok(linkedRow?.linked && linkedRow.credentialPresent && linkedRow.identityMatch);
    const otherRow = statusEnvelope.data.accounts.find((r) => r.accountKey === "record:r2");
    assert.equal(otherRow?.linked, false);

    // Forced run on the linked account: argv verbatim, env pins profile +
    // canonical session dir, child exit code propagates.
    const run = await runCli(
      ["pi", "run", "--account", "user1@x.com", "--", "--model", "gpt-x", "-p", "hi"],
      { ...world.env, FAKE_PI_RECORD: world.recordPath, FAKE_PI_EXIT: "7" },
    );
    assert.equal(run.code, 7, "child exit code takes precedence");
    const invocations = piInvocations(world.recordPath);
    assert.equal(invocations.length, 1);
    const invocation = invocations[0]!;
    assert.deepEqual(invocation.argv, ["--model", "gpt-x", "-p", "hi"]);
    assert.notEqual(invocation.agentDir, world.piAgentDir, "profile dir, not the canonical dir");
    assert.match(invocation.agentDir ?? "", /profiles/);
    // Sessions share through the profile's symlink, never a flattening
    // session-dir override.
    assert.equal(invocation.sessionDir, null);
    assert.equal(
      readlinkSync(path.join(invocation.agentDir!, "sessions")),
      path.join(world.piAgentDir, "sessions"),
    );
    const profileAuth = JSON.parse(
      readFileSync(path.join(invocation.agentDir!, "auth.json"), "utf8"),
    ) as Record<string, { type: string }>;
    assert.equal(profileAuth["openai-codex"]?.type, "oauth");

    // The lease opened for the run is released with the child's exit code.
    const leases = await runCli(["leases", "--all", "--json"], world.env);
    const leasesEnvelope = JSON.parse(leases.stdout) as {
      data: { leases: Array<{ purpose: string; status: string; childExitCode: number | null }> };
    };
    const piLease = leasesEnvelope.data.leases.find((l) => l.purpose === "pi-session");
    assert.ok(piLease, "pi run recorded a lease");
    assert.equal(piLease.status, "failed", "non-zero child marks the lease failed");
    assert.equal(piLease.childExitCode, 7);

    // Unlinked accounts refuse to run.
    const unlinked = await runCli(
      ["pi", "run", "--account", "user2@x.com", "--"],
      { ...world.env, FAKE_PI_RECORD: world.recordPath },
    );
    assert.equal(unlinked.code, 4);
    assert.match(unlinked.stderr, /no linked pi profile/);
  } finally {
    await server.close();
  }
});

test("link refuses identity mismatch and out-of-pool logins", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);

    // Asked for account 1, logged into account 2: nothing may be linked.
    const mismatch = await runCli(["pi", "link", "--account", "user1@x.com"], {
      ...world.env,
      FAKE_PI_LOGIN_AS: "uuid-2",
      FAKE_PI_LOGIN_EMAIL: "user2@x.com",
    });
    assert.equal(mismatch.code, 4);
    assert.match(mismatch.stderr, /--account requested/);

    // A login outside the pool is refused with guidance.
    const stranger = await runCli(["pi", "link"], {
      ...world.env,
      FAKE_PI_LOGIN_AS: "uuid-unknown",
      FAKE_PI_LOGIN_EMAIL: "stranger@x.com",
    });
    assert.equal(stranger.code, 4);
    assert.match(stranger.stderr, /not in the codex-swap pool/);

    const status = await runCli(["pi", "status", "--json"], world.env);
    const statusEnvelope = JSON.parse(status.stdout) as {
      data: { accounts: Array<{ linked: boolean }>; orphanProfiles: unknown[] };
    };
    assert.ok(
      statusEnvelope.data.accounts.every((r) => !r.linked),
      "no profile was created by refused links",
    );
    assert.equal(statusEnvelope.data.orphanProfiles.length, 0);
  } finally {
    await server.close();
  }
});

test("strategy selection only considers linked accounts", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);

    // Only account 2 gets a profile; account 1 has better headroom (40%
    // used vs 70%) and would win an unrestricted selection.
    const link = await runCli(["pi", "link"], {
      ...world.env,
      FAKE_PI_LOGIN_AS: "uuid-2",
      FAKE_PI_LOGIN_EMAIL: "user2@x.com",
    });
    assert.equal(link.code, 0, link.stderr);

    await runCli(["usage", "refresh", "--json"], world.env);

    const run = await runCli(["pi", "run", "--strategy", "best", "--"], {
      ...world.env,
      FAKE_PI_RECORD: world.recordPath,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /using record:r2/, "restriction beats raw headroom");

    // With no profiles at all the failure is actionable.
    const bare = makeWorld(server.url);
    const none = await runCli(["pi", "run", "--strategy", "best", "--"], bare.env);
    assert.equal(none.code, 3);
    assert.match(none.stderr, /no account has a linked pi profile/);
  } finally {
    await server.close();
  }
});

test("a balancer claim on an unlinked account is demoted, an --account pin is not", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);

    // Only account 2 is linked; account 1 has the better headroom, so the
    // unrestricted codex balancer — which cannot see pi linkage — claims it.
    const link = await runCli(["pi", "link"], {
      ...world.env,
      FAKE_PI_LOGIN_AS: "uuid-2",
      FAKE_PI_LOGIN_EMAIL: "user2@x.com",
    });
    assert.equal(link.code, 0, link.stderr);
    await runCli(["usage", "refresh", "--json"], world.env);

    const claim = await runCli(["select", "--claim", "--json"], world.env);
    assert.equal(claim.code, 0, claim.stderr);
    const claimEnvelope = JSON.parse(claim.stdout) as {
      data: { lease: { leaseId: string; accountKey: string } };
    };
    assert.equal(
      claimEnvelope.data.lease.accountKey,
      "record:r1",
      "quota alone picks the unlinked one",
    );

    // The pin is advisory: the launch lands on the account pi can use.
    const run = await runCli(
      ["pi", "run", "--claim", claimEnvelope.data.lease.leaseId, "--"],
      { ...world.env, FAKE_PI_RECORD: world.recordPath },
    );
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /no linked pi profile/, "says why the pin was dropped");
    assert.match(run.stderr, /using record:r2 instead/);
    const invocations = piInvocations(world.recordPath);
    assert.equal(invocations.length, 1);
    assert.match(invocations[0]!.agentDir ?? "", /record-r2/);

    // The demoted lease is released, not failed — nothing was wrong with
    // the account itself — and the replacement carried the run.
    const leases = await runCli(["leases", "--all", "--json"], world.env);
    const leasesEnvelope = JSON.parse(leases.stdout) as {
      data: { leases: Array<{ leaseId: string; accountKey: string; status: string }> };
    };
    const demoted = leasesEnvelope.data.leases.find(
      (l) => l.leaseId === claimEnvelope.data.lease.leaseId,
    );
    assert.equal(demoted?.status, "released");
    const replacement = leasesEnvelope.data.leases.find(
      (l) => l.accountKey === "record:r2" && l.leaseId !== claimEnvelope.data.lease.leaseId,
    );
    assert.equal(replacement?.status, "released");

    // The same account named explicitly by a human still fails hard.
    const pinned = await runCli(["pi", "run", "--account", "user1@x.com", "--"], world.env);
    assert.equal(pinned.code, 4);
    assert.match(pinned.stderr, /no linked pi profile/);
  } finally {
    await server.close();
  }
});

test("prune adopts before it deletes, and never deletes unasked", async () => {
  const server = await startServer();
  try {
    const world = makeWorld(server.url);
    const accountsPath = path.join(
      world.env["CODEX_MULTI_AUTH_DIR"]!,
      "openai-codex-accounts.json",
    );
    const store = JSON.parse(readFileSync(accountsPath, "utf8")) as {
      version: number;
      accounts: Array<{ recordId: string }>;
      activeIndex: number;
    };

    const link = await runCli(["pi", "link"], {
      ...world.env,
      FAKE_PI_LOGIN_AS: "uuid-1",
      FAKE_PI_LOGIN_EMAIL: "user1@x.com",
    });
    assert.equal(link.code, 0, link.stderr);

    // Account 1 re-keys underneath its link, exactly as ndy gaining a new
    // recordId does. The profile is stranded, not stale.
    store.accounts[0]!.recordId = "r1-rekeyed";
    writeFileSync(accountsPath, JSON.stringify(store));

    const prune = await runCli(["pi", "prune", "--json"], world.env);
    assert.equal(prune.code, 0, prune.stderr);
    const pruneEnvelope = JSON.parse(prune.stdout) as {
      data: { adopted: Array<{ accountKey: string }>; removed: unknown[]; kept: unknown[] };
    };
    assert.equal(pruneEnvelope.data.adopted.length, 1, "adopted rather than offered for deletion");
    assert.equal(pruneEnvelope.data.adopted[0]?.accountKey, "record:r1-rekeyed");
    assert.deepEqual(pruneEnvelope.data.removed, []);

    // Now account 1 leaves the pool outright: its profile is a true orphan.
    store.accounts.splice(0, 1);
    store.activeIndex = 0;
    writeFileSync(accountsPath, JSON.stringify(store));

    const refuses = await runCli(["pi", "prune", "--json"], world.env);
    assert.equal(refuses.code, 2, "non-interactive prune refuses without --yes");
    assert.match(refuses.stdout, /CONFIRMATION_REQUIRED/);

    const status = await runCli(["pi", "status", "--json"], world.env);
    const statusEnvelope = JSON.parse(status.stdout) as {
      data: { orphanProfiles: unknown[] };
    };
    assert.equal(statusEnvelope.data.orphanProfiles.length, 1, "the refusal deleted nothing");

    const pruned = await runCli(["pi", "prune", "--yes", "--json"], world.env);
    assert.equal(pruned.code, 0, pruned.stderr);
    const prunedEnvelope = JSON.parse(pruned.stdout) as {
      data: { removed: Array<{ accountKey: string; profileDir: string }> };
    };
    assert.equal(prunedEnvelope.data.removed.length, 1);
    assert.equal(existsSync(prunedEnvelope.data.removed[0]!.profileDir), false);

    const after = await runCli(["pi", "status", "--json"], world.env);
    const afterEnvelope = JSON.parse(after.stdout) as { data: { orphanProfiles: unknown[] } };
    assert.deepEqual(afterEnvelope.data.orphanProfiles, []);
  } finally {
    await server.close();
  }
});
