# codex-swap

Multi-account balancing for the [Codex CLI](https://github.com/openai/codex):
prompted account onboarding, secret-free machine-readable account and quota
data, smart adaptive usage fetching, deterministic account selection with
atomic invocation claims, and one canonical cross-account resumable session
history.

codex-swap is the data and invocation boundary for a future TUI and for
balancing harnesses — it deliberately has no TUI of its own. It consumes
[`codex-multi-auth`](https://github.com/ndycode/codex-multi-auth) (pinned
exactly) for OAuth onboarding, credential storage, and fail-hard per-invocation
account pinning, and owns everything that makes the data trustworthy: the
usage store, fetch leases and fencing, adaptive poll plans, selection policy,
and invocation leases.

Status: pre-release, under active construction. See `docs/handoff.md` for the
full build contract and `AGENTS.md` for repository guidance.

## Requirements

- Node >= 24
- The official Codex CLI on PATH (for launching sessions)

## Quick start

```sh
npm install
npm test

# add an account (browser OAuth; --device-auth for headless)
codex-swap auth add

# inspect accounts and quota without secrets
codex-swap snapshot --json

# launch Codex on the best account, atomically claimed
codex-swap run --strategy best -- <codex args>

# resume any session under any usable account
codex-swap history list --json
codex-swap resume <session-id> --account <selector> --
```

## Contracts

Every JSON command emits one envelope object on stdout:

```json
{ "schemaVersion": 1, "command": "…", "generatedAt": "…", "data": {}, "error": null }
```

Exit codes: `0` success · `1` operational/child failure · `2` invalid
arguments · `3` no eligible account · `4` re-login required / identity
conflict · `5` dependency unavailable · `130` interrupted.

See `docs/json-contracts.md` for schemas and `docs/security.md` for the
threat model and redaction rules.
