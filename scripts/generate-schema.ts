#!/usr/bin/env node
// Regenerates schemas/settings.schema.json from the zod settings schema
// (docs/handoff.md §26). Run `npm run generate:schema` after touching
// src/config/schema.ts; test/unit/settings-schema.test.ts fails if the
// checked-in file drifts from what this produces.
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { settingsSchema } from "../src/config/schema.ts";

const TITLE = "codex-swap settings";
const DESCRIPTION =
  "Settings for codex-swap, stored as settings.json in the codex-swap data root. " +
  "Every field is optional: anything absent falls back to the documented default, " +
  "and unknown fields are preserved on round trip. A file that fails validation " +
  "produces a stderr diagnostic and safe defaults rather than an error.";

/**
 * The "input" io mode is deliberate: this schema describes what a human may
 * write on disk, where every defaulted field is omittable. The default
 * "output" mode marks defaulted fields required, which would make an editor
 * flag `{}` as invalid even though the loader accepts it.
 */
export function buildSettingsJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(settingsSchema, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return { $schema, title: TITLE, description: DESCRIPTION, ...rest };
}

/** The exact bytes that belong in schemas/settings.schema.json. */
export function renderSettingsJsonSchema(): string {
  return `${JSON.stringify(buildSettingsJsonSchema(), null, 2)}\n`;
}

export const schemaFileUrl = new URL(
  "../schemas/settings.schema.json",
  import.meta.url,
);

if (import.meta.main) {
  mkdirSync(new URL("../schemas/", import.meta.url), { recursive: true });
  writeFileSync(schemaFileUrl, renderSettingsJsonSchema());
  process.stdout.write(`wrote ${schemaFileUrl.pathname}\n`);
}
