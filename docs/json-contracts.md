# JSON contracts

All machine output is versioned and secret-free. This document is the
consumer-facing contract; schemas are enforced in `src/snapshot/schema.ts`
and tested against fixtures.

## Envelope

Every non-streaming JSON command emits exactly one object followed by one
newline on stdout. Logs and warnings go to stderr. `--json` disables ANSI and
progress output.

```json
{
  "schemaVersion": 1,
  "command": "snapshot",
  "generatedAt": "2026-08-08T20:00:00.000Z",
  "data": {},
  "error": null
}
```

On failure `data` is null and `error` carries:

```json
{
  "code": "NO_ELIGIBLE_ACCOUNT",
  "message": "No account has decision-grade quota and usable authentication.",
  "retryable": true,
  "details": { "nextReadyAt": null }
}
```

Rules:

- camelCase public fields; ISO 8601 UTC timestamps plus age/countdown fields
  where useful.
- Additive fields are allowed within a schema version; breaking changes
  increment `schemaVersion`.
- Arrays never imply index identity — rows carry their stable `accountKey`.
- Tokens, token expiry, authorization URLs, and private ndy storage paths
  never appear.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success / child exited successfully |
| 1 | operational or child failure |
| 2 | invalid arguments or incompatible JSON contract |
| 3 | no eligible account / selection blocked |
| 4 | re-login required or identity conflict |
| 5 | dependency unavailable or unsupported ndy version |
| 130 | interrupted by SIGINT with no child-specific code |

For `run` and `resume`, the Codex child's exit code takes precedence once the
child launched.

## Command payloads

Documented as each command lands; `snapshot --json` (handoff §19) is the
primary integration boundary. Consumers should treat unknown fields as
additive and rely only on documented ones.
