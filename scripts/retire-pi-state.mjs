import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";
import { Database } from "../src/storage/database.ts";
import {
  dataRoot,
  databasePath,
  logFilePath,
  logsDir,
} from "../src/storage/paths.ts";
import {
  MIGRATIONS,
  RETIRE_ALTERNATE_HARNESS_DATABASE_SQL,
} from "../src/storage/migrations.ts";

const PROFILE_SCHEMA_VERSION = 1;
const RETIRED_COMMAND = "pi";
const RETIRED_LEASE_PURPOSE = "pi-session";
const RETIRED_LEASE_BYTES = Buffer.from(RETIRED_LEASE_PURPOSE, "utf8");
const RETRY = "let AgentUsage and codex-swap database readers finish, then rerun scripts/install.sh --install";

class CleanupRefusedError extends Error {}

function statIfPresent(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function requireRealDirectory(target, label) {
  const stat = statIfPresent(target);
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CleanupRefusedError(
      `refusing ${label} at ${target}: expected a real directory`,
    );
  }
  return stat;
}

function requireRegularFile(target, label) {
  const stat = statIfPresent(target);
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CleanupRefusedError(
      `refusing ${label} at ${target}: expected a regular file`,
    );
  }
  return stat;
}

function profileDirName(accountKey) {
  const sanitized = accountKey.replace(/[^A-Za-z0-9._-]+/g, "-");
  const digest = createHash("sha256").update(accountKey).digest("hex").slice(0, 8);
  return `${sanitized}-${digest}`;
}

function validateOwnedTree(target, owningDevice) {
  for (const entry of readdirSync(target)) {
    const child = path.join(target, entry);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (stat.dev !== owningDevice) {
        throw new CleanupRefusedError(
          `refusing Pi profile cleanup: ${child} is a mounted directory`,
        );
      }
      validateOwnedTree(child, owningDevice);
    }
  }
}

function inspectProfiles(root) {
  const piRoot = path.resolve(root, "pi");
  if (path.dirname(piRoot) !== root || path.basename(piRoot) !== "pi") {
    throw new CleanupRefusedError(`refusing unexpected Pi profile root: ${piRoot}`);
  }
  const piStat = requireRealDirectory(piRoot, "Pi profile root");
  if (piStat === null) return { root: piRoot, present: false, profiles: 0 };

  const rootEntries = readdirSync(piRoot);
  if (rootEntries.some((entry) => entry !== "profiles")) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${piRoot} contains an unowned entry`,
    );
  }
  const profilesRoot = path.join(piRoot, "profiles");
  const profilesStat = requireRealDirectory(profilesRoot, "Pi profiles directory");
  if (profilesStat === null) {
    return { root: piRoot, present: true, profiles: 0 };
  }
  if (profilesStat.dev !== piStat.dev) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${profilesRoot} is a mounted directory`,
    );
  }

  let profiles = 0;
  for (const entry of readdirSync(profilesRoot)) {
    if (/^\.staging-\d+$/.test(entry)) {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${entry} is an unverified interrupted link; inspect it and retry`,
      );
    }
    const profileDir = path.join(profilesRoot, entry);
    const profileStat = requireRealDirectory(profileDir, "Pi account profile");
    if (profileStat === null || profileStat.dev !== piStat.dev) {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${profileDir} is not an owned local profile`,
      );
    }
    const metadataPath = path.join(profileDir, "profile.json");
    requireRegularFile(metadataPath, "Pi profile metadata");
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${metadataPath} is not valid metadata`,
      );
    }
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      metadata.schemaVersion !== PROFILE_SCHEMA_VERSION ||
      typeof metadata.accountKey !== "string" ||
      metadata.accountKey.length === 0 ||
      typeof metadata.verifiedAccountId !== "string" ||
      metadata.verifiedAccountId.length === 0 ||
      typeof metadata.linkedAtMs !== "number" ||
      !Number.isFinite(metadata.linkedAtMs) ||
      entry !== profileDirName(metadata.accountKey)
    ) {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${metadataPath} does not prove codex-swap ownership`,
      );
    }
    validateOwnedTree(profileDir, piStat.dev);
    profiles += 1;
  }
  return { root: piRoot, present: true, profiles };
}

function splitAndFilterLog(contents) {
  const kept = [];
  let removed = 0;
  let start = 0;
  for (let cursor = 0; cursor <= contents.length; cursor += 1) {
    if (cursor !== contents.length && contents[cursor] !== 0x0a) continue;
    const hasNewline = cursor < contents.length;
    const chunkEnd = hasNewline ? cursor + 1 : cursor;
    let bodyEnd = cursor;
    if (bodyEnd > start && contents[bodyEnd - 1] === 0x0d) bodyEnd -= 1;
    const body = contents.subarray(start, bodyEnd);
    let retire = false;
    if (body.length > 0) {
      try {
        const record = JSON.parse(body.toString("utf8"));
        retire =
          typeof record === "object" &&
          record !== null &&
          record.command === RETIRED_COMMAND;
      } catch {
        // Preserve malformed/partial records byte-for-byte. They do not prove
        // the exact top-level command this cleanup is authorized to remove.
      }
    }
    if (retire) removed += 1;
    else if (chunkEnd > start) kept.push(contents.subarray(start, chunkEnd));
    start = chunkEnd;
  }
  return { contents: Buffer.concat(kept), removed };
}

function fileIdentity(stat, contents) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    digest: createHash("sha256").update(contents).digest("hex"),
  };
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.digest === right.digest
  );
}

function inspectLog(root) {
  const directory = logsDir(root);
  const directoryStat = requireRealDirectory(directory, "codex-swap log directory");
  const file = logFilePath(root);
  const stat = requireRegularFile(file, "codex-swap JSONL log");
  if (stat === null) return { file, present: false, removed: 0 };
  if (directoryStat === null || stat.dev !== directoryStat.dev) {
    throw new CleanupRefusedError(
      `refusing Pi log cleanup: ${file} is not owned by its log directory`,
    );
  }
  const original = readFileSync(file);
  const filtered = splitAndFilterLog(original);
  return {
    file,
    present: true,
    removed: filtered.removed,
    filtered: filtered.contents,
    identity: fileIdentity(stat, original),
  };
}

function requiredColumns(db, table, required) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  for (const column of required) {
    if (!columns.has(column)) {
      throw new CleanupRefusedError(
        `refusing database cleanup: ${table}.${column} is missing`,
      );
    }
  }
}

const RETIRED_EVENT_COUNT_SQL = `
SELECT COUNT(*) AS n
  FROM events
 WHERE CASE
           WHEN json_valid(payload_json)
           THEN json_extract(payload_json, '$.purpose')
       END = '${RETIRED_LEASE_PURPOSE}'
    OR CASE
           WHEN json_valid(payload_json)
           THEN json_extract(payload_json, '$.leaseId')
       END IN (
           SELECT lease_id
             FROM invocation_leases
            WHERE purpose = '${RETIRED_LEASE_PURPOSE}'
           UNION
           SELECT CASE
                      WHEN json_valid(payload_json)
                      THEN json_extract(payload_json, '$.leaseId')
                  END
             FROM events
            WHERE CASE
                      WHEN json_valid(payload_json)
                      THEN json_extract(payload_json, '$.purpose')
                  END = '${RETIRED_LEASE_PURPOSE}'
       )`;

function inspectDatabase(root) {
  const file = databasePath(root);
  const stat = requireRegularFile(file, "codex-swap database");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    requireRegularFile(`${file}${suffix}`, "codex-swap database sidecar");
  }
  if (stat === null) {
    return {
      file,
      present: false,
      version: 0,
      leases: 0,
      events: 0,
      rawRemnant: false,
    };
  }

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const quickCheck = db.prepare("PRAGMA quick_check").get();
    if (quickCheck?.quick_check !== "ok") {
      throw new CleanupRefusedError(
        `refusing database cleanup: quick_check failed for ${file}`,
      );
    }
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    for (const table of [
      "schema_migrations",
      "accounts",
      "invocation_leases",
      "events",
    ]) {
      if (!tables.has(table)) {
        throw new CleanupRefusedError(
          `refusing database cleanup: ${file} is not a codex-swap database`,
        );
      }
    }
    requiredColumns(db, "schema_migrations", ["version", "applied_at_ms"]);
    requiredColumns(db, "invocation_leases", ["lease_id", "purpose"]);
    requiredColumns(db, "events", ["event_id", "payload_json"]);

    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version);
    const known = MIGRATIONS.map(({ version }) => version);
    if (
      versions.length === 0 ||
      versions.length > known.length ||
      versions.some((version, index) => version !== known[index])
    ) {
      throw new CleanupRefusedError(
        `refusing database cleanup: ${file} has an unknown migration history`,
      );
    }
    const leases = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM invocation_leases WHERE purpose = ?")
        .get(RETIRED_LEASE_PURPOSE).n,
    );
    const events = Number(db.prepare(RETIRED_EVENT_COUNT_SQL).get().n);
    const rawRemnant = [file, `${file}-wal`, `${file}-journal`].some((candidate) => {
      const candidateStat = statIfPresent(candidate);
      return (
        candidateStat !== null &&
        candidateStat.isFile() &&
        readFileSync(candidate).includes(RETIRED_LEASE_BYTES)
      );
    });
    return {
      file,
      present: true,
      version: Number(versions.at(-1)),
      leases,
      events,
      rawRemnant,
    };
  } catch (error) {
    if (error instanceof CleanupRefusedError) throw error;
    throw databaseError("inspect", error);
  } finally {
    db?.close();
  }
}

function databaseError(action, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:busy|locked)\b/i.test(message)) {
    return new CleanupRefusedError(
      `database ${action} could not acquire its lock; ${RETRY}`,
    );
  }
  return new CleanupRefusedError(`database ${action} failed: ${message}`);
}

function checkpointTruncate(db, phase) {
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (Number(row?.busy) !== 0 || Number(row?.log) > 0) {
    throw new CleanupRefusedError(
      `database WAL ${phase} is busy; ${RETRY}`,
    );
  }
}

function compactDatabase(file) {
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000");
    checkpointTruncate(db, "checkpoint before VACUUM");
    db.exec("VACUUM");
    checkpointTruncate(db, "checkpoint after VACUUM");
  } catch (error) {
    if (error instanceof CleanupRefusedError) throw error;
    throw databaseError("compaction", error);
  } finally {
    db?.close();
  }
  if (process.platform !== "win32") {
    chmodSync(file, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (statIfPresent(`${file}${suffix}`) !== null) chmodSync(`${file}${suffix}`, 0o600);
    }
  }
  const wal = statIfPresent(`${file}-wal`);
  if (wal !== null && wal.size !== 0) {
    throw new CleanupRefusedError(
      `database WAL was not truncated after cleanup; ${RETRY}`,
    );
  }
  for (const candidate of [file, `${file}-wal`, `${file}-journal`]) {
    const stat = statIfPresent(candidate);
    if (
      stat !== null &&
      stat.isFile() &&
      readFileSync(candidate).includes(RETIRED_LEASE_BYTES)
    ) {
      throw new CleanupRefusedError(
        `database compaction left retired lease bytes in ${candidate}; ${RETRY}`,
      );
    }
  }
}

function cleanDatabase(plan) {
  if (!plan.present) return;
  const current = inspectDatabase(path.dirname(plan.file));
  const needsMigration = current.version < (MIGRATIONS.at(-1)?.version ?? 0);
  const hadRetiredRows = current.leases > 0 || current.events > 0;
  if (!needsMigration && !hadRetiredRows && !current.rawRemnant) return;

  let db;
  try {
    db = Database.open(current.file);
    db.immediate(() => db.handle.exec(RETIRE_ALTERNATE_HARNESS_DATABASE_SQL));
    const remainingLeases = Number(
      db.handle
        .prepare("SELECT COUNT(*) AS n FROM invocation_leases WHERE purpose = ?")
        .get(RETIRED_LEASE_PURPOSE).n,
    );
    const remainingEvents = Number(
      db.handle.prepare(RETIRED_EVENT_COUNT_SQL).get().n,
    );
    if (remainingLeases !== 0 || remainingEvents !== 0) {
      throw new CleanupRefusedError(
        "database retirement transaction left matching rows; refusing to continue",
      );
    }
  } catch (error) {
    if (error instanceof CleanupRefusedError) throw error;
    throw databaseError("retirement transaction", error);
  } finally {
    db?.close();
  }
  if (hadRetiredRows || current.rawRemnant) compactDatabase(current.file);
}

function rewriteLog(plan) {
  if (!plan.present || plan.removed === 0) return;
  const currentStat = requireRegularFile(plan.file, "codex-swap JSONL log");
  const currentContents = readFileSync(plan.file);
  if (
    currentStat === null ||
    !sameIdentity(plan.identity, fileIdentity(currentStat, currentContents))
  ) {
    throw new CleanupRefusedError(
      `codex-swap log changed during cleanup; rerun scripts/install.sh --install`,
    );
  }

  const temporary = `${plan.file}.retire-${process.pid}-${randomBytes(6).toString("hex")}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, plan.filtered);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (process.platform !== "win32") chmodSync(temporary, 0o600);

    const beforeRenameStat = requireRegularFile(plan.file, "codex-swap JSONL log");
    const beforeRenameContents = readFileSync(plan.file);
    if (
      beforeRenameStat === null ||
      !sameIdentity(
        plan.identity,
        fileIdentity(beforeRenameStat, beforeRenameContents),
      )
    ) {
      throw new CleanupRefusedError(
        `codex-swap log changed during cleanup; rerun scripts/install.sh --install`,
      );
    }
    renameSync(temporary, plan.file);
    let directory;
    try {
      directory = openSync(path.dirname(plan.file), "r");
      fsyncSync(directory);
    } catch {
      // The file itself is durable; directory fsync is unavailable on some
      // platforms and filesystems.
    } finally {
      if (directory !== undefined) closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed successfully or never created.
    }
  }
}

function inspectAll(root) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    throw new CleanupRefusedError("refusing to use a filesystem root as CODEX_SWAP_HOME");
  }
  requireRealDirectory(resolved, "codex-swap data root");
  return {
    root: resolved,
    profiles: inspectProfiles(resolved),
    log: inspectLog(resolved),
    database: inspectDatabase(resolved),
  };
}

function renderSummary(plan, dryRun) {
  const verb = dryRun ? "would retire" : "retired";
  return (
    `codex-swap install: ${verb} ${plan.profiles.profiles} Pi profile(s), ` +
    `${plan.database.leases} lease(s), ${plan.database.events} event(s), and ` +
    `${plan.log.removed} log record(s)\n`
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run") || args.length > 1) {
    process.stderr.write("Usage: retire-pi-state.mjs [--dry-run]\n");
    return 64;
  }
  const dryRun = args[0] === "--dry-run";
  const plan = inspectAll(dataRoot(process.env));
  if (!dryRun) {
    cleanDatabase(plan.database);
    rewriteLog(plan.log);
    if (plan.profiles.present) {
      rmSync(plan.profiles.root, {
        recursive: true,
        force: false,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
    const verified = inspectAll(plan.root);
    if (
      verified.profiles.present ||
      verified.database.leases !== 0 ||
      verified.database.events !== 0 ||
      verified.database.rawRemnant ||
      verified.log.removed !== 0
    ) {
      throw new CleanupRefusedError(
        "Pi retirement verification found state after cleanup; rerun the installer",
      );
    }
  }
  process.stdout.write(renderSummary(plan, dryRun));
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-swap install: Pi retirement cleanup failed: ${message}\n`);
  process.exitCode = 1;
}
