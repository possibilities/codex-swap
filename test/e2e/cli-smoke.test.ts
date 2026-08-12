import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageInfo } from "../../src/package-info.ts";

const execFileAsync = promisify(execFile);
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [MAIN, ...args],
      { encoding: "utf8" },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

test("codex-swap version prints the package version", async () => {
  const result = await runCli(["version"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), packageInfo().version);
});

test("unknown command exits 2 with guidance on stderr, nothing on stdout", async () => {
  const result = await runCli(["frobnicate"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown command 'frobnicate'/);
});

test("retired app-server command is no longer registered", async () => {
  const result = await runCli(["app-server", "check"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown command 'app-server'/);
});

test("bare invocation prints help and exits 2", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /Usage: codex-swap <command>/);
});
