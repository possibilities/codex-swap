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

**Reset credit** — A provider-issued, one-shot allowance for resetting Codex
rate-limit capacity. Display metadata only; it does not contribute quota
headroom or affect automatic selection.
_Avoid_: "reset" alone, which is confusable with a window's scheduled reset.

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
