import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSettings } from "../../config/load.ts";
import { settingsSchema } from "../../config/schema.ts";
import { dataRoot, settingsPath } from "../../storage/paths.ts";
import { ensurePrivateDir, tightenFileMode } from "../../storage/permissions.ts";
import { commandIo, emitFailure, emitSuccess } from "../command-io.ts";
import { ExitCode } from "../exit-codes.ts";

const USAGE = `Usage: codex-swap config show [--json]
       codex-swap config set <dotted.path> <value>
       codex-swap config unset <dotted.path>

Validated settings (settings.json in the codex-swap data root). Values parse
as JSON where possible ("true", "300000", '"best"'), else as strings. Writes
are atomic and preserve unknown fields; invalid results are rejected before
anything is written.
`;

function getPath(target: Record<string, unknown>, segments: string[]): unknown {
  let cursor: unknown = target;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function setPath(
  target: Record<string, unknown>,
  segments: string[],
  value: unknown,
): void {
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  if (value === undefined) {
    delete cursor[last];
  } else {
    cursor[last] = value;
  }
}

function atomicWriteSettings(root: string, contents: string): void {
  ensurePrivateDir(root);
  const target = settingsPath(root);
  const temp = path.join(root, `.settings-${randomUUID()}.tmp`);
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, target);
  tightenFileMode(target);
}

export async function runConfigCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  const root = dataRoot(process.env);

  if (subcommand === "show" || subcommand === undefined) {
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: { json: { type: "boolean", default: false } },
        allowPositionals: false,
      });
    } catch (error) {
      process.stderr.write(
        `codex-swap config: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
      );
      return ExitCode.usage;
    }
    const io = commandIo("config show", parsed.values.json);
    const { settings } = loadSettings(root);
    emitSuccess(io, { path: settingsPath(root), settings });
    if (!io.json) {
      process.stdout.write(`${settingsPath(root)}\n`);
      process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
    }
    return ExitCode.success;
  }

  if (subcommand !== "set" && subcommand !== "unset") {
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }

  const io = commandIo(`config ${subcommand}`, false);
  const dotted = rest[0];
  if (dotted === undefined || dotted.length === 0) {
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }
  const segments = dotted.split(".");

  let value: unknown;
  if (subcommand === "set") {
    const rawValue = rest[1];
    if (rawValue === undefined) {
      process.stderr.write(USAGE);
      return ExitCode.usage;
    }
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
  }

  const { raw } = loadSettings(root);
  const next: Record<string, unknown> = raw !== null ? structuredClone(raw) : {};
  if (next["schemaVersion"] === undefined) next["schemaVersion"] = 1;
  if (subcommand === "unset" && getPath(next, segments) === undefined) {
    return emitFailure(
      io,
      {
        code: "INVALID_ARGUMENTS",
        message: `'${dotted}' is not set`,
        retryable: false,
      },
      ExitCode.usage,
    );
  }
  setPath(next, segments, subcommand === "set" ? value : undefined);

  const validated = settingsSchema.safeParse(next);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.code}`)
      .join("; ");
    return emitFailure(
      io,
      {
        code: "INVALID_ARGUMENTS",
        message: `rejected: settings would fail validation (${issues})`,
        retryable: false,
      },
      ExitCode.usage,
    );
  }

  atomicWriteSettings(root, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(
    subcommand === "set"
      ? `${dotted} = ${JSON.stringify(value)}\n`
      : `${dotted} unset\n`,
  );
  return ExitCode.success;
}
