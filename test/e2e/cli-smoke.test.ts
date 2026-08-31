import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageInfo } from "../../src/package-info.ts";

const execFileAsync = promisify(execFile);
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const ROOT = mkdtempSync(path.join(os.tmpdir(), "codex-swap-cli-smoke-"));
const SWAP_HOME = path.join(ROOT, "swap");
after(() => rmSync(ROOT, { recursive: true, force: true }));

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [MAIN, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_SWAP_HOME: SWAP_HOME,
          CODEX_HOME: path.join(ROOT, "codex"),
          CODEX_MULTI_AUTH_DIR: path.join(ROOT, "ndy"),
          CODEX_SWAP_UNSAFE_USAGE_BASE_URL: "http://127.0.0.1:9",
        },
      },
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

test("retired command spellings are never persisted as log command names", async () => {
  const retired = String.fromCharCode(112, 105);
  const result = await runCli([retired]);
  assert.equal(result.code, 2);
  const log = readFileSync(
    path.join(SWAP_HOME, "logs", "codex-swap.jsonl"),
    "utf8",
  );
  const records = log.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.at(-1)?.command, "unknown");
  assert.equal(log.includes(`"command":"${retired}"`), false);
});

test("bare invocation prints help and exits 2", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /Usage: codex-swap <command>/);
});
