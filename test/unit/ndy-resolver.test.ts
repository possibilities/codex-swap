import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSupportedNdyVersion,
  NdyResolutionError,
  NdyVersionError,
  resolveNdyInstallation,
  SUPPORTED_NDY_VERSIONS,
} from "../../src/ndy/bin-resolver.ts";
import {
  NDY_CONTAINMENT_ENV,
  withNdyContainment,
} from "../../src/ndy/environment.ts";

function writeFakePackage(overrides?: {
  name?: string;
  version?: string;
  omitBins?: string[];
}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-swap-fake-ndy-"));
  const bins: Record<string, string> = {
    "codex-multi-auth": "scripts/codex-multi-auth.js",
    "codex-multi-auth-codex": "scripts/codex.js",
  };
  for (const omitted of overrides?.omitBins ?? []) {
    delete bins[omitted];
  }
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const rel of Object.values(bins)) {
    writeFileSync(path.join(dir, rel), "#!/usr/bin/env node\n");
  }
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: overrides?.name ?? "codex-multi-auth",
      version: overrides?.version ?? "2.8.3",
      bin: bins,
    }),
  );
  return dir;
}

test("resolves the real package-local installation", () => {
  const installation = resolveNdyInstallation();
  assert.equal(installation.version, "2.8.3");
  assert.ok(installation.bins.manager.endsWith("codex-multi-auth.js"));
  assert.ok(installation.bins.codexWrapper.endsWith("codex.js"));
  assert.doesNotThrow(() => assertSupportedNdyVersion(installation));
});

test("packageDir override resolves a fake installation", () => {
  const dir = writeFakePackage();
  const installation = resolveNdyInstallation({ packageDir: dir });
  assert.equal(installation.packageRoot, dir);
  assert.equal(
    installation.bins.codexWrapper,
    path.join(dir, "scripts", "codex.js"),
  );
});

test("rejects a package with the wrong name", () => {
  const dir = writeFakePackage({ name: "not-ndy" });
  assert.throws(
    () => resolveNdyInstallation({ packageDir: dir }),
    NdyResolutionError,
  );
});

test("rejects a package missing a declared binary", () => {
  const dir = writeFakePackage({ omitBins: ["codex-multi-auth-codex"] });
  assert.throws(
    () => resolveNdyInstallation({ packageDir: dir }),
    NdyResolutionError,
  );
});

test("version guard rejects untested versions with guidance", () => {
  const dir = writeFakePackage({ version: "9.9.9" });
  const installation = resolveNdyInstallation({ packageDir: dir });
  assert.throws(
    () => assertSupportedNdyVersion(installation),
    (error: unknown) =>
      error instanceof NdyVersionError &&
      error.installedVersion === "9.9.9" &&
      /docs\/handoff\.md/.test(error.message),
  );
  assert.ok(SUPPORTED_NDY_VERSIONS.includes("2.8.3"));
});

test("containment env suppresses app-bind, launcher, statusline, and quota sweep", () => {
  const env = withNdyContainment({ PATH: "/usr/bin", HOME: "/tmp/h" });
  assert.equal(env["CODEX_MULTI_AUTH_APP_BIND"], "0");
  assert.equal(env["CODEX_MULTI_AUTH_APP_BIND_INSTALL"], "0");
  assert.equal(env["CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL"], "0");
  assert.equal(env["CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE"], "0");
  assert.equal(env["CODEX_MULTI_AUTH_STATUSLINE"], "0");
  assert.equal(env["CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS"], "0");
  assert.equal(env["PATH"], "/usr/bin");
});

test("containment never disables the runtime rotation proxy", () => {
  assert.ok(
    !("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY" in NDY_CONTAINMENT_ENV),
    "forced-account invocation requires the runtime proxy to stay enabled",
  );
  const env = withNdyContainment({});
  assert.equal(env["CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY"], undefined);
});
