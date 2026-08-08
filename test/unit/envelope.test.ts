import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENVELOPE_SCHEMA_VERSION,
  errorEnvelope,
  renderEnvelope,
  successEnvelope,
} from "../../src/cli/output.ts";
import { ExitCode } from "../../src/cli/exit-codes.ts";
import { toIsoUtc } from "../../src/util/clock.ts";

const NOW_MS = Date.UTC(2026, 7, 8, 20, 0, 0);

test("successEnvelope carries versioned shape with null error", () => {
  const envelope = successEnvelope("snapshot", { accounts: [] }, NOW_MS);
  assert.deepEqual(envelope, {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    command: "snapshot",
    generatedAt: "2026-08-08T20:00:00.000Z",
    data: { accounts: [] },
    error: null,
  });
});

test("errorEnvelope carries null data and structured error", () => {
  const envelope = errorEnvelope(
    "select",
    {
      code: "NO_ELIGIBLE_ACCOUNT",
      message: "No account has decision-grade quota.",
      retryable: true,
      details: { nextReadyAt: null },
    },
    NOW_MS,
  );
  assert.equal(envelope.data, null);
  assert.equal(envelope.error?.code, "NO_ELIGIBLE_ACCOUNT");
  assert.equal(envelope.schemaVersion, 1);
});

test("renderEnvelope emits exactly one object and one trailing newline", () => {
  const rendered = renderEnvelope(successEnvelope("accounts", [], NOW_MS));
  assert.ok(rendered.endsWith("\n"));
  assert.equal(rendered.indexOf("\n"), rendered.length - 1);
  const parsed = JSON.parse(rendered) as { command: string };
  assert.equal(parsed.command, "accounts");
});

test("exit codes match the documented contract", () => {
  assert.equal(ExitCode.success, 0);
  assert.equal(ExitCode.failure, 1);
  assert.equal(ExitCode.usage, 2);
  assert.equal(ExitCode.noEligibleAccount, 3);
  assert.equal(ExitCode.reloginRequired, 4);
  assert.equal(ExitCode.dependencyUnavailable, 5);
  assert.equal(ExitCode.interrupted, 130);
});

test("toIsoUtc renders epoch ms as ISO 8601 UTC", () => {
  assert.equal(toIsoUtc(0), "1970-01-01T00:00:00.000Z");
  assert.equal(toIsoUtc(NOW_MS), "2026-08-08T20:00:00.000Z");
});
