import os from "node:os";
import path from "node:path";

/**
 * Containment environment for every ndy child process (handoff §7.3, expanded
 * after source review of 2.8.3 — see docs/handoff.md §34 before changing).
 *
 * Suppressed, with the exact spellings ndy reads:
 * - Codex desktop-app binding and launcher/shortcut installs (first-run and
 *   rotation-enable paths).
 * - `~/.codex/config.toml` rewrites: both the writer-level
 *   ENFORCE_CLI_FILE_AUTH_STORE gate and the wrapper-level
 *   FORCE_FILE_AUTH_STORE gate (only the literal "0" disables them).
 * - Mirroring state into the official CLI's auth files (SYNC_CODEX_CLI
 *   master switch and the wrapper's AUTO_SYNC_ON_STARTUP).
 * - The stderr status line.
 * - The detached full-pool background quota sweep
 *   (STATUS_QUOTA_REFRESH_INTERVAL_MS <= 0 disables it), which would defeat
 *   our per-account scheduler.
 * - Background network activity that duplicates codex-swap's job or races
 *   our credential broker: startup prewarm fetch, proactive OAuth refresh,
 *   preemptive quota probing, email hydration, npm update-notice fetch.
 * - Per-project account pools, so every child resolves the same store.
 *
 * CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY is deliberately NOT set: forced
 * account invocation requires the runtime proxy. CODEX_MULTI_AUTH_BYPASS
 * must never be set either — it disables `--account` entirely.
 *
 * CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT must never be inherited either:
 * when set to "1" the wrapper spawns the real Codex CLI with stdout/stderr
 * piped instead of inherited (its own auto-detect fallback otherwise keys
 * off its own stdio, which our launch always attaches to a real terminal),
 * so a stale override from the parent env would silently break interactive
 * sessions with "stdout is not a terminal".
 *
 * CODEX_CI must never be inherited either: the pinned wrapper's
 * shouldCaptureForwardedCodexOutput() (scripts/codex.js) treats an
 * inherited CODEX_CI="1" as an independent force-true path — ahead of its
 * own isTTY auto-detect fallback — so a CI-flavored manager/orchestrator
 * environment (this one included) would force piped stdio on every ndy
 * child even when CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT is unset.
 */
export const NDY_CONTAINMENT_ENV: Readonly<Record<string, string>> = {
  CODEX_MULTI_AUTH_APP_BIND: "0",
  CODEX_MULTI_AUTH_APP_BIND_INSTALL: "0",
  CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: "0",
  CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE: "0",
  CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE: "0",
  CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP: "0",
  CODEX_MULTI_AUTH_SYNC_CODEX_CLI: "0",
  CODEX_MULTI_AUTH_STATUSLINE: "0",
  CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS: "0",
  CODEX_MULTI_AUTH_UPDATE_NOTICE_STARTUP_BUDGET_MS: "0",
  CODEX_AUTH_PREWARM: "0",
  CODEX_AUTH_PROACTIVE_GUARDIAN: "0",
  CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED: "0",
  CODEX_AUTH_PER_PROJECT_ACCOUNTS: "0",
  CODEX_SKIP_EMAIL_HYDRATE: "1",
  // Already-routed sentinel (AgentLaunch ADR 0004): PATH shims that
  // balance bare harness calls exec the real binary when they see it, so a
  // wrapper-spawned `codex` is never re-balanced onto a different account.
  AGENTLAUNCH_LAUNCH: "1",
};

/**
 * The one multi-auth state directory every codex-swap operation uses,
 * mirroring ndy's primary resolution (CODEX_MULTI_AUTH_DIR, else
 * <CODEX_HOME|~/.codex>/multi-auth) while skipping its "prefer whichever
 * candidate already has accounts" fallback probing. Pinning this into child
 * env also disables ndy's per-project pool selection, so the wrapper always
 * resolves `--account` against the same store codex-swap validated.
 */
export function resolveMultiAuthDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env["CODEX_MULTI_AUTH_DIR"];
  if (explicit !== undefined && explicit.trim().length > 0) {
    return path.resolve(explicit);
  }
  return path.join(resolveCodexHome(env), "multi-auth");
}

/** The canonical Codex home (handoff §23.1); never per-account. */
export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env["CODEX_HOME"];
  if (explicit !== undefined && explicit.trim().length > 0) {
    return path.resolve(explicit);
  }
  return path.join(os.homedir(), ".codex");
}

export function withNdyContainment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...NDY_CONTAINMENT_ENV,
    CODEX_MULTI_AUTH_DIR: resolveMultiAuthDir(base),
  };
  delete env["CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY"];
  delete env["CODEX_MULTI_AUTH_BYPASS"];
  delete env["CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT"];
  delete env["CODEX_CI"];
  return env;
}
