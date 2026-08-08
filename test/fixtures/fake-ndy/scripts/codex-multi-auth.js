#!/usr/bin/env node
// Fake codex-multi-auth manager CLI. Behavior is driven by FAKE_NDY_* env
// vars so integration tests can script every scenario without the network.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordInvocation } from "./record.js";

const args = process.argv.slice(2);
recordInvocation("manager", args);

const DEFAULT_STATUS = {
  storagePath: "/fake/openai-codex-accounts.json",
  storageHealth: "healthy",
  accountCount: 1,
  activeIndex: 0,
  pinnedAccountIndex: null,
  recommendedIndex: null,
  recommendationReason: "",
  runtimeInUseIndex: null,
  accounts: [
    {
      index: 0,
      label: "person@example.com (Personal)",
      enabled: true,
      current: true,
      markers: ["current"],
      lastUsed: 1754600000000,
      reason: null,
    },
  ],
};

const DEFAULT_HISTORY = {
  count: 2,
  sessions: [
    {
      id: "5973b6c0-94b8-487b-a530-2aeb6098ae0e",
      threadName: "native session",
      updatedAt: "2026-08-08T14:00:00Z",
      provider: "openai",
      originator: "codex_cli_rs",
      cwd: "/Users/example/project",
      path: "/fake/sessions/2026/08/08/rollout-a.jsonl",
    },
    {
      id: "11111111-2222-4333-8444-555555555555",
      threadName: "proxy session",
      updatedAt: "2026-08-08T13:00:00Z",
      provider: "codex-multi-auth-runtime-proxy",
      originator: "codex_cli_rs",
      cwd: "/Users/example/project",
      path: "/fake/sessions/2026/08/08/rollout-b.jsonl",
    },
  ],
};

const DEFAULT_HISTORY_DETAIL = {
  ...DEFAULT_HISTORY.sessions[0],
  cliVersion: "0.147.0",
  messages: ["first user message", "second user message"],
};

function emitJson(envName, fallback) {
  if (process.env.FAKE_NDY_MALFORMED === "1") {
    process.stdout.write("this is not json {{{\n");
    return;
  }
  const override = process.env[envName];
  process.stdout.write(`${override ?? JSON.stringify(fallback, null, 2)}\n`);
}

const command = args[0];

if (args.length === 1 && (command === "--version" || command === "-v")) {
  process.stdout.write("2.8.3\n");
  process.exit(0);
}

if (command === "login") {
  const addAccount = process.env.FAKE_NDY_LOGIN_ADD_ACCOUNT;
  if (addAccount) {
    const storeDir = process.env.CODEX_MULTI_AUTH_DIR;
    if (!storeDir) {
      process.stderr.write("fake-ndy: CODEX_MULTI_AUTH_DIR not set\n");
      process.exit(1);
    }
    const storePath = path.join(storeDir, "openai-codex-accounts.json");
    let store;
    try {
      store = JSON.parse(readFileSync(storePath, "utf8"));
    } catch {
      store = { version: 3, accounts: [], activeIndex: 0 };
    }
    store.accounts.push(JSON.parse(addAccount));
    writeFileSync(storePath, JSON.stringify(store, null, 2));
  }
  process.stderr.write("fake-ndy: login flow completed\n");
  process.exit(Number(process.env.FAKE_NDY_LOGIN_EXIT ?? "0"));
}

if (command === "status" || command === "list") {
  process.stderr.write("fake-ndy: status warning on stderr\n");
  emitJson("FAKE_NDY_STATUS_JSON", DEFAULT_STATUS);
  process.exit(0);
}

if (command === "history") {
  if (args[1] === "show") {
    const id = args.slice(2).find((a) => !a.startsWith("-"));
    if (!id) {
      process.stderr.write("fake-ndy: missing session id\n");
      process.exit(1);
    }
    if (process.env.FAKE_NDY_HISTORY_SHOW_MISSING === "1") {
      process.stderr.write(`fake-ndy: session not found: ${id}\n`);
      process.exit(1);
    }
    emitJson("FAKE_NDY_HISTORY_SHOW_JSON", { ...DEFAULT_HISTORY_DETAIL, id });
    process.exit(0);
  }
  emitJson("FAKE_NDY_HISTORY_JSON", DEFAULT_HISTORY);
  process.exit(0);
}

process.stderr.write(`fake-ndy: unknown command ${command}\n`);
process.exit(1);
