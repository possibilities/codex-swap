import { parseArgs } from "node:util";
import { commandIo, splitForwardedArgs } from "../command-io.ts";
import { ExitCode } from "../exit-codes.ts";
import { executeLaunch, parseLaunchMode } from "./run.ts";

const USAGE = `Usage: codex-swap resume <session-id> --account <selector> -- [codex args...]
       codex-swap resume <session-id> [--strategy [best|next-available]] [--allow-unknown] -- [codex args...]
       codex-swap resume <session-id> --claim <lease-id> -- [codex args...]

Resumes a session by explicit UUID under any usable account. Session IDs are
account-independent: all sessions live in the one canonical CODEX_HOME, so a
session created under account A resumes cleanly while pinned to account B.
The explicit-UUID path bypasses Codex's provider-filtered interactive picker;
'codex-swap history list' shows every resumable session across providers.
`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runResumeCommand(args: string[]): Promise<number> {
  const { own, forwarded } = splitForwardedArgs(args);

  let parsed;
  try {
    parsed = parseArgs({
      args: own,
      options: {
        account: { type: "string" },
        strategy: { type: "string" },
        claim: { type: "string" },
        "allow-unknown": { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap resume: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const sessionId = parsed.positionals[0];
  if (sessionId === undefined || parsed.positionals.length !== 1) {
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }
  if (!UUID_PATTERN.test(sessionId)) {
    // Only explicit UUIDs carry the complete-history contract; a non-UUID
    // would fall into Codex's provider-filtered name lookup (handoff §23.3).
    process.stderr.write(
      `codex-swap resume: '${sessionId}' is not a session UUID; find one with 'codex-swap history list'\n`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("resume", false);
  const { mode, error } = parseLaunchMode({
    account: parsed.values.account,
    strategy: parsed.values.strategy,
    claim: parsed.values.claim,
    allowUnknown: parsed.values["allow-unknown"],
  });
  if (error !== undefined) {
    process.stderr.write(`codex-swap resume: ${error}\n${USAGE}`);
    return ExitCode.usage;
  }
  // Bare `resume <id>` defaults to strategy selection.
  const launchMode =
    mode ?? { kind: "strategy" as const, strategy: null, allowUnknown: parsed.values["allow-unknown"] };

  return executeLaunch(
    launchMode,
    ["resume", sessionId, ...(forwarded ?? [])],
    io,
  );
}
