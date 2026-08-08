import { readFileSync } from "node:fs";

export interface PackageInfo {
  name: string;
  version: string;
}

let cached: PackageInfo | undefined;

/**
 * Resolves ../package.json relative to this module, which is the repo root
 * both when running src/ directly under type stripping and when running the
 * compiled dist/ tree.
 */
export function packageInfo(): PackageInfo {
  if (cached === undefined) {
    const raw = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    cached = { name: raw.name, version: raw.version };
  }
  return cached;
}
