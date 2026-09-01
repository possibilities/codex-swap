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

Consumers should treat unknown fields as additive and rely only on
documented ones. `snapshot --json` is the primary integration boundary.

### snapshot (`codex-swap snapshot --json`, `--no-fetch` to skip collection)

```jsonc
{
  "schemaVersion": 1,
  "dependency": { "name": "codex-multi-auth", "version": "2.10.0", "healthy": true },
  "canonicalCodexHome": "/Users/you/.codex",
  "recommendation": {            // null when nothing is eligible
    "accountKey": "record:…",
    "providerAccountId": "acc_…",
    "strategy": "best",
    "reason": "highest trusted headroom (72.0%) after lease penalty",
    "headroomPercent": 72,
    "activeLeases": 0
  },
  "accounts": [
    {
      "accountKey": "record:…",      // stable identity — never an index
      "providerAccountId": "acc_…",
      "email": "you@example.com",
      "label": null,
      "enabled": true,
      "present": true,
      "ndyIndex": 0,                  // display position only
      "auth": { "status": "ready", "reloginRequired": false },
      "identityConflict": false,
      "policy": { "manuallyDisabled": false, "priority": 0, "weight": 1, "maxConcurrent": null },
      "usage": {
        "status": "ok",              // ok|stale|unknown|error|backoff|quarantined
        "decisionGrade": true,
        "measurement": { /* UsageMeasurement, null unless decision-grade */ },
        "fetchedAt": "…", "ageSeconds": 12,
        "nextPollAt": "…", "pollIntervalMs": 300000,
        "lastError": null            // {code, httpStatus, summary, at} after failures
      },
      "lastGoodUsage": {             // display-grade: survives errors and trust expiry
        "measurement": { /* UsageMeasurement */ },
        "fetchedAt": "…", "ageSeconds": 12
      },
      "selection": {
        "eligible": true,
        "exclusions": [],            // absent|ndy_disabled|manually_disabled|no_credentials|
                                     // relogin_required|identity_conflict|cooldown_active|
                                     // usage_unknown|quota_exhausted|max_concurrent_reached|
                                     // family_rate_limited
        "headroomPercent": 72,
        "activeLeases": 0
      }
    }
  ]
}
```

`UsageMeasurement`: `{schemaVersion, probeKind, planType?, creditsLeft?,
creditsUnlimited?, resetCreditsAvailable?, limitReached?, windows[],
fetchedAt}`. `resetCreditsAvailable` is a non-negative integer when reported
and is display metadata only; it never affects headroom or selection.

`UsageMeasurement.windows[]`: `{kind: primary|secondary|code_review|other,
label: "5h"|"daily"|"weekly"|…, windowSeconds?, usedPercent (raw),
remainingPercent (clamped), resetsAt?, resetAfterSeconds?, limitName?,
meteredFeature?}`. Windows from `additional_rate_limits` (per-model lanes
such as codex-spark) carry `limitName`/`meteredFeature` verbatim and never
bind general selection headroom.

### select (`--claim` to atomically reserve)

Success data: `{selection: SelectionResult, lease: {leaseId, ownerNonce,
accountKey, status, expiresAt} | null}`. A "none" result is an error
envelope `NO_ELIGIBLE_ACCOUNT` (exit 3) whose `details` carry
`{reason: all_exhausted|all_unknown|all_disabled|all_quarantined|no_accounts,
nextReadyAt, exclusions: [{accountKey, exclusions[]}]}`.

### select --metered-lane codex-spark (standalone Spark-lane claim)

```text
codex-swap select --account <account-key> --claim \
  --metered-lane codex-spark --model <spark-model> --json
```

A narrow claim primitive for the separately metered Spark lane, distinct
from balanced/pinned selection above: it targets exactly one account,
requires `--claim` and a `--model` whose normalized name contains `spark`,
and is incompatible with `--strategy` and `--allow-unknown`. It revalidates
every ordinary eligibility guard except `quota_exhausted`, which it waives
only after finding independent positive headroom in the account's own
Spark-lane windows — general quota exhaustion elsewhere never blocks it, and
nothing else is bypassed. It never falls back to another account and never
updates `selection_state` (no effect on ordinary balanced/rotation state).

Success data: `{selection: {kind: "selected", accountKey,
providerAccountId, lane: "codex-spark", headroomPercent, summary}, lease:
{leaseId, ownerNonce, accountKey, status, expiresAt}}`. The lease is an
ordinary invocation lease with `purpose: "codex-spark-claim"`; it is
reserved, heartbeated, and consumed via `run --claim <lease-id> -- ...`
exactly like any other lease.

A refusal is `NO_ELIGIBLE_ACCOUNT` (exit 3) whose `details` carry
`{reason, exclusions: [{accountKey, exclusions[]}]}` where `reason` is one
of:

- `account_not_found` — the account key is not in the catalog;
- `eligibility_excluded` — an ordinary, non-waived exclusion applies
  (`exclusions` lists it, same reasons as `selection.exclusions` elsewhere);
- `spark_lane_unavailable` — no window in the account's current, decision-
  grade measurement identifies as the requested lane (missing or unknown
  Spark data, including a stale/untrusted measurement, which surfaces as
  `usage_unknown` under `eligibility_excluded` instead);
- `spark_lane_exhausted` — the lane has matching windows but zero or
  negative remaining headroom in at least one of them.

Lane identity for a window comes from `limitName`, falling back to
`meteredFeature` only when `limitName` is absent, matched case-insensitively
against the requested lane; headroom is the conservative minimum
`remainingPercent` across every matching window.

Invalid combinations (missing `--account`/`--claim`/`--model`, an unknown
`--metered-lane` value, a `--model` without `spark` in its normalized name,
`--model` without `--metered-lane`, or `--strategy`/`--allow-unknown`
alongside `--metered-lane`) fail with `INVALID_ARGUMENTS` (exit 2) before
any reconcile or claim attempt.

### accounts / usage / leases / history / doctor

- `accounts`: `{count, accounts: [{accountKey, providerAccountId, email,
  label, enabled, present, ndyIndex, auth, identityConflict, addedAt,
  firstSeenAt, lastSeenAt}]}` — no usage, no network.
- `usage [selector]` / `usage refresh [selector]`: `{accounts: [{accountKey,
  email, usage, lastGoodUsage}]}` (same shapes as snapshot).
- `leases [--all]`: `{count, leases: [{leaseId, accountKey, status, purpose,
  ownerPid, cwd, acquiredAt, heartbeatAt, expiresAt, releasedAt,
  childExitCode}]}`.
- `history list`: `{count, sessions: [{id, threadName, updatedAt, provider,
  originator, cwd, path}]}` — providers include both `openai` and the ndy
  proxy; every id is resumable regardless of provider. `history show <id>`
  adds `{cliVersion, messages[]}` (messages are raw user text — sensitive).
- `doctor [--live] [--fix]`: `{healthy, checks: [{name, status: ok|warn|fail,
  detail}]}`.
- `auth add`: `{mode, accountCount, added: [RedactedAccount],
  changed: [RedactedAccount]}` — success requires exit 0 AND a store diff.
