import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { RedactedNdyAccount } from "../../accounts/redaction.ts";
import { resolveExplicitSelector } from "../../accounts/selector.ts";
import { NdyStoreReader } from "../../ndy/store-reader.ts";
import { resolvePiProfiles, type PiAdoption } from "../../pi/adopt.ts";
import { matchPiIdentity, profileIdentityConsistent } from "../../pi/identity.ts";
import { runCapture, runInteractive } from "../../ndy/spawn.ts";
import {
  canonicalPiAgentDir,
  piBinary,
  piSpawnCommand,
} from "../../pi/paths.ts";
import { readPiCodexIdentity } from "../../pi/profile-auth.ts";
import {
  PROFILE_SCHEMA_VERSION,
  ensureProfileSkeleton,
  finalizeProfile,
  listProfiles,
  profileFor,
  removeProfileDir,
  removeStaging,
  stagingDir,
  writeProfileMeta,
} from "../../pi/profiles.ts";
import { runLeasedPi } from "../../runner/pi-runner.ts";
import { SnapshotService } from "../../snapshot/service.ts";
import { commandIo, emitFailure, emitSuccess, splitForwardedArgs } from "../command-io.ts";
import { mapCommandError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { parseLaunchMode, type LaunchMode } from "./run.ts";

const USAGE = `Usage: codex-swap pi link [--account <selector>]
       codex-swap pi status [--json]
       codex-swap pi unlink --account <selector> [--json]
       codex-swap pi prune [--yes] [--json]
       codex-swap pi run --account <selector> -- [pi args...]
       codex-swap pi run [--strategy [best|next-available]] [--allow-unknown] -- [pi args...]
       codex-swap pi run --claim <lease-id> -- [pi args...]

Runs the pi coding agent on codex-swap's ChatGPT account pool. Each account
is linked once to a pi profile (its own OAuth grant, verified against the
account's identity); 'pi run' then launches pi pinned to one account's
profile under the same invocation leases Codex launches use. Sessions stay
in the canonical pi session store, so any account resumes any session.
'link' and 'run' are interactive and have no --json mode.
`;

/** Launch purpose recorded on pi invocation leases. */
const PI_PURPOSE = "pi-session";

export async function runPiCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "link":
      return linkCommand(rest);
    case "unlink":
      return unlinkCommand(rest);
    case "prune":
      return pruneCommand(rest);
    case "status":
      return statusCommand(rest);
    case "run":
      return runCommand(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return sub === undefined ? ExitCode.usage : ExitCode.success;
    default:
      process.stderr.write(`codex-swap pi: unknown subcommand '${sub}'\n${USAGE}`);
      return ExitCode.usage;
  }
}

type Io = ReturnType<typeof commandIo>;

async function piCliAvailable(io: Io): Promise<number | null> {
  try {
    const spawn = piSpawnCommand();
    const result = await runCapture(
      spawn.command,
      [...spawn.prefixArgs, "--version"],
      {
        env: { ...process.env, AGENTLAUNCH_LAUNCH: "1" },
        timeoutMs: 15_000,
      },
    );
    if (result.exitCode !== 0) {
      return emitFailure(
        io,
        {
          code: "DEPENDENCY_UNAVAILABLE",
          message: `'${piBinary()} --version' exited ${result.exitCode}; install the pi coding agent first`,
          retryable: false,
        },
        ExitCode.dependencyUnavailable,
      );
    }
    return null;
  } catch {
    return emitFailure(
      io,
      {
        code: "DEPENDENCY_UNAVAILABLE",
        message: `pi CLI not found (looked for '${piBinary()}'); install it or set CODEX_SWAP_PI_BIN`,
        retryable: false,
      },
      ExitCode.dependencyUnavailable,
    );
  }
}

// ---------------------------------------------------------------------------
// link

async function linkCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { account: { type: "string" } },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap pi link: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }
  const io = commandIo("pi link", false);

  const unavailable = await piCliAvailable(io);
  if (unavailable !== null) return unavailable;

  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const reader = new NdyStoreReader();
    const accounts = await reader.loadRedactedAccounts();
    if (accounts.length === 0) {
      return emitFailure(
        io,
        {
          code: "ACCOUNT_NOT_FOUND",
          message: "no accounts in the pool; run 'codex-swap auth add' first",
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }

    let requested: RedactedNdyAccount | null = null;
    if (parsed.values.account !== undefined) {
      const resolution = resolveExplicitSelector(accounts, parsed.values.account);
      if (resolution.kind === "not_found") {
        return emitFailure(
          io,
          {
            code: "ACCOUNT_NOT_FOUND",
            message: `no account matches selector '${parsed.values.account}'`,
            retryable: false,
          },
          ExitCode.reloginRequired,
        );
      }
      if (resolution.kind === "ambiguous") {
        return emitFailure(
          io,
          {
            code: "IDENTITY_CONFLICT",
            message: `selector '${parsed.values.account}' matches multiple accounts (${resolution.candidates.join(", ")}); use the account key`,
            retryable: false,
          },
          ExitCode.reloginRequired,
        );
      }
      requested = resolution.account;
    }

    removeStaging();
    const staging = stagingDir();
    ensureProfileSkeleton(staging);

    const hint =
      requested !== null
        ? `log in as ${requested.email ?? requested.accountKey}`
        : "log in with the ChatGPT account you want to link";
    process.stderr.write(
      [
        "",
        "codex-swap pi link: pi will now start inside the new profile.",
        `  1. In pi, run /login and choose "OpenAI (ChatGPT Plus/Pro)" — ${hint}.`,
        "  2. Complete the browser or device-code flow.",
        "  3. Quit pi (/quit) to finish linking.",
        "",
      ].join("\n"),
    );

    const spawn = piSpawnCommand();
    await runInteractive(spawn.command, spawn.prefixArgs, {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: staging,
        // Already-routed sentinel: a shimmed `pi` must exec the real
        // binary here, or the link flow would recurse into balancing.
        AGENTLAUNCH_LAUNCH: "1",
      },
    });

    const identity = readPiCodexIdentity(staging);
    if (!identity.present) {
      removeStaging();
      return emitFailure(
        io,
        {
          code: "PI_LOGIN_MISSING",
          message:
            "pi exited without an OpenAI Codex login in the profile; run 'codex-swap pi link' again and complete /login",
          retryable: true,
        },
        ExitCode.reloginRequired,
      );
    }
    if (identity.accountId === null) {
      removeStaging();
      return emitFailure(
        io,
        {
          code: "PI_IDENTITY_UNREADABLE",
          message:
            "the pi login's identity claim could not be read; refusing to link an unverifiable profile",
          retryable: true,
        },
        ExitCode.reloginRequired,
      );
    }

    const match = matchPiIdentity(
      accounts,
      await identityClaims(service, accounts),
      identity.accountId,
    );
    if (match.kind === "ambiguous") {
      removeStaging();
      return emitFailure(
        io,
        {
          code: "IDENTITY_CONFLICT",
          message: `the pi login's identity matches multiple pool accounts (${match.accountKeys.join(", ")}); this pool cannot pin them apart for pi`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }
    if (match.kind === "unmatched") {
      removeStaging();
      return emitFailure(
        io,
        {
          code: "ACCOUNT_NOT_FOUND",
          message: `pi logged into ${identity.email ?? identity.accountId}, which is not in the codex-swap pool; run 'codex-swap auth add' for it first`,
          retryable: false,
        },
        ExitCode.reloginRequired,
      );
    }
    const matched = match.account;
    if (requested !== null && matched.accountKey !== requested.accountKey) {
      removeStaging();
      return emitFailure(
        io,
        {
          code: "IDENTITY_CONFLICT",
          message: `pi logged into ${identity.email ?? identity.accountId} but --account requested ${requested.email ?? requested.accountKey}; nothing linked`,
          retryable: true,
        },
        ExitCode.reloginRequired,
      );
    }

    writeProfileMeta(staging, {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      accountKey: matched.accountKey,
      providerAccountId: matched.providerAccountId ?? null,
      email: matched.email ?? identity.email ?? null,
      verifiedAccountId: identity.accountId,
      linkedAtMs: Date.now(),
    });
    const finalDir = finalizeProfile(staging, matched.accountKey);
    process.stdout.write(
      `linked ${matched.email ?? matched.accountKey} → ${finalDir}\n`,
    );
    return ExitCode.success;
  } catch (error) {
    removeStaging();
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

/** Broker-derived identity claim per pool account (null when unreadable). */
async function identityClaims(
  service: SnapshotService,
  accounts: readonly RedactedNdyAccount[],
): Promise<Map<string, string | null>> {
  const claims = new Map<string, string | null>();
  for (const account of accounts) {
    claims.set(account.accountKey, await service.identityClaimId(account.accountKey));
  }
  return claims;
}

// ---------------------------------------------------------------------------
// unlink

async function unlinkCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { account: { type: "string" }, json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap pi unlink: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }
  const io = commandIo("pi unlink", parsed.values.json);
  if (parsed.values.account === undefined || parsed.values.account.length === 0) {
    process.stderr.write(`codex-swap pi unlink: --account is required\n${USAGE}`);
    return ExitCode.usage;
  }

  try {
    const reader = new NdyStoreReader();
    const accounts = await reader.loadRedactedAccounts();
    const resolution = resolveExplicitSelector(accounts, parsed.values.account);
    // An account already removed from the pool can still carry a profile;
    // fall back to matching stored profiles by the raw selector.
    const accountKey =
      resolution.kind === "resolved"
        ? resolution.account.accountKey
        : listProfiles().find(
            (r) =>
              r.profile.accountKey === parsed.values.account ||
              r.profile.email === parsed.values.account,
          )?.profile.accountKey;
    if (accountKey === undefined) {
      return emitFailure(
        io,
        {
          code: "ACCOUNT_NOT_FOUND",
          message: `no account or pi profile matches selector '${parsed.values.account}'`,
          retryable: false,
        },
        ExitCode.failure,
      );
    }
    const record = profileFor(accountKey);
    if (record === null) {
      return emitFailure(
        io,
        {
          code: "PI_NOT_LINKED",
          message: `${accountKey} has no linked pi profile`,
          retryable: false,
        },
        ExitCode.failure,
      );
    }
    removeProfileDir(record.dir);
    emitSuccess(io, { accountKey, removed: true, profileDir: record.dir });
    if (!io.json) process.stdout.write(`unlinked ${accountKey}\n`);
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  }
}

// ---------------------------------------------------------------------------
// prune

/** Yes/no on stderr, so a piped stdout stays a clean data channel. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Removes pi profiles no pool account claims. Adoption runs first, so a
 * profile that is merely mis-keyed is re-keyed rather than offered for
 * deletion — otherwise prune would be a way to destroy a recoverable grant.
 * What remains is genuinely unreachable: its account left the pool, or it
 * was superseded by a later link.
 *
 * Deletion is irreversible in the way that matters: adoption cannot bring a
 * profile back, only an interactive /login can. So each one is confirmed
 * individually, and a non-interactive run refuses without --yes.
 */
async function pruneCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean", default: false }, yes: { type: "boolean", default: false } },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap pi prune: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }
  const io = commandIo("pi prune", parsed.values.json);
  const assumeYes = parsed.values.yes === true;

  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    const reader = new NdyStoreReader();
    const accounts = await reader.loadRedactedAccounts();
    const claims = await identityClaims(service, accounts);
    const resolution = resolvePiProfiles(accounts, claims);
    reportAdoptions(resolution.adopted);

    if (resolution.orphans.length === 0) {
      emitSuccess(io, { adopted: resolution.adopted, removed: [], kept: [] });
      if (!io.json) process.stdout.write("no orphan pi profiles\n");
      return ExitCode.success;
    }

    if (!assumeYes && (io.json || process.stdin.isTTY !== true)) {
      return emitFailure(
        io,
        {
          code: "CONFIRMATION_REQUIRED",
          message: `${resolution.orphans.length} orphan pi profile(s) found; re-run with --yes to remove them`,
          retryable: false,
          details: {
            orphanProfiles: resolution.orphans.map((r) => ({
              accountKey: r.profile.accountKey,
              email: r.profile.email,
              profileDir: r.dir,
            })),
          },
        },
        ExitCode.usage,
      );
    }

    const removed: { accountKey: string; email: string | null; profileDir: string }[] = [];
    const kept: typeof removed = [];
    for (const orphan of resolution.orphans) {
      const entry = {
        accountKey: orphan.profile.accountKey,
        email: orphan.profile.email,
        profileDir: orphan.dir,
      };
      if (!assumeYes) {
        process.stderr.write(
          `\n  ${entry.email ?? entry.accountKey}\n  ${entry.profileDir}\n` +
            "  Removing destroys this profile's pi login; only a new 'pi link' can restore it.\n",
        );
        if (!(await confirm("  remove?"))) {
          kept.push(entry);
          continue;
        }
      }
      removeProfileDir(orphan.dir);
      removed.push(entry);
    }

    emitSuccess(io, { adopted: resolution.adopted, removed, kept });
    if (!io.json) {
      for (const entry of removed) {
        process.stdout.write(`removed ${entry.email ?? entry.accountKey}\n`);
      }
      for (const entry of kept) {
        process.stdout.write(`kept ${entry.email ?? entry.accountKey}\n`);
      }
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

// ---------------------------------------------------------------------------
// status

async function statusCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap pi status: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }
  const io = commandIo("pi status", parsed.values.json);

  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    let piVersion: string | null = null;
    try {
      const spawn = piSpawnCommand();
      const result = await runCapture(
        spawn.command,
        [...spawn.prefixArgs, "--version"],
        {
          env: { ...process.env, AGENTLAUNCH_LAUNCH: "1" },
          timeoutMs: 15_000,
        },
      );
      piVersion = result.exitCode === 0 ? result.stdout.trim() : null;
    } catch {
      piVersion = null;
    }

    const reader = new NdyStoreReader();
    const accounts = await reader.loadRedactedAccounts();
    const claims = await identityClaims(service, accounts);
    const resolution = resolvePiProfiles(accounts, claims);
    const byKey = resolution.byKey;

    const rows = accounts.map((account) => {
      const record = byKey.get(account.accountKey);
      if (record === undefined) {
        return {
          accountKey: account.accountKey,
          email: account.email ?? null,
          linked: false,
          credentialPresent: false,
          identityMatch: null as boolean | null,
          profileDir: null as string | null,
        };
      }
      const identity = readPiCodexIdentity(record.dir);
      return {
        accountKey: account.accountKey,
        email: account.email ?? null,
        linked: true,
        credentialPresent: identity.present,
        identityMatch: identity.present
          ? profileIdentityConsistent(
              record.profile.verifiedAccountId,
              account,
              claims.get(account.accountKey) ?? null,
            )
          : null,
        profileDir: record.dir,
      };
    });
    const orphans = resolution.orphans.map((r) => ({
      accountKey: r.profile.accountKey,
      email: r.profile.email,
      profileDir: r.dir,
    }));

    emitSuccess(io, {
      pi: { binary: piBinary(), version: piVersion },
      canonicalAgentDir: canonicalPiAgentDir(),
      accounts: rows,
      adoptedProfiles: resolution.adopted,
      orphanProfiles: orphans,
    });
    if (!io.json) {
      process.stdout.write(
        `pi: ${piVersion === null ? "not found" : piVersion} (${piBinary()})\n`,
      );
      for (const row of rows) {
        const state = !row.linked
          ? "not linked"
          : !row.credentialPresent
            ? "linked, NO credential — relink"
            : row.identityMatch === false
              ? "linked, IDENTITY DRIFT — relink"
              : "linked";
        process.stdout.write(`  ${row.email ?? row.accountKey}  ${state}\n`);
      }
      for (const adoption of resolution.adopted) {
        process.stdout.write(
          `  ${adoption.email ?? adoption.accountKey}  adopted (re-keyed from ${adoption.previousAccountKey})\n`,
        );
      }
      for (const orphan of orphans) {
        process.stdout.write(
          `  ${orphan.email ?? orphan.accountKey}  orphan profile (account left the pool)\n`,
        );
      }
    }
    return ExitCode.success;
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

// ---------------------------------------------------------------------------
// run

async function runCommand(args: string[]): Promise<number> {
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
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(
      `codex-swap pi run: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return ExitCode.usage;
  }

  const io = commandIo("pi run", false);
  const { mode, error } = parseLaunchMode({
    account: parsed.values.account,
    strategy: parsed.values.strategy,
    claim: parsed.values.claim,
    allowUnknown: parsed.values["allow-unknown"],
  });
  if (mode === null) {
    if (error !== undefined) process.stderr.write(`codex-swap pi run: ${error}\n`);
    process.stderr.write(USAGE);
    return ExitCode.usage;
  }

  const unavailable = await piCliAvailable(io);
  if (unavailable !== null) return unavailable;
  return executePiLaunch(mode, forwarded ?? [], io);
}

async function executePiLaunch(mode: LaunchMode, piArgs: string[], io: Io): Promise<number> {
  let service: SnapshotService | undefined;
  try {
    service = await SnapshotService.open();
    if (mode.kind === "claim") {
      return await piRunWithExistingLease(service, mode.leaseId, piArgs, io);
    }
    if (mode.kind === "account") {
      return await piRunExplicit(service, mode.selector, piArgs, io);
    }
    return await piRunWithStrategy(
      service,
      mode.strategy ?? service.settings.selection.strategy,
      mode.allowUnknown || service.settings.selection.allowUnknown,
      piArgs,
      io,
    );
  } catch (error) {
    const mapped = mapCommandError(error);
    return emitFailure(io, mapped.error, mapped.exitCode);
  } finally {
    service?.close();
  }
}

/** One line per adoption, so a re-key never happens invisibly. */
function reportAdoptions(adopted: readonly PiAdoption[]): void {
  for (const adoption of adopted) {
    process.stderr.write(
      `codex-swap: adopted pi profile for ${adoption.email ?? adoption.accountKey} ` +
        `(re-keyed from ${adoption.previousAccountKey})\n`,
    );
  }
}

/**
 * Why an account cannot launch pi, at the granularity that decides whether
 * another account may stand in for it.
 *
 * `unusable` means pi has no working grant for this account and never had
 * one to lose — a different linked account would serve the same request.
 * `conflict` means the profile's identity is contradicted by the pool, which
 * is a fact about the account worth stopping on: silently launching someone
 * else would bury it.
 */
type PiProfileVerdict =
  | { kind: "ok"; dir: string }
  | { kind: "unusable"; code: "PI_NOT_LINKED" | "PI_LOGIN_MISSING"; message: string }
  | { kind: "conflict"; code: "IDENTITY_CONFLICT"; message: string };

/**
 * A launchable pi pin needs a linked profile with a credential whose
 * verified identity is not contradicted by the pool account's current
 * claim (fail-safe: an unreadable current claim keeps the link-time
 * verification). ndy credential state is deliberately not consulted
 * otherwise: pi launches ride the profile's own grant.
 *
 * A miss tries adoption before failing: an account whose key changed under
 * it still has its own verified grant on disk, and re-keying it is cheaper
 * and safer than sending the operator through another interactive login.
 */
async function classifyPiProfile(
  service: SnapshotService,
  accounts: readonly RedactedNdyAccount[],
  account: RedactedNdyAccount,
): Promise<PiProfileVerdict> {
  const relink = `run 'codex-swap pi link --account ${account.accountKey}'`;
  let record = profileFor(account.accountKey);
  if (record === null) {
    const resolution = resolvePiProfiles(
      accounts,
      await identityClaims(service, accounts),
    );
    reportAdoptions(resolution.adopted);
    record = resolution.byKey.get(account.accountKey) ?? null;
  }
  if (record === null) {
    return {
      kind: "unusable",
      code: "PI_NOT_LINKED",
      message: `${account.email ?? account.accountKey} has no linked pi profile; ${relink}`,
    };
  }
  const currentClaim = await service.identityClaimId(account.accountKey);
  if (
    profileIdentityConsistent(
      record.profile.verifiedAccountId,
      account,
      currentClaim,
    ) === false
  ) {
    return {
      kind: "conflict",
      code: "IDENTITY_CONFLICT",
      message: `${account.accountKey}'s pi profile was verified for a different identity; ${relink} again`,
    };
  }
  const identity = readPiCodexIdentity(record.dir);
  if (!identity.present) {
    return {
      kind: "unusable",
      code: "PI_LOGIN_MISSING",
      message: `${account.accountKey}'s pi profile has no stored login; ${relink} again`,
    };
  }
  return { kind: "ok", dir: record.dir };
}

/** The fail-hard form: every pin a human chose resolves through this. */
async function requireLaunchableProfile(
  service: SnapshotService,
  accounts: readonly RedactedNdyAccount[],
  account: RedactedNdyAccount,
  io: Io,
): Promise<{ dir: string } | number> {
  const verdict = await classifyPiProfile(service, accounts, account);
  if (verdict.kind === "ok") return { dir: verdict.dir };
  return emitFailure(
    io,
    { code: verdict.code, message: verdict.message, retryable: false },
    ExitCode.reloginRequired,
  );
}

async function piRunExplicit(
  service: SnapshotService,
  selector: string,
  piArgs: string[],
  io: Io,
): Promise<number> {
  const reader = new NdyStoreReader();
  const accounts = await reader.loadRedactedAccounts();
  const resolution = resolveExplicitSelector(accounts, selector);
  if (resolution.kind === "not_found") {
    return emitFailure(
      io,
      {
        code: "ACCOUNT_NOT_FOUND",
        message: `no account matches selector '${selector}' (accounts: ${accounts.length})`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  if (resolution.kind === "ambiguous") {
    return emitFailure(
      io,
      {
        code: "IDENTITY_CONFLICT",
        message: `selector '${selector}' matches multiple accounts (${resolution.candidates.join(", ")}); use the account key`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  const account = resolution.account;
  const profile = await requireLaunchableProfile(service, accounts, account, io);
  if (typeof profile === "number") return profile;

  await service.reconcile();
  const { lease } = service.selectAndClaim({
    strategy: service.settings.selection.strategy,
    allowUnknown: true,
    purpose: PI_PURPOSE,
    cwd: process.cwd(),
    forcedAccountKey: account.accountKey,
  });
  if (lease === null) {
    return emitFailure(
      io,
      {
        code: "INTERNAL_ERROR",
        message: `failed to reserve an invocation lease for ${account.accountKey}`,
        retryable: true,
      },
      ExitCode.failure,
    );
  }
  return runLeasedPi({
    leases: service.leases,
    lease,
    profileDir: profile.dir,
    args: piArgs,
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}

/**
 * The accounts pi may be launched on: adopted where adoption applies, and
 * not contradicted by the pool's current identity claims. The strategy path
 * and the demoted-claim fallback both restrict to exactly this set — two
 * spellings would let a fallback land on an account the strategy skips.
 */
function linkedAccountKeys(
  accounts: readonly RedactedNdyAccount[],
  claims: ReadonlyMap<string, string | null>,
): Set<string> {
  const byKey = new Map(accounts.map((a) => [a.accountKey, a]));
  const resolution = resolvePiProfiles(accounts, claims);
  reportAdoptions(resolution.adopted);
  return new Set(
    [...resolution.byKey.values()]
      .filter((record) => {
        const account = byKey.get(record.profile.accountKey);
        if (account === undefined) return false;
        return (
          profileIdentityConsistent(
            record.profile.verifiedAccountId,
            account,
            claims.get(account.accountKey) ?? null,
          ) !== false
        );
      })
      .map((record) => record.profile.accountKey),
  );
}

async function piRunWithStrategy(
  service: SnapshotService,
  strategy: Parameters<SnapshotService["selectAndClaim"]>[0]["strategy"],
  allowUnknown: boolean,
  piArgs: string[],
  io: Io,
): Promise<number> {
  const rows = await service.reconcile();
  await service.collectUsage({ rows });

  const reader = new NdyStoreReader();
  const accounts = await reader.loadRedactedAccounts();
  const byKey = new Map(accounts.map((a) => [a.accountKey, a]));
  const claims = await identityClaims(service, accounts);
  const linkedKeys = linkedAccountKeys(accounts, claims);
  if (linkedKeys.size === 0) {
    return emitFailure(
      io,
      {
        code: "NO_ELIGIBLE_ACCOUNT",
        message: "no account has a linked pi profile; run 'codex-swap pi link' first",
        retryable: false,
      },
      ExitCode.noEligibleAccount,
    );
  }

  const { result, lease } = service.selectAndClaim({
    strategy,
    allowUnknown,
    purpose: PI_PURPOSE,
    cwd: process.cwd(),
    restrict: { keys: linkedKeys, reason: "pi_profile_missing" },
  });
  if (result.kind !== "selected" || lease === null) {
    return emitFailure(
      io,
      {
        code: "NO_ELIGIBLE_ACCOUNT",
        message: "No pi-linked account has decision-grade quota and usable authentication.",
        retryable: true,
        details: {
          reason: result.kind === "none" ? result.reason : "unknown",
          nextReadyAt: result.kind === "none" ? result.nextReadyAt : null,
        },
      },
      ExitCode.noEligibleAccount,
    );
  }

  const account = byKey.get(result.accountKey);
  const profile =
    account !== undefined ? await requireLaunchableProfile(service, accounts, account, io) : null;
  if (account === undefined || profile === null || typeof profile === "number") {
    service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
    return typeof profile === "number"
      ? profile
      : emitFailure(
          io,
          {
            code: "ACCOUNT_NOT_FOUND",
            message: `selected ${result.accountKey} but it is no longer in the ndy store`,
            retryable: true,
          },
          ExitCode.failure,
        );
  }

  process.stderr.write(
    `codex-swap: using ${result.accountKey} — ${result.reason.summary} (pi)\n`,
  );
  return runLeasedPi({
    leases: service.leases,
    lease,
    profileDir: profile.dir,
    args: piArgs,
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}

async function piRunWithExistingLease(
  service: SnapshotService,
  leaseId: string,
  piArgs: string[],
  io: Io,
): Promise<number> {
  const lease = service.leases.get(leaseId);
  if (lease === null || lease.status !== "reserved") {
    return emitFailure(
      io,
      {
        code: "LEASE_INVALID",
        message: `lease ${leaseId} is ${lease === null ? "unknown" : lease.status}; claim a fresh one with 'codex-swap select --claim'`,
        retryable: true,
      },
      ExitCode.failure,
    );
  }
  const reader = new NdyStoreReader();
  const accounts = await reader.loadRedactedAccounts();
  const account = accounts.find((a) => a.accountKey === lease.accountKey);
  if (account === undefined) {
    service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
    return emitFailure(
      io,
      {
        code: "ACCOUNT_NOT_FOUND",
        message: `lease ${leaseId} refers to ${lease.accountKey}, which is no longer in the ndy store`,
        retryable: false,
      },
      ExitCode.reloginRequired,
    );
  }
  const verdict = await classifyPiProfile(service, accounts, account);
  if (verdict.kind === "conflict") {
    service.leases.release(lease.leaseId, lease.ownerNonce, { status: "failed" });
    return emitFailure(
      io,
      { code: verdict.code, message: verdict.message, retryable: false },
      ExitCode.reloginRequired,
    );
  }
  if (verdict.kind === "unusable") {
    // The lease came from a balancer that selects on quota alone and cannot
    // see pi linkage, so its pick is advisory: hand the request to an
    // account pi can actually use rather than failing a launch nobody
    // pinned. An explicit --account is a human's choice and still fails.
    return piRunAfterDemotedClaim(service, accounts, lease, verdict.message, piArgs, io);
  }
  return runLeasedPi({
    leases: service.leases,
    lease,
    profileDir: verdict.dir,
    args: piArgs,
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}

/**
 * Replaces a claim whose account pi cannot use. The original lease is
 * released as `released`, not `failed`: nothing went wrong with the
 * account's quota or credentials as far as Codex is concerned, and only
 * live leases affect selection scoring, so the status is audit metadata
 * that should read honestly.
 */
async function piRunAfterDemotedClaim(
  service: SnapshotService,
  accounts: readonly RedactedNdyAccount[],
  lease: { leaseId: string; ownerNonce: string; accountKey: string },
  reason: string,
  piArgs: string[],
  io: Io,
): Promise<number> {
  process.stderr.write(`codex-swap: ${reason}\n`);
  service.leases.release(lease.leaseId, lease.ownerNonce, { status: "released" });

  const claims = await identityClaims(service, accounts);
  const linkedKeys = linkedAccountKeys(accounts, claims);
  linkedKeys.delete(lease.accountKey);
  if (linkedKeys.size === 0) {
    return emitFailure(
      io,
      {
        code: "NO_ELIGIBLE_ACCOUNT",
        message: `${lease.accountKey} cannot launch pi and no other account has a linked pi profile; run 'codex-swap pi link' first`,
        retryable: false,
      },
      ExitCode.noEligibleAccount,
    );
  }

  await service.reconcile();
  const { result, lease: replacement } = service.selectAndClaim({
    strategy: service.settings.selection.strategy,
    allowUnknown: service.settings.selection.allowUnknown,
    purpose: PI_PURPOSE,
    cwd: process.cwd(),
    restrict: { keys: linkedKeys, reason: "pi_profile_missing" },
  });
  if (result.kind !== "selected" || replacement === null) {
    return emitFailure(
      io,
      {
        code: "NO_ELIGIBLE_ACCOUNT",
        message: `${lease.accountKey} cannot launch pi and no linked account has decision-grade quota and usable authentication.`,
        retryable: true,
        details: {
          reason: result.kind === "none" ? result.reason : "unknown",
          nextReadyAt: result.kind === "none" ? result.nextReadyAt : null,
        },
      },
      ExitCode.noEligibleAccount,
    );
  }

  const replacementAccount = accounts.find((a) => a.accountKey === result.accountKey);
  const profile =
    replacementAccount !== undefined
      ? await requireLaunchableProfile(service, accounts, replacementAccount, io)
      : null;
  if (profile === null || typeof profile === "number") {
    service.leases.release(replacement.leaseId, replacement.ownerNonce, {
      status: "failed",
    });
    return typeof profile === "number"
      ? profile
      : emitFailure(
          io,
          {
            code: "ACCOUNT_NOT_FOUND",
            message: `selected ${result.accountKey} but it is no longer in the ndy store`,
            retryable: true,
          },
          ExitCode.failure,
        );
  }

  process.stderr.write(
    `codex-swap: using ${result.accountKey} instead — ${result.reason.summary} (pi)\n`,
  );
  return runLeasedPi({
    leases: service.leases,
    lease: replacement,
    profileDir: profile.dir,
    args: piArgs,
    heartbeatIntervalMs: service.settings.leases.heartbeatIntervalMs,
  });
}
