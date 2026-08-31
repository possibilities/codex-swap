import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "../../src/storage/database.ts";
import { databasePath } from "../../src/storage/paths.ts";

const POSIX = process.platform !== "win32";
const INSTALL = fileURLToPath(new URL("../../scripts/install.sh", import.meta.url));
const RETIRED_SENTINEL = "PI_RETIREMENT_BYTES_MUST_DISAPPEAR";

interface World {
  root: string;
  data: string;
  bin: string;
  state: string;
  dbPath: string;
  piRoot: string;
  logPath: string;
  rotatedLogPath: string;
  keptLog: string;
  retiredLog: string;
  externalTarget: string;
}

function profileDirName(accountKey: string): string {
  const sanitized = accountKey.replace(/[^A-Za-z0-9._-]+/g, "-");
  const digest = createHash("sha256").update(accountKey).digest("hex").slice(0, 8);
  return `${sanitized}-${digest}`;
}

function insertLease(
  db: DatabaseSync,
  leaseId: string,
  purpose: string,
  sentinel: string,
): void {
  db.prepare(
    `INSERT INTO invocation_leases (
       lease_id, account_key, owner_pid, owner_nonce, purpose, cwd,
       acquired_at_ms, heartbeat_at_ms, expires_at_ms, released_at_ms,
       status, selector_reason_json, child_exit_code
     ) VALUES (?, 'record:a', 42, ?, ?, ?, 10, 11, 12, 13, 'released', ?, 0)`,
  ).run(
    leaseId,
    `${leaseId}-nonce`,
    purpose,
    `/${leaseId}`,
    JSON.stringify({ summary: sentinel }),
  );
}

function makeWorld(options?: { foreignProfile?: boolean }): World {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-swap-retirement-"));
  const data = path.join(root, "data");
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  mkdirSync(data, { recursive: true });
  const dbPath = databasePath(data);
  const db = Database.open(dbPath, () => 1_000);
  db.handle.prepare(
    `INSERT INTO accounts (
       account_key, record_id, provider_account_id, email, enabled, present,
       auth_status, first_seen_at_ms, last_seen_at_ms, updated_at_ms
     ) VALUES ('record:a', 'a', 'account-a', 'a@example.invalid', 1, 1,
               'ready', 1, 1, 1)`,
  ).run();
  insertLease(db.handle, "codex-lease", "codex-session", "preserve exactly");
  insertLease(db.handle, "retired-lease", "pi-session", RETIRED_SENTINEL);
  const addEvent = db.handle.prepare(
    `INSERT INTO events (occurred_at_ms, event_type, account_key, payload_json)
     VALUES (?, ?, 'record:a', ?)`,
  );
  addEvent.run(
    20,
    "invocation_lease_acquired",
    '{"leaseId":"codex-lease","purpose":"codex-session","keep":"exact"}',
  );
  addEvent.run(
    21,
    "invocation_lease_acquired",
    `{"leaseId":"retired-lease","purpose":"pi-session","sentinel":"${RETIRED_SENTINEL}"}`,
  );
  addEvent.run(22, "invocation_started", '{"leaseId":"retired-lease"}');
  addEvent.run(23, "invocation_finished", '{"leaseId":"retired-lease"}');
  db.close();

  const piRoot = path.join(data, "pi");
  const profiles = path.join(piRoot, "profiles");
  if (options?.foreignProfile === true) {
    mkdirSync(path.join(profiles, "foreign"), { recursive: true });
    writeFileSync(path.join(profiles, "foreign", "not-owned.txt"), "preserve\n");
  } else {
    const accountKey = "record:a";
    const profile = path.join(profiles, profileDirName(accountKey));
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      path.join(profile, "profile.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        accountKey,
        providerAccountId: "account-a",
        email: "a@example.invalid",
        verifiedAccountId: "verified-a",
        linkedAtMs: 1_000,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(profile, "auth.json"), RETIRED_SENTINEL, {
      mode: 0o600,
    });
    const externalTarget = path.join(root, "canonical-sessions");
    mkdirSync(externalTarget);
    writeFileSync(path.join(externalTarget, "preserve.txt"), "outside profile\n");
    symlinkSync(externalTarget, path.join(profile, "sessions"));
  }

  const logPath = path.join(data, "logs", "codex-swap.jsonl");
  mkdirSync(path.dirname(logPath), { recursive: true });
  const keptLog = '{"event":"command_completed","command":"run","exitCode":0}\n';
  const retiredLog =
    '{"event":"command_completed","command":"pi","exitCode":0}\n';
  writeFileSync(logPath, `${keptLog}${retiredLog}{"partial":\n`, { mode: 0o600 });

  return {
    root,
    data,
    bin,
    state,
    dbPath,
    piRoot,
    logPath,
    rotatedLogPath: `${logPath}.1`,
    keptLog,
    retiredLog,
    externalTarget: path.join(root, "canonical-sessions"),
  };
}

function installerEnv(world: World): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_SWAP_HOME: world.data,
    CODEX_SWAP_INSTALL_BIN_DIR: world.bin,
    CODEX_SWAP_INSTALL_STATE_DIR: world.state,
  };
}

function runInstaller(
  world: World,
  mode: "--install" | "--dry-run" = "--install",
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [INSTALL, mode], {
    env: installerEnv(world),
    encoding: "utf8",
    timeout: 30_000,
  });
}

interface InstallerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function hookMarker(world: World, point: string, state: "ready" | "release"): string {
  return path.join(world.data, `.retire-pi-test-${point}.${state}`);
}

async function waitForFile(target: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${target}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runInstallerAtHook(
  world: World,
  point: "log-snapshot" | "log-verification" | "profile-claim",
  action: () => void,
): Promise<InstallerResult> {
  const child = spawn("bash", [INSTALL, "--install"], {
    env: {
      ...installerEnv(world),
      CODEX_SWAP_RETIRE_TEST_HOOK: point,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<InstallerResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    await waitForFile(hookMarker(world, point, "ready"));
    action();
    writeFileSync(hookMarker(world, point, "release"), "continue\n", {
      flag: "wx",
      mode: 0o600,
    });
    return await completion;
  } catch (error) {
    child.kill("SIGKILL");
    await completion.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanedLog(world: World, suffix = ""): string {
  return `${world.keptLog}${blankRetiredLog(world)}{"partial":\n${suffix}`;
}

function blankRetiredLog(world: World): string {
  return `${" ".repeat(Buffer.byteLength(world.retiredLog) - 1)}\n`;
}

test(
  "installer dry-run reports the exact retirement without changing it",
  { skip: !POSIX },
  (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const before = codexState(world.dbPath);
    const result = runInstaller(world, "--dry-run");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(String(result.stdout), /would retire 1 Pi profile\(s\), 1 lease\(s\), 3 event\(s\), and 1 log record/);
    assert.equal(existsSync(world.piRoot), true);
    assert.deepEqual(retiredCounts(world.dbPath), { leases: 1, events: 3 });
    assert.deepEqual(codexState(world.dbPath), before);
    assert.ok(readFileSync(world.logPath, "utf8").includes(world.retiredLog));
    assert.equal(existsSync(path.join(world.bin, "codex-swap")), false);
    assert.equal(existsSync(path.join(world.state, "install-receipt")), false);
  },
);

function codexState(dbPath: string): { leases: unknown[]; events: unknown[] } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT * FROM invocation_leases WHERE purpose != 'pi-session' ORDER BY lease_id",
        )
        .all(),
      events: db
        .prepare(
          `SELECT * FROM events
            WHERE CASE WHEN json_valid(payload_json)
                       THEN json_extract(payload_json, '$.purpose') END != 'pi-session'
              AND CASE WHEN json_valid(payload_json)
                       THEN json_extract(payload_json, '$.leaseId') END != 'retired-lease'
            ORDER BY event_id`,
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

function retiredCounts(dbPath: string): { leases: number; events: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      leases: Number(
        db
          .prepare("SELECT COUNT(*) AS n FROM invocation_leases WHERE purpose = 'pi-session'")
          .get()?.["n"],
      ),
      events: Number(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM events
              WHERE CASE WHEN json_valid(payload_json)
                         THEN json_extract(payload_json, '$.purpose') END = 'pi-session'
                 OR CASE WHEN json_valid(payload_json)
                         THEN json_extract(payload_json, '$.leaseId') END = 'retired-lease'`,
          )
          .get()?.["n"],
      ),
    };
  } finally {
    db.close();
  }
}

test(
  "installer retires only owned Pi state, compacts SQLite, and is idempotent",
  { skip: !POSIX },
  (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const before = codexState(world.dbPath);
    const first = runInstaller(world);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(existsSync(world.piRoot), false);
    assert.equal(
      readFileSync(path.join(world.externalTarget, "preserve.txt"), "utf8"),
      "outside profile\n",
      "recursive cleanup must unlink, never follow, profile symlinks",
    );
    assert.deepEqual(retiredCounts(world.dbPath), { leases: 0, events: 0 });
    assert.deepEqual(codexState(world.dbPath), before);
    assert.equal(readFileSync(world.logPath, "utf8"), cleanedLog(world));
    for (const candidate of [
      world.dbPath,
      `${world.dbPath}-wal`,
      `${world.dbPath}-journal`,
    ]) {
      if (!existsSync(candidate)) continue;
      const bytes = readFileSync(candidate);
      assert.equal(bytes.includes(Buffer.from("pi-session")), false, candidate);
      assert.equal(bytes.includes(Buffer.from(RETIRED_SENTINEL)), false, candidate);
    }

    const afterFirst = codexState(world.dbPath);
    const second = runInstaller(world);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.deepEqual(codexState(world.dbPath), afterFirst);
    assert.equal(readFileSync(world.logPath, "utf8"), cleanedLog(world));
  },
);

test(
  "installer refuses unproven profile trees before mutating any state",
  { skip: !POSIX },
  (context) => {
    const world = makeWorld({ foreignProfile: true });
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const before = codexState(world.dbPath);
    const result = runInstaller(world);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /does not prove|not valid metadata/);
    assert.equal(existsSync(world.piRoot), true);
    assert.deepEqual(retiredCounts(world.dbPath), { leases: 1, events: 3 });
    assert.deepEqual(codexState(world.dbPath), before);
    assert.ok(readFileSync(world.logPath, "utf8").includes(world.retiredLog));
    assert.equal(existsSync(path.join(world.bin, "codex-swap")), false);
    assert.equal(existsSync(path.join(world.state, "install-receipt")), false);
  },
);

test(
  "log retirement preserves an append that lands during redaction exactly once",
  { skip: !POSIX },
  async (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const concurrent =
      '{"event":"command_completed","command":"run","concurrent":true}\n';
    const result = await runInstallerAtHook(world, "log-snapshot", () => {
      appendFileSync(world.logPath, concurrent, { encoding: "utf8" });
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null);
    const after = readFileSync(world.logPath, "utf8");
    assert.equal(after, cleanedLog(world, concurrent));
    assert.equal(after.indexOf(concurrent), after.lastIndexOf(concurrent));
    assert.equal(after.includes(world.retiredLog), false);
  },
);

test(
  "log retirement cleans the exact rotated generation",
  { skip: !POSIX },
  (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const rotatedKept = '{"event":"rotated","command":"run"}\n';
    writeFileSync(
      world.rotatedLogPath,
      `${rotatedKept}${world.retiredLog}`,
      { mode: 0o600 },
    );

    const result = runInstaller(world);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(String(result.stdout), /2 log record/);
    assert.equal(
      readFileSync(world.rotatedLogPath, "utf8"),
      `${rotatedKept}${blankRetiredLog(world)}`,
    );
    assert.equal(readFileSync(world.logPath, "utf8"), cleanedLog(world));
  },
);

test(
  "log retirement follows the opened inode through a concurrent rotation",
  { skip: !POSIX },
  async (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const concurrent =
      '{"event":"command_completed","command":"run","afterRotation":true}\n';
    const result = await runInstallerAtHook(world, "log-snapshot", () => {
      renameSync(world.logPath, world.rotatedLogPath);
      appendFileSync(world.logPath, concurrent, { encoding: "utf8", mode: 0o600 });
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(world.rotatedLogPath, "utf8"), cleanedLog(world));
    assert.equal(readFileSync(world.logPath, "utf8"), concurrent);
    const allLogs = `${readFileSync(world.rotatedLogPath, "utf8")}${readFileSync(world.logPath, "utf8")}`;
    assert.equal(allLogs.indexOf(concurrent), allLogs.lastIndexOf(concurrent));
    assert.equal(allLogs.includes(world.retiredLog), false);
  },
);

test(
  "log verification refuses a rotation between generation snapshots",
  { skip: !POSIX },
  async (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const concurrent =
      '{"event":"command_completed","command":"run","duringVerification":true}\n';
    const refused = await runInstallerAtHook(world, "log-verification", () => {
      renameSync(world.logPath, world.rotatedLogPath);
      appendFileSync(world.logPath, concurrent, { encoding: "utf8", mode: 0o600 });
    });

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /logs changed during inspection; rerun/);
    assert.equal(readFileSync(world.rotatedLogPath, "utf8"), cleanedLog(world));
    assert.equal(readFileSync(world.logPath, "utf8"), concurrent);
    assert.equal(existsSync(world.piRoot), true);
    assert.equal(existsSync(path.join(world.bin, "codex-swap")), false);

    const retried = runInstaller(world);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal(existsSync(world.piRoot), false);
  },
);

test(
  "a retired append after the cleanup snapshot forces an exact retry",
  { skip: !POSIX },
  async (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const refused = await runInstallerAtHook(world, "log-snapshot", () => {
      appendFileSync(world.logPath, world.retiredLog, { encoding: "utf8" });
    });

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /post-snapshot log record; rerun the installer/);
    assert.equal(existsSync(world.piRoot), true);
    assert.equal(existsSync(path.join(world.bin, "codex-swap")), false);
    assert.equal(existsSync(path.join(world.state, "install-receipt")), false);
    assert.equal(readFileSync(world.logPath, "utf8").endsWith(world.retiredLog), true);

    const retried = runInstaller(world);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal(readFileSync(world.logPath, "utf8").includes(world.retiredLog), false);
  },
);

test(
  "profile retirement re-proves an atomically claimed directory before deletion",
  { skip: !POSIX },
  async (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const profilesRoot = path.join(world.piRoot, "profiles");
    const [profileName] = readdirSync(profilesRoot);
    assert.ok(profileName);
    const profile = path.join(profilesRoot, profileName);
    const heldProfile = path.join(world.root, "held-owned-profile");
    const foreignMarker = path.join(profile, "foreign.txt");

    const refused = await runInstallerAtHook(world, "profile-claim", () => {
      renameSync(profile, heldProfile);
      mkdirSync(profile);
      writeFileSync(foreignMarker, "must survive\n", { mode: 0o600 });
    });

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /does not prove|changed before removal/);
    assert.equal(readFileSync(foreignMarker, "utf8"), "must survive\n");
    assert.equal(existsSync(heldProfile), true);
    assert.deepEqual(readdirSync(profilesRoot), [profileName]);
    assert.equal(existsSync(path.join(world.bin, "codex-swap")), false);
    assert.equal(existsSync(path.join(world.state, "install-receipt")), false);

    rmSync(profile, { recursive: true, force: false });
    renameSync(heldProfile, profile);
    const retried = runInstaller(world);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal(existsSync(world.piRoot), false);
  },
);

test(
  "busy WAL cleanup fails with an exact retry and converges after the reader exits",
  { skip: !POSIX },
  (context) => {
    const world = makeWorld();
    context.after(() => rmSync(world.root, { recursive: true, force: true }));
    const reader = new DatabaseSync(world.dbPath, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM invocation_leases").all();
    const blocked = runInstaller(world);
    reader.exec("ROLLBACK");
    reader.close();

    assert.equal(blocked.status, 1);
    assert.match(String(blocked.stderr), /readers finish, then rerun scripts\/install\.sh --install/);
    assert.equal(existsSync(world.piRoot), true);
    assert.ok(readFileSync(world.logPath, "utf8").includes(world.retiredLog));

    const retried = runInstaller(world);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal(existsSync(world.piRoot), false);
    assert.deepEqual(retiredCounts(world.dbPath), { leases: 0, events: 0 });
  },
);
