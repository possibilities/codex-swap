import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildSettingsJsonSchema,
  renderSettingsJsonSchema,
  schemaFileUrl,
} from "../../scripts/generate-schema.ts";
import { defaultSettings, settingsSchema } from "../../src/config/schema.ts";

const REGENERATE = "run `npm run generate:schema` and commit the result";

test("checked-in settings.schema.json matches the zod schema", () => {
  const onDisk = readFileSync(schemaFileUrl, "utf8");
  assert.deepEqual(
    JSON.parse(onDisk),
    buildSettingsJsonSchema(),
    `schemas/settings.schema.json is stale — ${REGENERATE}`,
  );
  assert.equal(
    onDisk,
    renderSettingsJsonSchema(),
    `schemas/settings.schema.json formatting drifted — ${REGENERATE}`,
  );
});

test("generated schema keeps settings.json optional and open", () => {
  const generated = buildSettingsJsonSchema();
  // Every field has a default, so a hand-written settings.json may omit
  // anything; the loader accepts {}. Unknown fields survive round trip, so
  // the schema must not close any object either.
  assert.equal(generated["required"], undefined);
  const sections = generated["properties"] as Record<
    string,
    Record<string, unknown>
  >;
  for (const name of ["selection", "usage", "leases"]) {
    const section = sections[name];
    assert.ok(section, `missing section ${name}`);
    assert.equal(section["required"], undefined, `${name} must stay optional`);
    assert.deepEqual(
      section["additionalProperties"],
      {},
      `${name} must stay open to unknown fields`,
    );
  }
});

test("$schema is inert: absent from defaults, harmless when malformed", () => {
  assert.ok(!("$schema" in defaultSettings()));

  const hint = "./schemas/settings.schema.json";
  assert.equal(settingsSchema.parse({ $schema: hint })["$schema"], hint);

  // A malformed hint must not fail validation: the loader would otherwise
  // degrade every real setting to its default over a field nothing reads.
  // It is dropped from the parsed view (left as an own `undefined` key, which
  // JSON.stringify omits); the on-disk value survives because writers round
  // trip the raw object, not this one.
  for (const bad of [123, null, [], {}]) {
    const parsed = settingsSchema.safeParse({ $schema: bad, schemaVersion: 1 });
    assert.ok(parsed.success, `$schema: ${JSON.stringify(bad)} must not reject`);
    assert.equal(
      JSON.stringify(parsed.data),
      JSON.stringify(defaultSettings()),
      `$schema: ${JSON.stringify(bad)} must not alter emitted settings`,
    );
  }
});
