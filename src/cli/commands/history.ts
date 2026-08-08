import { parseArgs } from "node:util";
import { createNdyAdapter } from "../../ndy/adapter.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap history [list] [--json]
       codex-swap history show <session-id> [--json]

Lists rollout sessions from the canonical Codex home across ALL model
providers (native and proxy). Any listed session ID can be resumed under any
usable account with 'codex-swap resume <id>'.
`;

const PROVIDER_CAVEAT =
  "Note: Codex's own interactive resume picker filters by the current model provider;" +
  " this listing does not. Resume by explicit session ID for the complete-history contract.\n";

export async function runHistoryCommand(args: string[]): Promise<number> {
  const subcommand = args[0] === "list" || args[0] === "show" ? args[0] : "list";
  const rest = args[0] === "list" || args[0] === "show" ? args.slice(1) : args;

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap history: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo(
    subcommand === "show" ? "history show" : "history list",
    parsed.values.json,
  );

  try {
    const adapter = createNdyAdapter();

    if (subcommand === "show") {
      const sessionId = parsed.positionals[0];
      if (sessionId === undefined || sessionId.length === 0) {
        process.stderr.write(USAGE);
        return ExitCode.usage;
      }
      const detail = await adapter.historyShow(sessionId);
      emitSuccess(io, detail);
      if (!io.json) {
        process.stdout.write(`${detail.id}\n`);
        process.stdout.write(`  name:       ${detail.threadName}\n`);
        process.stdout.write(`  updated:    ${detail.updatedAt}\n`);
        process.stdout.write(`  provider:   ${detail.provider ?? "unknown"}\n`);
        process.stdout.write(`  cwd:        ${detail.cwd ?? "unknown"}\n`);
        process.stdout.write(`  cliVersion: ${detail.cliVersion ?? "unknown"}\n`);
        for (const message of detail.messages) {
          const flattened = message.replaceAll("\n", " ");
          const preview =
            flattened.length > 120 ? `${flattened.slice(0, 120)}…` : flattened;
          process.stdout.write(`  > ${preview}\n`);
        }
      }
      return ExitCode.success;
    }

    const list = await adapter.historyList();
    emitSuccess(io, { count: list.count, sessions: list.sessions });
    if (!io.json) {
      for (const session of list.sessions) {
        process.stdout.write(
          `${session.id}  ${session.updatedAt}  [${session.provider ?? "unknown"}]  ${session.threadName}\n`,
        );
      }
      process.stdout.write(`${list.count} session(s)\n`);
      process.stderr.write(PROVIDER_CAVEAT);
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  }
}
