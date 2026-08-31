import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
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
const FIRED_TEST_HOOKS = new Set();

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

function nodeIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameNodeIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileSnapshotIdentity(stat) {
  return {
    ...nodeIdentity(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function sameFileSnapshot(left, right) {
  return (
    sameNodeIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function openNoFollow(target, flags, mode) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  return openSync(target, flags | noFollow, mode);
}

function readStableRegularFile(target, label) {
  let descriptor;
  try {
    descriptor = openNoFollow(target, constants.O_RDONLY);
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw new CleanupRefusedError(
        `refusing ${label} at ${target}: expected a regular file`,
      );
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      !sameFileSnapshot(
        fileSnapshotIdentity(before),
        fileSnapshotIdentity(after),
      ) ||
      contents.length !== after.size
    ) {
      throw new CleanupRefusedError(
        `refusing ${label} at ${target}: file changed during inspection`,
      );
    }
    return {
      contents,
      identity: fileSnapshotIdentity(after),
    };
  } catch (error) {
    if (error instanceof CleanupRefusedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CleanupRefusedError(
      `refusing ${label} at ${target}: ${message}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function profileDirName(accountKey) {
  const sanitized = accountKey.replace(/[^A-Za-z0-9._-]+/g, "-");
  const digest = createHash("sha256").update(accountKey).digest("hex").slice(0, 8);
  return `${sanitized}-${digest}`;
}

function inspectOwnedTree(target, owningDevice) {
  const manifest = [];

  function visit(directory, relativeDirectory) {
    const before = lstatSync(directory);
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      before.dev !== owningDevice
    ) {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${directory} is not an owned local directory`,
      );
    }
    const entries = readdirSync(directory).sort();
    for (const entry of entries) {
      const child = path.join(directory, entry);
      const relative = path.join(relativeDirectory, entry);
      const stat = lstatSync(child);
      const identity = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs];
      if (stat.isSymbolicLink()) {
        const destination = readlinkSync(child);
        const after = lstatSync(child);
        if (!sameFileSnapshot(fileSnapshotIdentity(stat), fileSnapshotIdentity(after))) {
          throw new CleanupRefusedError(
            `refusing Pi profile cleanup: ${child} changed during inspection`,
          );
        }
        manifest.push(["link", relative, ...identity, destination]);
      } else if (stat.isDirectory()) {
        if (stat.dev !== owningDevice) {
          throw new CleanupRefusedError(
            `refusing Pi profile cleanup: ${child} is a mounted directory`,
          );
        }
        manifest.push(["directory", relative, ...identity]);
        visit(child, relative);
      } else if (stat.isFile()) {
        const snapshot = readStableRegularFile(child, "Pi profile file");
        if (!sameFileSnapshot(fileSnapshotIdentity(stat), snapshot.identity)) {
          throw new CleanupRefusedError(
            `refusing Pi profile cleanup: ${child} changed during inspection`,
          );
        }
        manifest.push([
          "file",
          relative,
          ...identity,
          createHash("sha256").update(snapshot.contents).digest("hex"),
        ]);
      } else {
        throw new CleanupRefusedError(
          `refusing Pi profile cleanup: ${child} is not a regular owned entry`,
        );
      }
    }
    const after = lstatSync(directory);
    const afterEntries = readdirSync(directory).sort();
    if (
      !sameNodeIdentity(nodeIdentity(before), nodeIdentity(after)) ||
      entries.length !== afterEntries.length ||
      entries.some((entry, index) => entry !== afterEntries[index])
    ) {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${directory} changed during inspection`,
      );
    }
  }

  visit(target, "");
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function inspectOwnedProfile(profileDir, entry, owningDevice) {
  const profileStat = requireRealDirectory(profileDir, "Pi account profile");
  if (profileStat === null || profileStat.dev !== owningDevice) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${profileDir} is not an owned local profile`,
    );
  }
  const metadataPath = path.join(profileDir, "profile.json");
  const metadataStat = requireRegularFile(metadataPath, "Pi profile metadata");
  if (metadataStat === null || metadataStat.dev !== owningDevice) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${metadataPath} does not prove codex-swap ownership`,
    );
  }
  const metadataBefore = readStableRegularFile(metadataPath, "Pi profile metadata");
  if (!sameNodeIdentity(nodeIdentity(metadataStat), metadataBefore.identity)) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${metadataPath} changed during inspection`,
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataBefore.contents.toString("utf8"));
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
  const fingerprint = inspectOwnedTree(profileDir, owningDevice);
  const metadataAfter = readStableRegularFile(metadataPath, "Pi profile metadata");
  if (
    !sameFileSnapshot(metadataBefore.identity, metadataAfter.identity) ||
    !metadataBefore.contents.equals(metadataAfter.contents)
  ) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${metadataPath} changed during inspection`,
    );
  }
  return {
    name: entry,
    path: profileDir,
    identity: nodeIdentity(profileStat),
    fingerprint,
  };
}

function inspectProfiles(root) {
  const piRoot = path.resolve(root, "pi");
  if (path.dirname(piRoot) !== root || path.basename(piRoot) !== "pi") {
    throw new CleanupRefusedError(`refusing unexpected Pi profile root: ${piRoot}`);
  }
  const piStat = requireRealDirectory(piRoot, "Pi profile root");
  if (piStat === null) {
    return {
      root: piRoot,
      present: false,
      profiles: 0,
      rootIdentity: null,
      profilesRoot: path.join(piRoot, "profiles"),
      profilesIdentity: null,
      entries: [],
    };
  }

  const rootEntries = readdirSync(piRoot);
  if (rootEntries.some((entry) => entry !== "profiles")) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${piRoot} contains an unowned entry`,
    );
  }
  const profilesRoot = path.join(piRoot, "profiles");
  const profilesStat = requireRealDirectory(profilesRoot, "Pi profiles directory");
  if (profilesStat === null) {
    return {
      root: piRoot,
      present: true,
      profiles: 0,
      rootIdentity: nodeIdentity(piStat),
      profilesRoot,
      profilesIdentity: null,
      entries: [],
    };
  }
  if (profilesStat.dev !== piStat.dev) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${profilesRoot} is a mounted directory`,
    );
  }

  const entries = [];
  for (const entry of readdirSync(profilesRoot).sort()) {
    if (/^\.staging-\d+$/.test(entry)) {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${entry} is an unverified interrupted link; inspect it and retry`,
      );
    }
    entries.push(
      inspectOwnedProfile(path.join(profilesRoot, entry), entry, piStat.dev),
    );
  }
  return {
    root: piRoot,
    present: true,
    profiles: entries.length,
    rootIdentity: nodeIdentity(piStat),
    profilesRoot,
    profilesIdentity: nodeIdentity(profilesStat),
    entries,
  };
}

function splitAndFilterLog(contents) {
  const redactions = [];
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
    if (retire) {
      removed += 1;
      // Keep the newline and the file's byte offsets stable. Replacing only
      // the retired record body lets append-only writers continue on this
      // inode without any suffix ever crossing a truncate or rename.
      if (cursor > start) redactions.push({ start, end: cursor });
    }
    start = chunkEnd;
  }
  return { redactions, removed };
}

function inspectLogGeneration(file, directoryStat, label) {
  const stat = requireRegularFile(file, label);
  if (stat === null) return { file, present: false, removed: 0 };
  if (directoryStat === null || stat.dev !== directoryStat.dev) {
    throw new CleanupRefusedError(
      `refusing Pi log cleanup: ${file} is not owned by its log directory`,
    );
  }
  const snapshot = readStableRegularFile(file, "codex-swap JSONL log");
  const filtered = splitAndFilterLog(snapshot.contents);
  return {
    file,
    present: true,
    removed: filtered.removed,
    original: snapshot.contents,
    identity: snapshot.identity,
  };
}

function logSurfaceSnapshot(directory, current) {
  const directoryStat = requireRealDirectory(directory, "codex-swap log directory");
  const entries = directoryStat === null ? [] : readdirSync(directory).sort();
  const generationIdentity = (file, label) => {
    const stat = requireRegularFile(file, label);
    return stat === null ? null : fileSnapshotIdentity(stat);
  };
  return {
    directoryIdentity:
      directoryStat === null ? null : nodeIdentity(directoryStat),
    entries,
    currentIdentity: generationIdentity(current, "codex-swap JSONL log"),
    rotatedIdentity: generationIdentity(
      `${current}.1`,
      "codex-swap rotated JSONL log",
    ),
  };
}

function sameOptionalFileSnapshot(left, right) {
  if (left === null || right === null) return left === right;
  return sameFileSnapshot(left, right);
}

function sameLogSurface(left, right) {
  const sameDirectory =
    left.directoryIdentity === null || right.directoryIdentity === null
      ? left.directoryIdentity === right.directoryIdentity
      : sameNodeIdentity(left.directoryIdentity, right.directoryIdentity);
  return (
    sameDirectory &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => entry === right.entries[index]) &&
    sameOptionalFileSnapshot(left.currentIdentity, right.currentIdentity) &&
    sameOptionalFileSnapshot(left.rotatedIdentity, right.rotatedIdentity)
  );
}

function inspectLogs(root, testHook) {
  const directory = logsDir(root);
  const directoryStat = requireRealDirectory(directory, "codex-swap log directory");
  const current = logFilePath(root);
  const before = logSurfaceSnapshot(directory, current);
  const currentGeneration = inspectLogGeneration(
    current,
    directoryStat,
    "codex-swap JSONL log",
  );
  if (testHook !== undefined) pauseForTestHook(root, testHook);
  const rotatedGeneration = inspectLogGeneration(
    `${current}.1`,
    directoryStat,
    "codex-swap rotated JSONL log",
  );
  const after = logSurfaceSnapshot(directory, current);
  if (!sameLogSurface(before, after)) {
    throw new CleanupRefusedError(
      "codex-swap logs changed during inspection; rerun scripts/install.sh --install",
    );
  }
  const generations = [rotatedGeneration, currentGeneration];
  return {
    generations,
    removed: generations.reduce((total, generation) => total + generation.removed, 0),
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

function pauseForTestHook(root, point) {
  if (
    process.env.CODEX_SWAP_RETIRE_TEST_HOOK !== point ||
    FIRED_TEST_HOOKS.has(point)
  ) {
    return;
  }
  FIRED_TEST_HOOKS.add(point);
  const base = path.join(root, `.retire-pi-test-${point}`);
  const ready = `${base}.ready`;
  const release = `${base}.release`;
  writeFileSync(ready, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  try {
    while (!existsSync(release)) {
      if (Date.now() >= deadline) {
        throw new CleanupRefusedError(
          `test hook ${point} timed out waiting for release`,
        );
      }
      Atomics.wait(sleeper, 0, 0, 10);
    }
  } finally {
    for (const marker of [ready, release]) {
      try {
        unlinkSync(marker);
      } catch {
        // The release marker may not exist when a timed-out test is aborted.
      }
    }
  }
}

function writeSpaces(descriptor, start, end) {
  const chunk = Buffer.alloc(Math.min(64 * 1024, end - start), 0x20);
  let position = start;
  while (position < end) {
    const length = Math.min(chunk.length, end - position);
    const written = writeSync(descriptor, chunk, 0, length, position);
    if (written <= 0) {
      throw new CleanupRefusedError(
        "codex-swap log redaction made no forward progress",
      );
    }
    position += written;
  }
}

function rewriteLogGeneration(plan, root) {
  if (!plan.present || plan.removed === 0) return;
  let descriptor;
  try {
    const directoryStat = requireRealDirectory(
      path.dirname(plan.file),
      "codex-swap log directory",
    );
    descriptor = openNoFollow(plan.file, constants.O_RDWR);
    const currentStat = fstatSync(descriptor);
    if (
      directoryStat === null ||
      !currentStat.isFile() ||
      currentStat.dev !== directoryStat.dev ||
      !sameNodeIdentity(plan.identity, nodeIdentity(currentStat))
    ) {
      throw new CleanupRefusedError(
        `codex-swap log changed during cleanup; rerun scripts/install.sh --install`,
      );
    }
    const currentContents = readFileSync(descriptor);
    if (
      currentContents.length < plan.original.length ||
      !currentContents.subarray(0, plan.original.length).equals(plan.original)
    ) {
      throw new CleanupRefusedError(
        `codex-swap log changed during cleanup; rerun scripts/install.sh --install`,
      );
    }
    const current = splitAndFilterLog(currentContents);
    pauseForTestHook(root, "log-snapshot");
    for (const redaction of current.redactions) {
      writeSpaces(descriptor, redaction.start, redaction.end);
    }
    fsyncSync(descriptor);
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (error instanceof CleanupRefusedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CleanupRefusedError(`codex-swap log cleanup failed: ${message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function rewriteLogs(plan, root) {
  for (const generation of plan.generations) {
    rewriteLogGeneration(generation, root);
  }
}

function sameProfileEvidence(left, right) {
  return (
    left.name === right.name &&
    sameNodeIdentity(left.identity, right.identity) &&
    left.fingerprint === right.fingerprint
  );
}

function sameProfileSnapshot(left, right) {
  if (left.present !== right.present) return false;
  if (!left.present) return true;
  if (
    !sameNodeIdentity(left.rootIdentity, right.rootIdentity) ||
    (left.profilesIdentity === null) !== (right.profilesIdentity === null)
  ) {
    return false;
  }
  if (
    left.profilesIdentity !== null &&
    !sameNodeIdentity(left.profilesIdentity, right.profilesIdentity)
  ) {
    return false;
  }
  return (
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) =>
      sameProfileEvidence(entry, right.entries[index]),
    )
  );
}

function makeProfileQuarantine(profilesRoot) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(
      profilesRoot,
      `.retire-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    try {
      mkdirSync(candidate, { mode: 0o700 });
      return {
        path: candidate,
        identity: nodeIdentity(lstatSync(candidate)),
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new CleanupRefusedError(
    "could not reserve a private Pi profile quarantine directory",
  );
}

function restoreClaim(claimed, original, quarantine) {
  try {
    if (statIfPresent(original) === null && statIfPresent(claimed) !== null) {
      renameSync(claimed, original);
    }
  } finally {
    try {
      rmdirSync(quarantine);
    } catch {
      // A claimed foreign or concurrently changed entry must survive for
      // inspection rather than being recursively removed.
    }
  }
}

function removeEmptyOwnedDirectory(target, identity, label) {
  const stat = requireRealDirectory(target, label);
  if (stat === null) return;
  if (!sameNodeIdentity(identity, nodeIdentity(stat))) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${target} was replaced during cleanup`,
    );
  }
  if (readdirSync(target).length !== 0) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${target} gained an unexpected entry`,
    );
  }
  try {
    rmdirSync(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${target} changed before removal: ${message}`,
    );
  }
}

function removeOwnedProfiles(initial) {
  const current = inspectProfiles(path.dirname(initial.root));
  if (!initial.present) {
    if (current.present) {
      throw new CleanupRefusedError(
        `refusing Pi profile cleanup: ${current.root} appeared during cleanup`,
      );
    }
    return;
  }
  if (!current.present) return;
  if (!sameProfileSnapshot(initial, current)) {
    throw new CleanupRefusedError(
      `refusing Pi profile cleanup: ${current.root} changed during cleanup`,
    );
  }

  for (const profile of current.entries) {
    pauseForTestHook(path.dirname(current.root), "profile-claim");
    const quarantine = makeProfileQuarantine(current.profilesRoot);
    const claimed = path.join(quarantine.path, profile.name);
    renameSync(profile.path, claimed);
    let claimedEvidence;
    try {
      claimedEvidence = inspectOwnedProfile(
        claimed,
        profile.name,
        current.rootIdentity.dev,
      );
      if (!sameProfileEvidence(profile, claimedEvidence)) {
        throw new CleanupRefusedError(
          `refusing Pi profile cleanup: ${profile.path} changed before removal`,
        );
      }
    } catch (error) {
      restoreClaim(claimed, profile.path, quarantine.path);
      throw error;
    }
    rmSync(claimed, { recursive: true, force: false });
    removeEmptyOwnedDirectory(
      quarantine.path,
      quarantine.identity,
      "Pi profile quarantine",
    );
  }

  if (current.profilesIdentity !== null) {
    removeEmptyOwnedDirectory(
      current.profilesRoot,
      current.profilesIdentity,
      "Pi profiles directory",
    );
  }
  removeEmptyOwnedDirectory(
    current.root,
    current.rootIdentity,
    "Pi profile root",
  );
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
    log: inspectLogs(resolved),
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
    rewriteLogs(plan.log, plan.root);
    const verifiedLogs = inspectLogs(plan.root, "log-verification");
    if (verifiedLogs.removed !== 0) {
      throw new CleanupRefusedError(
        "Pi retirement verification found a post-snapshot log record; rerun the installer",
      );
    }
    removeOwnedProfiles(plan.profiles);
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
