# Glossary

**Account record** — A locally stored ndy account entry: stable local
`recordId` when available, upstream `accountId`, optional email and workspace
metadata, and credential material.
_Avoid_: "slot" as identity; array indexes are presentation positions.

**Provider account ID** — The upstream Codex/ChatGPT account or workspace
identifier carried as ndy's `accountId` and sent in `ChatGPT-Account-Id`. The
preferred selector passed to the ndy Codex wrapper.
_Avoid_: assuming email is unique; one email can hold multiple workspaces.

**Account key** — codex-swap's stable, secret-free key for one local account
record: `record:<recordId>` when `recordId` exists, else
`account:<providerAccountId>`, else a legacy hash of normalized email plus
immutable `addedAt`.
_Avoid_: numeric index, refresh-token hash, or mutable label as primary key.

**Credential lineage** — The current OAuth refresh-token generation for an
account. Only an HMAC fingerprint is persisted, to notice replacement and
release quarantine; never the raw token.

**Usage measurement** — A successfully validated provider response containing
quota windows, plan metadata, credits, and a fetch timestamp.

**Last-good measurement** — The newest successful usage measurement. A failed
fetch never overwrites it.

**Decision-grade usage** — A last-good measurement currently trusted for
automatic selection under freshness and failure rules.

**Display-grade usage** — A last-good measurement that may be older than
decision trust permits; shown with age and error annotations but never
silently driving automatic selection.

**Sentinel** — A state derived live from account and credential facts
(disabled, no credentials, re-login required, auth invalidated). Recomputed,
never persisted in place of usage measurements.

**Fetch claim** — A bounded per-account lease granting one collector the
right to perform a usage request; random fencing ID plus expiry.

**Fencing** — Rejecting a late fetch result whose claim ID or account
identity no longer matches the current row.

**Poll plan** — The persisted `nextPollAt` and `pollInterval` chosen for an
account after a successful fetch.

**Invocation lease** — A separate, longer-lived claim representing one
balancing harness or Codex process currently consuming an account. Affects
selection scoring; does not authorize usage fetching.

**Canonical Codex home** — The user's actual `CODEX_HOME`, normally
`~/.codex`, containing the one shared rollout/session history. No per-account
Codex homes.

**Forced account** — An ephemeral account pin applied to one wrapper
invocation. Never changes ndy's persisted active or pinned account.

**Foreground App Server invocation** — A normal lease-backed `run` whose
forwarded Codex argv selects `app-server`; the caller owns its listener,
lifetime, and client connections, while codex-swap only pins the account and
heartbeats the invocation lease.
_Avoid_: "sidecar", "resident server", or implying an app-server registry.

**Family block** — An active per-family rate-limit record in ndy's store
(`rateLimitResetTimes`), resolved against the launch's model family and
excluding that account from selection (`family_rate_limited`). Advisory:
when it is the sole obstacle to a launch, a live probe gets the final word
and a disproved record is cleared through ndy's own reset command.
_Avoid_: treating it as quota exhaustion — the codex-lane windows can be
nearly empty while a family is fully blocked, and vice versa.

**Pi profile** — A per-account `PI_CODING_AGENT_DIR` under the codex-swap
data root holding that account's own pi OAuth grant, with shared pi
configuration symlinked from the canonical agent dir. The unit `pi run`
pins through the environment.
_Avoid_: sharing ndy tokens with pi; a profile is a separate grant.

**Link** — The one-time verified association of a pool account with a pi
profile: pi's `/login` runs inside the profile, and the resulting token's
`chatgpt_account_id` claim must match the broker-derived claim of exactly
one pool account (provider account ID as fallback) or nothing is stored.
_Avoid_: matching identities by ndy `accountId` — workspace logins make it
an org-style id while claims are account uuids.

**Adoption** — Re-keying an orphaned pi profile onto the pool account whose
identity its own token proves, when a derived account key changed under it
(`account:<providerAccountId>` → `record:<recordId>`). A directory rename
plus rewritten `profile.json`; refused when ambiguous, uncredentialed, or
contradicted.
_Avoid_: calling it a re-link — adoption never touches credentials and
never runs pi's `/login`.

**Advisory pin** — A `--claim` lease on a pi launch: chosen by a balancer
that selects on quota alone and cannot see pi linkage, so an account it
picks that pi cannot use is replaced by one that can. A `--account` pin is
binding and fails instead.
_Avoid_: treating the two pins alike; who chose decides whether a
substitution is help or concealment.

**Prune** — Deleting pi profiles no pool account claims, after adoption has
run. Irreversible: only a new [[Link]] restores a pruned grant, which is why
it confirms per profile and refuses non-interactively without `--yes`.
