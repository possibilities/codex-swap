import { readFileSync } from "node:fs";
import { settingsPath } from "../storage/paths.ts";
import { defaultSettings, settingsSchema, type Settings } from "./schema.ts";

/**
 * Loads settings.json from the data root. Missing file → defaults.
 * Malformed file → visible stderr diagnostic plus safe defaults
 * (handoff §26). The raw parsed object is returned alongside so writers can
 * preserve unknown fields on round trip.
 */
export interface LoadedSettings {
  settings: Settings;
  /** The raw on-disk object (unknown fields included), or null if absent/corrupt. */
  raw: Record<string, unknown> | null;
}

export function loadSettings(root: string): LoadedSettings {
  const file = settingsPath(root);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { settings: defaultSettings(), raw: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    process.stderr.write(
      `codex-swap: settings.json is not valid JSON (${String(error)}); using safe defaults\n`,
    );
    return { settings: defaultSettings(), raw: null };
  }

  const result = settingsSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.code}`)
      .join("; ");
    process.stderr.write(
      `codex-swap: settings.json failed validation (${issues}); using safe defaults\n`,
    );
    return { settings: defaultSettings(), raw: null };
  }
  return {
    settings: result.data,
    raw: raw as Record<string, unknown>,
  };
}
