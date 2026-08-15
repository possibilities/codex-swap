#!/usr/bin/env node
// Automated slice of the dependency upgrade checklist (docs/handoff.md §34).
// Run before and after changing the codex-multi-auth pin; a clean pass does
// NOT replace the manual checklist items (release notes, forced-account
// behavior, two-account acceptance).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const manifestPath = require.resolve("codex-multi-auth/package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const root = path.dirname(manifestPath);

const ourManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const pinned = ourManifest.dependencies["codex-multi-auth"];

check("exact pin (no range)", /^\d+\.\d+\.\d+$/.test(pinned), pinned);
check("installed matches pin", manifest.version === pinned, manifest.version);

const expectedBins = [
  "codex-multi-auth",
  "codex-multi-auth-codex",
];
for (const bin of expectedBins) {
  check(`bin ${bin}`, typeof manifest.bin?.[bin] === "string", manifest.bin?.[bin]);
}

const expectedExports = ["./auth", "./storage", "./config", "./request", "./package.json"];
for (const subpath of expectedExports) {
  check(`export ${subpath}`, manifest.exports?.[subpath] !== undefined);
}

check(
  "postinstall stays inert",
  manifest.scripts?.preinstall === undefined && manifest.scripts?.install === undefined,
  `postinstall=${manifest.scripts?.postinstall ?? "none"}`,
);

// Containment env vars must still exist in the shipped code, and the quota
// sweep must still honor the interval kill switch.
const wrapperSource = readFileSync(path.join(root, "scripts/codex.js"), "utf8");
const sweepChecks = [
  "CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS",
  "CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX",
  "CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE",
  "CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP",
];
for (const name of sweepChecks) {
  check(`wrapper reads ${name}`, wrapperSource.includes(name));
}

const storageDts = readFileSync(path.join(root, "dist/lib/storage.d.ts"), "utf8");
for (const symbol of [
  "loadAccounts",
  "setStoragePathDirect",
  "withAccountStorageTransaction",
]) {
  check(`storage exports ${symbol}`, storageDts.includes(`function ${symbol}`));
}
const authDts = readFileSync(path.join(root, "dist/lib/auth/index.d.ts"), "utf8");
const authAuthDts = (() => {
  try {
    return readFileSync(path.join(root, "dist/lib/auth/auth.d.ts"), "utf8");
  } catch {
    return "";
  }
})();
check(
  "auth exports refreshAccessToken",
  authDts.includes("refreshAccessToken") || authAuthDts.includes("refreshAccessToken"),
);

// Family-aware selection (docs/adr/0006) consumes three more CLI surfaces
// and one more storage field; a pin bump must re-verify each.
const accountsDts = readFileSync(path.join(root, "dist/lib/accounts.d.ts"), "utf8");
check(
  "storage records carry rateLimitResetTimes",
  accountsDts.includes("rateLimitResetTimes"),
);
const modelMapSource = readFileSync(
  path.join(root, "dist/lib/request/helpers/model-map.js"),
  "utf8",
);
check("models matrix carries promptFamily", modelMapSource.includes("promptFamily"));
const forecastSource = readFileSync(path.join(root, "dist/lib/forecast.js"), "utf8");
for (const field of ["availability", "liveQuota", "waitMs"]) {
  check(`forecast emits ${field}`, forecastSource.includes(field));
}
const rotationSource = readFileSync(
  path.join(root, "dist/lib/codex-manager/commands/rotation.js"),
  "utf8",
);
check(
  "rotation reset-rate-limits reports clearedRateLimitKeys",
  rotationSource.includes("clearedRateLimitKeys"),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} contract check(s) failed — follow docs/handoff.md §34 before upgrading.`);
  process.exit(1);
}
console.log("\nAll automated contract checks passed. Manual checklist still applies (docs/handoff.md §34).");
