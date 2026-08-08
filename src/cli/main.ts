#!/usr/bin/env node
import process from "node:process";
import { ExitCode } from "./exit-codes.ts";
import { packageInfo } from "../package-info.ts";

const HELP = `codex-swap — multi-account balancing for the Codex CLI

Usage: codex-swap <command> [options]

Commands:
  auth add            Add an account through browser OAuth (--device-auth, --manual)
  accounts            Redacted account inventory
  snapshot            Coherent account/usage/health/recommendation snapshot
  usage               Store-governed usage view
  select              Explain or atomically claim an account selection
  run                 Select/pin an account and launch Codex
  history             Provider-independent session list
  resume              Resume a session by ID under any usable account
  leases              Inspect invocation leases
  doctor              Dependency, storage, and permission checks
  config              Show or edit validated configuration
  version             Print the codex-swap version

Options:
  --json              Machine output: one envelope object on stdout
  -h, --help          Show this help

Exit codes: 0 success · 1 failure · 2 usage · 3 no eligible account
            4 re-login required · 5 dependency unavailable · 130 interrupted
`;

import { runAccountsCommand } from "./commands/accounts.ts";
import { runAuthCommand } from "./commands/auth.ts";
import { runHistoryCommand } from "./commands/history.ts";
import { runRunCommand } from "./commands/run.ts";
import { runSnapshotCommand } from "./commands/snapshot.ts";
import { runUsageCommand } from "./commands/usage.ts";

type CommandHandler = (args: string[]) => Promise<number>;

const commands = new Map<string, CommandHandler>([
  ["auth", runAuthCommand],
  ["accounts", runAccountsCommand],
  ["snapshot", runSnapshotCommand],
  ["usage", runUsageCommand],
  ["run", runRunCommand],
  ["history", runHistoryCommand],
]);

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    process.stdout.write(HELP);
    return command === undefined ? ExitCode.usage : ExitCode.success;
  }

  if (command === "version" || command === "--version" || command === "-V") {
    process.stdout.write(`${packageInfo().version}\n`);
    return ExitCode.success;
  }

  const handler = commands.get(command);
  if (handler === undefined) {
    process.stderr.write(
      `codex-swap: unknown command '${command}' (see codex-swap --help)\n`,
    );
    return ExitCode.usage;
  }
  return handler(rest);
}

dispatch(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codex-swap: ${message}\n`);
    process.exitCode = ExitCode.failure;
  },
);
