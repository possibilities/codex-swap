#!/usr/bin/env node
// Fake codex-multi-auth-codex forced-account wrapper. Mirrors 2.8.5
// semantics that matter to codex-swap: --account/--account=<v> extraction,
// fail-hard exit 1 without launching, and signal-driven exits.
import { recordInvocation } from "./record.js";

const args = process.argv.slice(2);
recordInvocation("codex", args);

const mode = process.env.FAKE_NDY_CODEX_MODE ?? "ok";

if (mode === "fail-account") {
  process.stderr.write(
    "codex-multi-auth: --account requires the runtime rotation proxy, which is not active for this command.\n",
  );
  process.exit(1);
}

if (mode === "hang") {
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  // Hangs until signalled, but never forever: the crash test kills only the
  // parent, so this is deliberately orphaned and nothing is left to reap it.
  // The ceiling is far longer than any test needs and short enough that a
  // stray child cannot outlive a CI job.
  setTimeout(() => process.exit(75), 60_000);
} else {
  process.exit(Number(process.env.FAKE_NDY_CODEX_EXIT ?? "0"));
}
