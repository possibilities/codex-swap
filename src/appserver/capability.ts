import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { NdyInstallation } from "../ndy/bin-resolver.ts";
import type { Database } from "../storage/database.ts";
import type { Clock } from "../util/clock.ts";

/**
 * Can the resolved ndy host a resident, canonical-home app-server?
 *
 * This is a property of the ndy build, not of this machine, and getting it
 * wrong is expensive in both directions: a supervisor told "yes" by a build
 * that cannot host spawns a crash loop, and one told "no" by a build that can
 * stays idle forever. So codex-swap answers from the wrapper itself.
 *
 * The check reads `scripts/codex.js` — a binary ndy declares in `bin`, the
 * same supported boundary we spawn, not a `dist/lib` internal — and asks
 * whether `app-server` reaches the canonical-home transport. Stock 2.8.3
 * routes it to an ephemeral shadow home instead, where a server usually
 * cannot start at all (Codex rejects the shadow's symlinked
 * `app-server-control`) and, if it does, serves a frozen copy of the thread
 * index. See docs/handoff.md §39.1 and the upstream fix carried on the
 * codex-swap fork.
 *
 * The alternative — actually launching a server and watching what happens —
 * is more direct but costs ~20s of proxy startup per answer, and the deployed
 * consumer asks on every poll.
 */
export interface AppServerCapability {
  supported: boolean;
  ndyVersion: string;
  packageRoot: string;
  /** Human-readable reason, always present so a "no" is never bare. */
  detail: string;
  /** True when the answer came from the cache rather than a fresh read. */
  cached: boolean;
}

/**
 * The canonical-home routing, as it appears in a wrapper that has the fix.
 * Matched structurally rather than by version so any build carrying it —
 * our fork today, an upstream release tomorrow — answers yes on its own.
 */
const CANONICAL_APP_SERVER_ROUTING =
  /if\s*\(\s*isCodexAppServerCommand\(\s*rawArgs\s*\)\s*\)\s*\{[\s\S]{0,600}?useCanonicalHome:\s*true/;

/** Anything larger is not the wrapper we know how to reason about. */
const MAX_WRAPPER_BYTES = 4 * 1024 * 1024;

export function inspectWrapperSource(source: string): {
  supported: boolean;
  detail: string;
} {
  if (CANONICAL_APP_SERVER_ROUTING.test(source)) {
    return {
      supported: true,
      detail: "the wrapper routes app-server to the canonical Codex home",
    };
  }
  return {
    supported: false,
    detail:
      "this codex-multi-auth routes `app-server` through an ephemeral shadow home, where a " +
      "resident server cannot run: Codex refuses a symlinked <CODEX_HOME>/app-server-control, " +
      "and the shadow's copy of the thread index diverges from the canonical one. Install the " +
      "codex-swap fork (possibilities/codex-multi-auth, branch fix/app-server-canonical-home) " +
      "or a release that carries it, and point CODEX_SWAP_NDY_PACKAGE_DIR at it.",
  };
}

export function resolveAppServerCapability(options: {
  installation: NdyInstallation;
  db?: Database | undefined;
  clock: Clock;
  force?: boolean;
}): AppServerCapability {
  const { installation, db, clock } = options;
  const wrapper = installation.bins.codexWrapper;
  const base = {
    ndyVersion: installation.version,
    packageRoot: installation.packageRoot,
  };

  let stats;
  try {
    stats = statSync(wrapper);
  } catch (error) {
    return {
      ...base,
      supported: false,
      cached: false,
      detail: `cannot read the codex-multi-auth wrapper at ${wrapper}: ${String(error)}`,
    };
  }
  const mtimeMs = Math.round(stats.mtimeMs);

  if (db !== undefined && options.force !== true) {
    const cached = readCache(db, installation.packageRoot);
    if (
      cached !== null &&
      cached.ndyVersion === installation.version &&
      cached.wrapperSize === stats.size &&
      cached.wrapperMtimeMs === mtimeMs
    ) {
      return {
        ...base,
        supported: cached.supported,
        detail: cached.detail,
        cached: true,
      };
    }
  }

  if (stats.size > MAX_WRAPPER_BYTES) {
    return {
      ...base,
      supported: false,
      cached: false,
      detail: `the codex-multi-auth wrapper at ${wrapper} is unexpectedly large (${stats.size} bytes); refusing to classify it`,
    };
  }

  let source: string;
  try {
    source = readFileSync(wrapper, "utf8");
  } catch (error) {
    return {
      ...base,
      supported: false,
      cached: false,
      detail: `cannot read the codex-multi-auth wrapper at ${wrapper}: ${String(error)}`,
    };
  }

  const verdict = inspectWrapperSource(source);
  if (db !== undefined) {
    writeCache(db, {
      packageRoot: installation.packageRoot,
      ndyVersion: installation.version,
      wrapperSize: stats.size,
      wrapperMtimeMs: mtimeMs,
      supported: verdict.supported,
      detail: verdict.detail,
      checkedAtMs: clock(),
    });
  }
  return { ...base, ...verdict, cached: false };
}

/** The socket directory Codex requires to be a real directory, for diagnostics. */
export function appServerControlDir(codexHome: string): string {
  return path.join(codexHome, "app-server-control");
}

interface CacheRow {
  ndyVersion: string;
  wrapperSize: number;
  wrapperMtimeMs: number;
  supported: boolean;
  detail: string;
}

function readCache(db: Database, packageRoot: string): CacheRow | null {
  const raw = db.handle
    .prepare(`SELECT * FROM ndy_capability WHERE package_root = ?`)
    .get(packageRoot) as Record<string, unknown> | undefined;
  if (raw === undefined) return null;
  return {
    ndyVersion: raw["ndy_version"] as string,
    wrapperSize: raw["wrapper_size"] as number,
    wrapperMtimeMs: raw["wrapper_mtime_ms"] as number,
    supported: raw["canonical_app_server"] === 1,
    detail: (raw["detail"] as string | null) ?? "",
  };
}

function writeCache(
  db: Database,
  row: {
    packageRoot: string;
    ndyVersion: string;
    wrapperSize: number;
    wrapperMtimeMs: number;
    supported: boolean;
    detail: string;
    checkedAtMs: number;
  },
): void {
  db.immediate(() => {
    db.handle
      .prepare(
        `INSERT INTO ndy_capability (
           package_root, ndy_version, wrapper_size, wrapper_mtime_ms,
           canonical_app_server, detail, checked_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(package_root) DO UPDATE SET
           ndy_version = excluded.ndy_version,
           wrapper_size = excluded.wrapper_size,
           wrapper_mtime_ms = excluded.wrapper_mtime_ms,
           canonical_app_server = excluded.canonical_app_server,
           detail = excluded.detail,
           checked_at_ms = excluded.checked_at_ms`,
      )
      .run(
        row.packageRoot,
        row.ndyVersion,
        row.wrapperSize,
        row.wrapperMtimeMs,
        row.supported ? 1 : 0,
        row.detail,
        row.checkedAtMs,
      );
  });
}
