import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Resolves the package-local codex-multi-auth installation. We never rely on
 * a global install or ambient PATH: bins are spawned as
 * `process.execPath <absolute script path> ...args`.
 */
export interface NdyInstallation {
  packageRoot: string;
  version: string;
  bins: {
    /** The `codex-multi-auth` manager CLI (login, status, history, ...). */
    manager: string;
    /** The `codex-multi-auth-codex` forced-account Codex wrapper. */
    codexWrapper: string;
  };
}

/** Exact versions this codebase has been tested against (handoff §8, §34). */
export const SUPPORTED_NDY_VERSIONS: readonly string[] = ["2.10.0"];

export class NdyResolutionError extends Error {}

export class NdyVersionError extends Error {
  readonly installedVersion: string;

  constructor(installedVersion: string) {
    super(
      `codex-multi-auth ${installedVersion} is installed, but codex-swap is tested only against ` +
        `${SUPPORTED_NDY_VERSIONS.join(", ")}. Follow docs/handoff.md §34 before changing the pin.`,
    );
    this.installedVersion = installedVersion;
  }
}

interface NdyPackageJson {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
}

export function resolveNdyInstallation(options?: {
  /** Override the package root (tests, CODEX_SWAP_NDY_PACKAGE_DIR). */
  packageDir?: string;
}): NdyInstallation {
  let packageJsonPath: string;
  if (options?.packageDir !== undefined) {
    packageJsonPath = path.resolve(options.packageDir, "package.json");
  } else {
    const require = createRequire(import.meta.url);
    try {
      packageJsonPath = require.resolve("codex-multi-auth/package.json");
    } catch {
      throw new NdyResolutionError(
        "codex-multi-auth is not installed next to codex-swap; run `npm install` in the codex-swap package.",
      );
    }
  }

  let manifest: NdyPackageJson;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as NdyPackageJson;
  } catch (error) {
    throw new NdyResolutionError(
      `cannot read codex-multi-auth package.json at ${packageJsonPath}: ${String(error)}`,
    );
  }

  if (manifest.name !== "codex-multi-auth") {
    throw new NdyResolutionError(
      `package at ${packageJsonPath} is '${manifest.name ?? "unknown"}', expected 'codex-multi-auth'`,
    );
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new NdyResolutionError(
      `codex-multi-auth package.json at ${packageJsonPath} has no version`,
    );
  }

  const packageRoot = path.dirname(packageJsonPath);
  const resolveBin = (binName: string): string => {
    const relative = manifest.bin?.[binName];
    if (relative === undefined) {
      throw new NdyResolutionError(
        `codex-multi-auth ${manifest.version} does not declare the '${binName}' binary`,
      );
    }
    const absolute = path.resolve(packageRoot, relative);
    try {
      if (!statSync(absolute).isFile()) {
        throw new Error("not a file");
      }
    } catch {
      throw new NdyResolutionError(
        `codex-multi-auth binary '${binName}' is missing at ${absolute}`,
      );
    }
    return absolute;
  };

  return {
    packageRoot,
    version: manifest.version,
    bins: {
      manager: resolveBin("codex-multi-auth"),
      codexWrapper: resolveBin("codex-multi-auth-codex"),
    },
  };
}

export function assertSupportedNdyVersion(installation: NdyInstallation): void {
  if (!SUPPORTED_NDY_VERSIONS.includes(installation.version)) {
    throw new NdyVersionError(installation.version);
  }
}
