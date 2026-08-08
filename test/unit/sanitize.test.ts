import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logToFile } from "../../src/logging/logger.ts";
import { logFilePath } from "../../src/storage/paths.ts";
import { sanitizeString, sanitizeValue } from "../../src/logging/sanitize.ts";

const JWT =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjE3NTQ2MDAwMDB9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const REFRESH = "rt-9f8e7d6c5b4a39281706f5e4d3c2b1a0-9f8e7d6c5b4a3928";

test("sanitizeString scrubs JWTs, bearer headers, callback URLs, and emails", () => {
  assert.equal(sanitizeString(`token: ${JWT}`), "token: [jwt]");
  assert.ok(!sanitizeString(`Authorization: Bearer ${JWT}`).includes("eyJ"));
  assert.equal(
    sanitizeString("https://auth.example/cb?code=abc123&state=xyz"),
    "https://auth.example/cb?code=[redacted]&state=[redacted]",
  );
  assert.equal(sanitizeString("person@example.com asked"), "[email] asked");
  assert.ok(!sanitizeString(`"refresh_token":"${REFRESH}"`).includes(REFRESH));
  const longSecret = "A".repeat(64);
  assert.ok(!sanitizeString(`key ${longSecret}`).includes(longSecret));
});

test("sanitizeValue redacts secret-named keys at any depth", () => {
  const sanitized = sanitizeValue({
    level: "info",
    accessToken: "super-secret",
    nested: {
      refreshToken: REFRESH,
      note: `contact person@example.com with ${JWT}`,
      count: 3,
    },
  }) as Record<string, unknown>;
  assert.equal(sanitized["accessToken"], "[redacted]");
  const nested = sanitized["nested"] as Record<string, unknown>;
  assert.equal(nested["refreshToken"], "[redacted]");
  assert.equal(nested["count"], 3);
  const note = nested["note"] as string;
  assert.ok(!note.includes("person@example.com"));
  assert.ok(!note.includes("eyJ"));
});

test("logToFile writes sanitized JSONL and never throws", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "log-"));
  logToFile(
    root,
    {
      event: "usage_fetch_failed",
      error: `401 with Authorization: Bearer ${JWT}`,
      email: "person@example.com",
    },
    Date.UTC(2026, 7, 8),
  );
  const contents = readFileSync(logFilePath(root), "utf8");
  assert.ok(!contents.includes("eyJ"), "no JWT in log");
  assert.ok(!contents.includes("person@example.com"), "no email in log");
  const record = JSON.parse(contents.trim()) as { event: string; ts: string };
  assert.equal(record.event, "usage_fetch_failed");
  assert.equal(record.ts, "2026-08-08T00:00:00.000Z");

  // Unwritable root: silently ignored.
  logToFile("/dev/null/impossible", { event: "x" });
});
