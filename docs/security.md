# Security

Threat model and rules per handoff §28. This tool manages a user's own
Codex/ChatGPT accounts on their own machine; it is not a multi-user
credential broker and must keep request rates conservative and visible.

## Credential exposure

- ndy stores refresh and cached access tokens in owner-restricted **plaintext
  JSON**. codex-swap accepts that boundary but never widens it: raw tokens
  never enter `codex-swap.db`, `settings.json`, events, logs, stdout, or
  exception messages.
- Only `src/accounts/credential-broker.ts` may read ndy token fields. Tokens
  live in memory only for the duration of one request.
- The database stores at most `HMAC-SHA256(installSecret, refreshToken)` — a
  keyed fingerprint used to detect credential rotation, useless without the
  local `install-secret.bin`.
- Redaction tests feed JWTs, refresh tokens, callback URLs, and auth headers
  through every logging and JSON path and assert none survive.

## Process execution

- All children are spawned with argument arrays and `shell: false`.
- Argument boundaries after `--` are preserved byte-for-byte; account labels
  and emails are data, never interpolated into shell strings.

## Network

- Usage probes only ever contact allowlisted `https://chatgpt.com` paths;
  credential-bearing redirects to any other origin are refused.
- Ten-second total timeout, 64 KiB response cap, `Retry-After` parsed
  defensively (seconds or HTTP date, capped so a malformed value cannot park
  an account forever).

## Local files

- Data root (`CODEX_SWAP_HOME` or the platform app-data dir) is `0700`;
  database, settings, secret, and logs are `0600` where POSIX applies.
- Symlinked `install-secret.bin` or database targets are refused.
- Settings writes are atomic; application state uses SQLite transactions, not
  ad hoc lock files.

## Upstream data

- Every ndy JSON shape and usage response is Zod-validated; non-finite
  numbers, absurd timestamps, and oversized bodies are rejected.
- Malformed rollout lines are tolerated without crashing history listing, and
  rollout contents are never trusted as commands or paths to mutate.

## Known caveats

- ndy's credential store is plaintext at rest (owner-restricted). Encrypting
  our SQLite would not change that; an encrypted-at-rest requirement is a
  fork trigger per handoff §35.
- `npm audit` reports moderate advisories in ndy's pinned `hono` dependency.
  The pin is exact by design; advisories are reviewed at each dependency
  upgrade (handoff §34) rather than auto-fixed, and the affected surface
  (ndy's local OAuth callback server) is not exposed by codex-swap commands.
