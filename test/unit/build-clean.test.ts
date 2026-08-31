import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLEAN_SCRIPT = path.join(REPOSITORY_ROOT, "scripts", "clean-dist.mjs");

test("build cleanup removes stale deleted outputs before packaging", (context) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-swap-clean-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  const scripts = path.join(fixture, "scripts");
  const stale = path.join(fixture, "dist", "pi", "retired.js");
  const adjacent = path.join(fixture, "keep.txt");
  mkdirSync(path.dirname(stale), { recursive: true });
  mkdirSync(scripts);
  copyFileSync(CLEAN_SCRIPT, path.join(scripts, "clean-dist.mjs"));
  writeFileSync(stale, "stale deleted output\n");
  writeFileSync(adjacent, "preserve me\n");

  execFileSync(process.execPath, [path.join(scripts, "clean-dist.mjs")]);

  assert.equal(existsSync(path.join(fixture, "dist")), false);
  assert.equal(readFileSync(adjacent, "utf8"), "preserve me\n");

  const manifest = JSON.parse(
    readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  ) as { files?: string[]; scripts?: Record<string, string> };
  assert.ok(manifest.files?.includes("dist"), "the package surface is dist-backed");
  assert.equal(manifest.scripts?.["clean"], "node scripts/clean-dist.mjs");
  assert.equal(
    manifest.scripts?.["build"],
    "npm run clean && tsc -p tsconfig.build.json",
  );
  assert.equal(manifest.scripts?.["prepack"], "npm run build");
});
