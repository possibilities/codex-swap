# codex-swap

[![CI](https://github.com/possibilities/codex-swap/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/codex-swap/actions/workflows/ci.yml)

Multi-account balancing for the [Codex CLI](https://github.com/openai/codex):
onboard several ChatGPT accounts, then launch Codex on whichever one still has
quota. Every session resumes under any account.

codex-swap is the data and invocation boundary for TUIs and balancing
harnesses, and deliberately has no TUI of its own. It consumes
[`codex-multi-auth`](https://github.com/ndycode/codex-multi-auth) (pinned
exactly) for OAuth onboarding, credential storage, and fail-hard per-invocation
account pinning. It owns everything that makes the data trustworthy: the
persisted usage store, adaptive poll plans, freshness and trust rules,
selection policy, and heartbeated invocation leases.

See `docs/handoff.md` for the full build contract, `docs/architecture.md` for
the module map, `docs/json-contracts.md` for consumer schemas, and
`docs/security.md` for the threat model.

## Requirements

- Node >= 24
- The official Codex CLI on PATH (for launching sessions)

## Quick start

```sh
npm install
npm test

# Add accounts (browser OAuth dashboard; --device-auth for headless,
# --manual to paste the callback URL). Repeat per account.
codex-swap auth add --device-auth

# Inspect accounts and quota — never leaks tokens, never sweeps the pool.
codex-swap accounts --json
codex-swap snapshot --json          # the primary integration boundary
codex-swap usage refresh            # operator-initiated broader refresh

# Launch Codex on the best account, atomically claimed and lease-tracked.
codex-swap run --strategy best -- exec "hello"
codex-swap run --account you@example.com --

# Cross-account history: list every session, resume any UUID on any account.
codex-swap history list
codex-swap resume 5973b6c0-94b8-487b-a530-2aeb6098ae0e --account acc_other --

# Health and configuration.
codex-swap doctor
codex-swap config set selection.defaultMaxConcurrent 2
```

## Pi on the same account pool

The pi coding agent can ride the same ChatGPT accounts (ADR 0005). Link each
account once, then launch pi exactly like Codex, under the same invocation
leases. Linking runs pi's `/login` inside a dedicated per-account profile and
verifies the resulting identity against the pool before storing anything.

```sh
codex-swap pi link                  # interactive; repeat per account
codex-swap pi status
codex-swap pi run --strategy best -- -p "hello"
codex-swap pi run --account you@example.com -- --model gpt-5.2-codex
codex-swap pi run --claim "$lease" -- …
```

Pi sessions stay in the canonical pi session store (`~/.pi/agent/sessions`), so
any account resumes any session, and shared pi configuration (extensions,
skills, settings) is symlinked into every profile. `--strategy` only considers
accounts with a linked, identity-verified profile (`pi_profile_missing`
otherwise). Quota comes from the same store as Codex launches, because quota is
per account, not per OAuth grant.

## Balancing harness integration

Selection is explainable and claimable. A read-only `select` never mutates
state; `select --claim` atomically reserves an invocation lease that
influences every later selection, then `run --claim` consumes it:

```sh
lease=$(codex-swap select --claim --json | jq -r .data.lease.leaseId)
codex-swap run --claim "$lease" -- exec "task"
```

Concurrent harnesses calling `select --claim` are serialized through SQLite
immediate transactions. Two simultaneous claims land on different accounts when
capacity allows, and the `policy.maxConcurrent` /
`selection.defaultMaxConcurrent` caps are never exceeded. A crashed holder's
lease expires by wall clock.

`snapshot --json` performs a store-governed collection pass first (the
active account plus at most one due alternate — polling stays flat as the
pool grows). `snapshot --no-fetch --json` reads stored state only, for cheap
TUI repaints while a daemon owns fetching.

## Guarantees

- **Fail-hard pinning.** A forced account that cannot be honored refuses to
  launch; there is no silent fallback. Forwarded Codex args containing
  `--account` are rejected before spawn (the wrapper's extractor would
  reinterpret them).
- **Fail-safe selection.** Unknown, stale-beyond-trust, exhausted,
  quarantined, ambiguous, or over-capacity accounts never win automatic
  selection; `select` explains every exclusion and every "none" result.
- **Stale-on-error.** A failed fetch never blanks last-good measurements;
  display-grade and decision-grade data are separate in the schema.
- **One canonical `CODEX_HOME`.** All sessions share one rollout store, so
  any session UUID resumes under any usable account.
- **Secret-free surfaces.** Raw tokens never enter the codex-swap database,
  JSON output, logs, or errors; logs additionally redact emails, JWTs, and
  callback URLs.
- **Contained dependency.** Every ndy child process runs with app binding,
  launcher installs, config.toml rewrites, official-CLI sync, background
  quota sweeps, and background network refresh suppressed — the runtime
  rotation proxy stays on.

## Recovery

- **Quarantined account** (two permanent refresh failures): re-login with
  `codex-swap auth add`. A rotated credential lineage clears quarantine
  automatically on the next reconcile.
- **Corrupt or lost `codex-swap.db`**: safe to delete — it is derived
  coordination state. Accounts live in ndy's store, and the catalog, usage, and
  leases rebuild on the next command. Deleting `install-secret.bin` only resets
  lineage fingerprints (one spurious quarantine release).
- **Stuck leases or old events**: `codex-swap doctor --fix` expires stale
  leases and prunes finished leases/events. `doctor --json` reports stale
  claims, quarantine, ambiguous identities, and permission problems.
- **Dependency upgrades**: `npm run check:ndy` runs the automated contract
  checks; the full manual checklist is `docs/handoff.md` §34.

## Data locations

- State: `~/Library/Application Support/codex-swap/` (macOS),
  `$XDG_DATA_HOME/codex-swap/` (Linux), `%LOCALAPPDATA%\codex-swap\`
  (Windows); override with `CODEX_SWAP_HOME`.
- ndy account store: `<CODEX_HOME|~/.codex>/multi-auth/` — pinned explicitly
  for every operation so per-project pools never fragment the account list.

## Exit codes

`0` success / child exited successfully · `1` operational or child failure ·
`2` invalid arguments · `3` no eligible account · `4` re-login required or
identity conflict · `5` dependency unavailable or unsupported version ·
`130` interrupted. For `run`/`resume` the Codex child's exit code takes
precedence once launched.
