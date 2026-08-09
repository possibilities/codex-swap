#!/usr/bin/env node
/**
 * Stand-in for the pi CLI in e2e tests. Behavior is driven by env:
 *  - FAKE_PI_LOGIN_AS / FAKE_PI_LOGIN_EMAIL: simulate a completed /login by
 *    writing an openai-codex oauth credential (unsigned JWT carrying the
 *    identity claim) into $PI_CODING_AGENT_DIR/auth.json, then exit.
 *  - FAKE_PI_RECORD: append one JSONL record of argv + the env pins.
 *  - FAKE_PI_EXIT: exit code to return (default 0).
 * `fake-pi --version` prints a version like the real CLI.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("fake-pi 0.0.1\n");
  process.exit(0);
}

const agentDir = process.env.PI_CODING_AGENT_DIR;

const loginAs = process.env.FAKE_PI_LOGIN_AS;
if (loginAs !== undefined && agentDir !== undefined) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = {
    "https://api.openai.com/auth": { chatgpt_account_id: loginAs },
    email: process.env.FAKE_PI_LOGIN_EMAIL ?? null,
  };
  const access = `${b64({ alg: "none" })}.${b64(payload)}.sig`;
  writeFileSync(
    path.join(agentDir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        refresh: "fake-refresh-token",
        access,
        expires: Date.now() + 3_600_000,
        // The real pi stores the extracted claim alongside the tokens.
        accountId: loginAs,
      },
    }),
    { mode: 0o600 },
  );
}

const recordPath = process.env.FAKE_PI_RECORD;
if (recordPath !== undefined) {
  appendFileSync(
    recordPath,
    `${JSON.stringify({
      argv,
      agentDir: agentDir ?? null,
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR ?? null,
      cwd: process.cwd(),
    })}\n`,
  );
}

process.exit(Number(process.env.FAKE_PI_EXIT ?? "0"));
