# Codex Swap: complete context, architecture, build plan, and agent handoff

Status: build-ready implementation handoff  
Prepared: 2026-08-08, America/New_York  
Target project: `codex-swap`  
Recommended project location: `~/code/codex-swap`  
Deliverable scope: account onboarding, machine-readable account and quota data, smart adaptive fetching, invocation-time account selection, concurrency-aware balancing, and one canonical cross-account resumable Codex history. A TUI is explicitly out of scope.

This document is intended to be sufficient context for a capable implementation agent starting with no access to the conversation that produced it. Treat the decisions below as the default build contract. Do not reopen settled architecture choices unless a concrete source or test contradicts them.

---

## 1. Executive directive

Build a new TypeScript/Node project named `codex-swap`. Do **not** fork Claude Swap, and do **not** begin with a full fork of `ndycode/codex-multi-auth`.

Use [`codex-multi-auth`](https://github.com/ndycode/codex-multi-auth) as an exactly pinned dependency for the parts it already does well:

- browser OAuth, device authorization, and manual callback authentication;
- persistent Codex account credentials;
- account inventory;
- token-compatible, fail-hard, per-invocation account pinning through its runtime proxy;
- launching the official Codex CLI;
- provider-independent history enumeration and direct-ID resume.

Own the parts that define the value of `codex-swap`:

- a secret-free canonical account read model;
- a Claude Swap-quality persisted usage store;
- per-account fetch leases, fencing, last-good measurements, backoff, quarantine, and adaptive poll plans;
- direct, account-specific usage fetching rather than an O(N) pool sweep;
- deterministic and explainable selection policy;
- atomic invocation claims and heartbeats so concurrent harnesses balance instead of stampeding the same account;
- stable JSON contracts for a future TUI and external balancing harnesses;
- canonical, provider-agnostic session listing plus explicit cross-account resume.

Consume ndy at two supported boundaries:

1. Its Tier A package-local binaries, invoked with argument arrays and no shell.
2. Only its documented Tier A package subpaths such as `codex-multi-auth/auth` and `codex-multi-auth/storage` where a direct library call is truly necessary.

Never import `codex-multi-auth/dist/lib/...`, unpublished source paths, the forecast command implementation, or the runtime proxy internals. The project explicitly documents runtime rotation as a CLI/runtime feature rather than a library transport API. See its [public API contract](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/docs/reference/public-api.md#L7-L120) and [package exports](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/package.json#L6-L35).

If one missing primitive blocks the clean dependency approach, first propose or contribute a narrow upstream API:

```text
codex-multi-auth quota --account <account-id> --json
```

or a stable `codex-multi-auth/quota` package subpath. If upstream will not stabilize that primitive, maintain a minimal patch fork containing only the narrow API addition. Keep the `codex-swap` repository separate either way. A wholesale fork is the last resort, not the starting point.

---

## 2. User intent and non-negotiable outcomes

The originating user does not care about the upstream TUIs. The product exists to supply data and a reliable invocation boundary for a separate TUI and for balancing harnesses.

The required outcomes are:

1. **Prompted authentication**
   - The app must provide an intentional onboarding command.
   - The command must open or describe an official-style OAuth flow, support device authorization for headless use, and store the resulting account.
   - The user must not have to manually find and copy token files.
   - Passwords must never be requested or handled by `codex-swap`.

2. **Queryable account data**
   - Accounts must be listable in human and versioned JSON form.
   - Identity, enabled state, authentication health, usage windows, reset times, freshness, errors, exclusion reasons, active invocation count, and selector reasoning must be queryable without exposing tokens.

3. **Smart usage fetching**
   - A UI repaint or repeated `snapshot` command must not imply a network request.
   - Fetch eligibility must be decided per account from persisted state.
   - One failed account must not blank every other account.
   - Transient failures preserve last-good measurements.
   - Polling must remain approximately flat as the account pool grows: normally the active account plus at most one due alternate per scheduler pass, not every account on every pass.
   - Multiple `codex-swap` processes must coordinate through leases so they do not duplicate probes.
   - Dead refresh-token lineages must be quarantined until credentials change.

4. **Account choice for a new session**
   - A caller may select explicitly by stable account ID or ask a strategy to select.
   - Selection and invocation must not mutate the user’s persistent default account.
   - A forced account must fail hard if it cannot be honored. It must never silently fall back to another account.
   - Different concurrent invocations must be able to use different accounts safely.

5. **Balancing harness support**
   - Selection must support an atomic claim, not only a read-only recommendation.
   - Active claims must influence later selections.
   - Claims must heartbeat while a launched Codex process is alive and expire after a crash.
   - The selector must return structured reasons and exclusions so a harness can explain or override a decision.

6. **Merged, account-independent history**
   - All runs use the canonical Codex home and rollout store.
   - The history API must list rollouts across model providers.
   - A session ID obtained from any account must be resumable while pinning any other usable account.
   - The supported resume contract is explicit session ID, not the native interactive picker.

7. **Safe failure behavior**
   - Unknown or untrusted data must not be represented as available quota.
   - Automatic selection should return “no eligible account” when every candidate is exhausted, quarantined, or unknown, unless the caller explicitly opts into unknown accounts.
   - Explicit user selection may bypass a manual-disable policy, but never authentication invalidation or an inability to enforce the pin.

---

## 3. Explicit non-goals

Do not spend project time on these until all acceptance criteria in this handoff pass:

- a full-screen TUI, menu-bar application, or desktop app;
- changing the user’s global active account as the primary invocation mechanism;
- automatic mid-session rotation between accounts;
- patching Codex binaries or the Codex desktop app;
- installing OS startup agents, launchers, or desktop-app bindings;
- copying every feature from ndycode/codex-multi-auth;
- supporting arbitrary AI providers;
- storing or synchronizing credentials to a remote service;
- deleting or rewriting Codex rollout history;
- relying on the native `codex resume` picker to provide a complete history view;
- scraping a TUI for data;
- building a daemon before the one-shot CLI and SQLite coordination model are proven.

---

## 4. Research snapshot and source provenance

The design is based on source-level review of these exact revisions:

| Project | Reviewed commit | Purpose |
| --- | --- | --- |
| `realiti4/claude-swap` | `b872b73f125b596d9e94da5c99a38057b4802c56` | Behavioral benchmark and algorithms to port semantically |
| `ndycode/codex-multi-auth` | `7f5c61b5b2a7bc66e35f701054189572e35e8337` | Recommended dependency, version 2.8.3 |
| `prakersh/codexmultiauth` | `d305e83822fb27497941d7e7ef97b5ebdfbe9ecb` | Direct Codex usage endpoint reference and encrypted-vault comparison |
| `larcane97/clausona` | `f9574ee6d897f4503b8ac6fd6d04255598ce7407` | Rejected profile-home approach and history migration lesson |
| `Sls0n/codex-account-switcher` | `fad1a4199d448ed9dee7661eab3769aabb15235f` | Minimal auth-file switching reference |
| `openai/codex` | `936f5eb3ee223ab34dcb221fa7c5f9943c8092bd` | Canonical rollout, resume, provider-filter, and account-header behavior |

Local research checkouts already exist at:

```text
~/src/codex-multi-auth
~/src/codexmultiauth
~/src/clausona
~/src/codex-account-switcher
~/src/openai-codex
```

The Claude Swap checkout used as the benchmark is:

```text
~/src/claude-swap
```

At research time, the installed environment reported:

```text
Node v26.4.0
npm 11.17.0
codex-cli 0.147.0
```

Do not treat mutable branch heads as evidence. Keep the pinned links and revision table current whenever the dependency is upgraded.

---

## 5. Terminology to preserve

Create `CONTEXT.md` in the new repository with these terms. Use them consistently in code, JSON, docs, and tests.

### Account record

A locally stored ndy account entry. It has a stable local `recordId` when available, an upstream `accountId`, optional email and workspace metadata, and credential material.

Avoid: “slot” as identity. Array indexes are presentation positions and may change.

### Provider account ID

The upstream Codex/ChatGPT account or workspace identifier carried as ndy’s `accountId` and sent in `ChatGPT-Account-Id`. This is the preferred selector passed to the ndy Codex wrapper.

Avoid: assuming email is unique. The same email can represent multiple workspaces or seats.

### Account key

`codex-swap`’s stable, secret-free key for one local account record. Prefer `record:<recordId>` when `recordId` exists; otherwise use `account:<providerAccountId>`; only as a legacy fallback derive a key from normalized email plus immutable `addedAt`.

Avoid: numeric index, refresh-token hash, or mutable label as the primary key.

### Credential lineage

The current OAuth refresh-token generation for an account. `codex-swap` may persist only an HMAC fingerprint of the refresh token to notice replacement and release quarantine. It must never duplicate the raw token into its own database.

### Usage measurement

A successfully validated provider response containing quota windows, plan metadata, credits, and a fetch timestamp.

### Last-good measurement

The newest successful usage measurement. A failed fetch never overwrites it.

### Decision-grade usage

A last-good measurement currently trusted for automatic selection under freshness and failure rules.

### Display-grade usage

A last-good measurement that may be older than decision trust permits. It may be shown with age and error annotations but must not silently drive automatic selection.

### Sentinel

A state derived from current account and credential facts, such as disabled, no credentials, re-login required, or authentication invalidated. Sentinels are recomputed and are not persisted in place of usage measurements.

### Fetch claim

A bounded, per-account lease granting one collector the right to perform a usage request. It has a random fencing ID and expiry.

### Fencing

Rejecting a late fetch result whose claim ID or account identity no longer matches the current row.

### Poll plan

The persisted `nextPollAt` and `pollInterval` chosen for an account after a successful fetch.

### Invocation lease

A separate, longer-lived claim that represents one balancing harness or Codex process currently consuming an account. It affects selection scoring but does not authorize usage fetching.

### Canonical Codex home

The user’s actual `CODEX_HOME`, normally `~/.codex`, containing the one shared rollout/session history. Do not create per-account Codex homes for normal operation.

### Forced account

An ephemeral account pin applied to one wrapper invocation. It never changes ndy’s persisted active or pinned account.

---

## 6. Why Claude Swap is the behavioral benchmark

Claude Swap’s value is not its TUI. Its important design is the division between credential/account state, a persisted usage table, coherent snapshots, selection policy, and session launch.

### 6.1 Usage store semantics worth porting

The source of truth is [`src/claude_swap/usage_store.py`](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/usage_store.py#L1-L26).

Important behaviors:

- Last-good usage is independent per account.
- Failure updates error and backoff state without touching `lastGood` or `fetchedAt`.
- Stored rows carry account identity, so reusing a display position cannot serve the previous account’s quota.
- Collectors follow a claim/fetch/record protocol and never hold the store lock across network I/O.
- Claims have random fence IDs and expiries.
- A late result is ignored when its claim or identity is stale.
- Sentinels are derived live and never replace stored measurements.
- Decision trust and display visibility are deliberately different.
- Permanent authentication errors advance a dead-token strike count; transient network and quota errors do not.
- A successful fetch clears failures and dead-token strikes.
- Poll plans are committed atomically with successful measurements.

Claude Swap’s stored row shape is conceptually:

```text
identity:
  email
  organizationUuid
measurement:
  lastGood
  fetchedAt
fetch state:
  lastAttemptAt
  consecutiveFailures
  lastError
  backoffUntil
  last429At
  authDeadStrikes
poll plan:
  nextPollAt
  pollIntervalS
claim:
  claimId
  claimUntil
```

The relevant read and mutation logic is in [`UsageStore.entries`, `reserve`, and `record`](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/usage_store.py#L787-L1141).

### 6.2 Adaptive polling worth porting semantically

Claude Swap persists one plan per account. Every surface inherits it, so opening more dashboards does not multiply traffic. See [`poll_policy.py`](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/poll_policy.py#L1-L244).

The algorithmic shape is reusable:

- movement tightens an interval;
- no movement widens it toward a role-specific ceiling;
- the active account is watched more closely than idle alternatives;
- an actively moving account near the switch threshold may enter a bounded urgent cadence;
- exhausted accounts remain on a bounded slow cadence instead of sleeping indefinitely;
- a known reset can pull the next poll earlier;
- recent 429s floor and then multiplicatively widen the cadence;
- jitter prevents multiple processes or machines from polling in lockstep.

Do **not** blindly copy Anthropic-specific constants or the comments claiming measured Anthropic request budgets. The structure is the benchmark; Codex endpoint limits must be measured separately. Initial Codex defaults proposed later are conservative placeholders and must be configurable.

### 6.3 Coherent snapshot boundary

Claude Swap’s `AccountsSnapshot` combines account metadata, active identity, policy, and usage entries from one collection pass. Its `SnapshotSource` provides a supported blocking read path for other UIs; the store, not the repaint loop, controls network eligibility. See [`models.py`](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/models.py#L123-L162) and [`snapshot_source.py`](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/snapshot_source.py#L1-L62).

`codex-swap snapshot --json` should be the equivalent supported integration boundary.

### 6.4 Fail-safe selection

Claude Swap’s manual `best` strategy only moves when it can prove a candidate has strictly more headroom. Unknown current usage or incomplete comparisons cause a hold, not an optimistic switch. Its automatic engine adds thresholding, cooldown, hysteresis, unhealthy-tick failover, target freshening, quarantine, and reset-aware recovery.

Port these principles:

- stay or fail closed when evidence is incomplete;
- distinguish proactive balancing from authentication failover;
- exclude manually disabled accounts from automatic selection while preserving explicit targeting;
- never land proactively on an account that would immediately retrigger the threshold;
- do not ping-pong between near-equal candidates;
- freshen or validate the target before committing an invocation claim;
- report why nothing was selected.

### 6.5 History lesson

Claude Swap’s `--share-history` merges existing profile history into the canonical profile before linking it. Nothing disappears merely because sharing is enabled. See [`session.py`](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/session.py#L1005-L1086).

For Codex, the better topology is simpler: keep one canonical home from the beginning. There should be no per-account history trees to merge.

---

## 7. Why ndycode/codex-multi-auth is a dependency, not the core

### 7.1 What it already solves

At revision `7f5c61b`, ndy provides:

- browser-first OAuth onboarding;
- device authorization and manual/no-browser callback modes;
- repeatable login to add accounts;
- owner-restricted account storage, backups, and migrations;
- stable `auth`, `storage`, `config`, `request`, and `cli` package subpaths;
- `status/list --json`;
- `forecast --live --json` and `report --live --json`;
- `history --json`;
- `codex-multi-auth-codex --account <index|email|accountId>`;
- ephemeral, invocation-only pinning that does not change persistent switch state;
- concurrent invocations with different forced accounts;
- fail-hard behavior when a forced account cannot be resolved or its proxy is unavailable.

The forced account implementation resolves a 1-based index, email, or `accountId`, exports only an internal resolved index to the child proxy, strips its private flag before forwarding, and refuses to launch if it cannot honor the pin. See [`scripts/codex.js`](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/scripts/codex.js#L365-L529).

### 7.2 Why it cannot be the smart data layer as-is

- A live quota probe sends an actual minimal Responses request and reads rate-limit headers. It is not a pure quota read. See [`quota-probe.ts`](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/quota-probe.ts#L345-L478).
- `forecast --live` walks all enabled accounts sequentially.
- Its background status refresh launches a detached `forecast --live --json` sweep when it decides the cache is stale.
- The background freshness test is based on the newest cache entry, so one fresh account can mask stale or missing entries.
- There is no stable command or package export for “probe exactly this account and return quota JSON.”
- Its selection cache and runtime overlays are useful, but they do not implement Claude Swap’s per-account leases and persisted adaptive plans.
- The account store includes raw refresh and cached access tokens in JSON. Directory and file modes are restricted, but credentials are not encrypted at rest. See [`public-types.ts`](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/storage/public-types.ts#L24-L55).

### 7.3 Disable ndy features that would undermine `codex-swap`

Every ndy child process launched by `codex-swap` should inherit this base environment unless a particular command requires otherwise:

```text
CODEX_MULTI_AUTH_APP_BIND=0
CODEX_MULTI_AUTH_APP_BIND_INSTALL=0
CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0
CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0
CODEX_MULTI_AUTH_STATUSLINE=0
CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS=0
```

Reasons:

- Do not bind or rewrite the Codex desktop app.
- Do not install OS launchers or startup entries.
- Do not persistently rewrite global `config.toml` merely to use the wrapper.
- Do not print ndy’s status line into a parent UI or harness.
- Most importantly, disable the detached full-pool quota refresh that otherwise defeats our per-account scheduler.

Do **not** set `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`. Forced-account invocation requires the runtime proxy.

Project-local ndy installs already skip its durable-global first-run app integration, but set the opt-outs defensively. Its first-run behavior is documented in [getting started](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/docs/getting-started.md#L51-L57).

---

## 8. Recommended implementation stack

Use:

- TypeScript with strict mode;
- ES modules;
- Node 24 or newer as the supported runtime baseline;
- npm with a committed lockfile;
- the built-in `node:sqlite` API behind a small repository interface;
- built-in `node:test` or Vitest; choose one and use it consistently;
- Zod as a direct dependency for external JSON validation;
- `node:util.parseArgs` or a small command parser; avoid a large CLI framework unless complexity proves it necessary;
- built-in `fetch` with explicit timeout and redirect policy;
- `spawn` with argument arrays, `shell: false`, and explicit stdio modes.

Pin ndy exactly at the verified release version (currently 2.10.0):

```json
"codex-multi-auth": "2.10.0"
```

Do not use a range. Dependency upgrades require the compatibility checklist later in this document.

If built-in SQLite proves incompatible with the minimum supported Node release, use `better-sqlite3` behind the same repository interface. Do not redesign storage around JSON merely to avoid one dependency: transactionality, cross-process claims, and invocation leases are core behavior.

---

## 9. Proposed repository layout

```text
codex-swap/
├── AGENTS.md
├── CLAUDE.md -> AGENTS.md
├── CONTEXT.md
├── README.md
├── LICENSE
├── package.json
├── package-lock.json
├── tsconfig.json
├── docs/
│   ├── architecture.md
│   ├── json-contracts.md
│   ├── security.md
│   └── adr/
│       ├── 0001-use-ndy-through-stable-boundaries.md
│       ├── 0002-keep-one-canonical-codex-home.md
│       ├── 0003-separate-display-and-decision-usage.md
│       └── 0004-coordinate-with-sqlite-leases.md
├── src/
│   ├── cli/
│   │   ├── main.ts
│   │   ├── commands/
│   │   │   ├── auth.ts
│   │   │   ├── accounts.ts
│   │   │   ├── snapshot.ts
│   │   │   ├── usage.ts
│   │   │   ├── select.ts
│   │   │   ├── run.ts
│   │   │   ├── history.ts
│   │   │   ├── resume.ts
│   │   │   ├── leases.ts
│   │   │   └── doctor.ts
│   │   ├── exit-codes.ts
│   │   └── output.ts
│   ├── ndy/
│   │   ├── adapter.ts
│   │   ├── bin-resolver.ts
│   │   ├── schemas.ts
│   │   ├── environment.ts
│   │   └── types.ts
│   ├── accounts/
│   │   ├── catalog.ts
│   │   ├── identity.ts
│   │   ├── credential-broker.ts
│   │   └── redaction.ts
│   ├── usage/
│   │   ├── probe.ts
│   │   ├── direct-usage-probe.ts
│   │   ├── header-probe.ts
│   │   ├── parser.ts
│   │   ├── error-classifier.ts
│   │   ├── store.ts
│   │   ├── collector.ts
│   │   ├── poll-policy.ts
│   │   ├── trust.ts
│   │   └── types.ts
│   ├── selection/
│   │   ├── selector.ts
│   │   ├── strategies.ts
│   │   ├── scoring.ts
│   │   ├── exclusions.ts
│   │   └── leases.ts
│   ├── history/
│   │   ├── service.ts
│   │   ├── scanner.ts
│   │   └── types.ts
│   ├── runner/
│   │   ├── codex-runner.ts
│   │   ├── signal-forwarder.ts
│   │   └── child-lifecycle.ts
│   ├── snapshot/
│   │   ├── service.ts
│   │   ├── schema.ts
│   │   └── types.ts
│   ├── storage/
│   │   ├── database.ts
│   │   ├── migrations.ts
│   │   ├── paths.ts
│   │   └── permissions.ts
│   ├── config/
│   │   ├── schema.ts
│   │   └── load.ts
│   ├── logging/
│   │   ├── logger.ts
│   │   └── sanitize.ts
│   └── index.ts
└── test/
    ├── fixtures/
    ├── unit/
    ├── integration/
    ├── concurrency/
    └── e2e/
```

Keep dependency direction one-way:

```text
CLI / external callers
        │
SnapshotService ── Selector ── InvocationLeaseStore
        │              │
AccountCatalog ── UsageCollector ── UsageStore
        │              │
      NdyAdapter ── CredentialBroker ── UsageProbe
        │
CodexRunner / HistoryService
```

The TUI or harness must consume `SnapshotService` and `Selector`, never ndy storage directly.

---

## 10. Storage location, permissions, and SQLite configuration

Suggested data root:

```text
macOS:   ~/Library/Application Support/codex-swap/
Linux:   ${XDG_DATA_HOME:-~/.local/share}/codex-swap/
Windows: %LOCALAPPDATA%\codex-swap\
```

Allow `CODEX_SWAP_HOME` to override it for tests and isolated automation.

Files:

```text
codex-swap.db
install-secret.bin
logs/codex-swap.jsonl
settings.json
```

Requirements:

- directory mode `0700` where POSIX permissions apply;
- database, settings, secret, and logs mode `0600`;
- refuse to follow an existing symlink for `install-secret.bin` or database creation;
- never put raw access tokens, refresh tokens, authorization URLs containing secrets, callback codes, or auth headers in the database or logs;
- use prepared statements everywhere.

SQLite initialization:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

All persisted times should be integer Unix epoch milliseconds in UTC. API output should render ISO 8601 UTC strings as well as age/countdown fields where useful.

---

## 11. Proposed database schema

This schema is a starting migration contract. Adjust names only before the first release; after release, migrate additively.

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
);

CREATE TABLE accounts (
    account_key TEXT PRIMARY KEY,
    record_id TEXT,
    provider_account_id TEXT,
    email TEXT,
    label TEXT,
    added_at_ms INTEGER,
    ndy_index INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    present INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1)),
    auth_status TEXT NOT NULL DEFAULT 'unknown',
    auth_invalidated_at_ms INTEGER,
    credential_lineage_hmac TEXT,
    first_seen_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX accounts_record_id_unique
    ON accounts(record_id) WHERE record_id IS NOT NULL;

CREATE INDEX accounts_provider_account_id_idx
    ON accounts(provider_account_id);

CREATE TABLE account_policy (
    account_key TEXT PRIMARY KEY REFERENCES accounts(account_key) ON DELETE CASCADE,
    manually_disabled INTEGER NOT NULL DEFAULT 0 CHECK (manually_disabled IN (0, 1)),
    priority INTEGER NOT NULL DEFAULT 0,
    weight REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0),
    max_concurrent INTEGER,
    cooldown_until_ms INTEGER,
    note TEXT,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE usage_state (
    account_key TEXT PRIMARY KEY REFERENCES accounts(account_key) ON DELETE CASCADE,
    last_good_json TEXT,
    fetched_at_ms INTEGER,
    last_attempt_at_ms INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_error_http_status INTEGER,
    last_error_summary TEXT,
    retry_after_ms INTEGER,
    backoff_until_ms INTEGER,
    next_poll_at_ms INTEGER,
    poll_interval_ms INTEGER,
    last_429_at_ms INTEGER,
    auth_dead_strikes INTEGER NOT NULL DEFAULT 0,
    claim_id TEXT,
    claim_until_ms INTEGER,
    claim_generation INTEGER NOT NULL DEFAULT 0,
    probe_kind TEXT,
    updated_at_ms INTEGER NOT NULL,
    CHECK (last_good_json IS NULL OR json_valid(last_good_json))
);

CREATE INDEX usage_due_idx
    ON usage_state(next_poll_at_ms, backoff_until_ms, claim_until_ms);

CREATE TABLE selection_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL DEFAULT 0,
    last_selected_account_key TEXT REFERENCES accounts(account_key),
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE invocation_leases (
    lease_id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL REFERENCES accounts(account_key),
    owner_pid INTEGER,
    owner_nonce TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'codex-session',
    cwd TEXT,
    acquired_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER,
    status TEXT NOT NULL CHECK (
        status IN ('reserved', 'running', 'released', 'expired', 'failed')
    ),
    selector_reason_json TEXT,
    child_exit_code INTEGER,
    CHECK (selector_reason_json IS NULL OR json_valid(selector_reason_json))
);

CREATE INDEX invocation_active_by_account_idx
    ON invocation_leases(account_key, status, expires_at_ms);

CREATE TABLE events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at_ms INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    account_key TEXT REFERENCES accounts(account_key),
    payload_json TEXT,
    CHECK (payload_json IS NULL OR json_valid(payload_json))
);

CREATE INDEX events_time_idx ON events(occurred_at_ms DESC);
```

Notes:

- `accounts.present = 0` preserves history when ndy temporarily omits or removes a record. Do not silently recycle its row for a new identity.
- `credential_lineage_hmac` is `HMAC-SHA256(installSecret, refreshToken)`. It detects replacement without storing a usable token or a raw unsalted hash.
- Fetch claims and invocation leases are deliberately separate tables and time scales.
- Event payloads are diagnostic and must be redacted before insertion.
- Periodically mark expired invocation leases as `expired`; do not delete them immediately. Retain a configurable short audit window, then prune.

---

## 12. Account catalog and identity rules

The ndy stable account shape includes `recordId`, `accountId`, `email`, refresh/access tokens, enabled state, timestamps, rate-limit state, auth invalidation, and workspaces. See [`AccountMetadataV3`](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/storage/public-types.ts#L24-L55).

Implement reconciliation as follows:

1. Load ndy accounts through the stable `codex-multi-auth/storage` export.
2. For each entry, derive `account_key`:
   - `record:<recordId>` when present;
   - otherwise `account:<accountId>` when present;
   - otherwise `legacy:<sha256(normalizedEmail + "\0" + addedAt)>`.
3. Upsert redacted metadata into `accounts`.
4. Update `credential_lineage_hmac` from the refresh token inside the credential boundary.
5. If a lineage HMAC changes:
   - clear `auth_dead_strikes`, auth-error backoff, and quarantine-derived status;
   - make the account immediately fetch-eligible;
   - emit `credential_lineage_changed`.
6. Mark previously known rows absent from the current ndy store as `present = 0` rather than deleting them.
7. Treat array index only as `ndy_index` display metadata.
8. Prefer `provider_account_id` when invoking ndy’s wrapper. If it is missing, attempt to decode/backfill it using supported ndy/account helpers or a validated token claim. Fall back to email only when it resolves uniquely.
9. Refuse automatic invocation when two present accounts share the same email and neither has a distinct provider account ID.

Never expose these ndy fields outside the credential/account boundary:

- `refreshToken`;
- `accessToken`;
- raw ID tokens;
- token expiry if it would enable fingerprinting beyond operational need.

The public `AccountView` should be a new type containing only redacted metadata and derived health.

---

## 13. Ndy adapter contract

### 13.1 Resolve package-local binaries

Do not assume a global installation or rely on ambient `PATH`.

Use `createRequire(import.meta.url).resolve("codex-multi-auth/package.json")`, read the exported `package.json`, resolve the relevant `bin` path relative to the package root, and spawn it with `process.execPath`.

Expected binaries:

```text
codex-multi-auth
codex-multi-auth-codex
```

Validate the installed version at startup and report a clear error if it differs from the tested range.

### 13.2 Suggested interface

```ts
interface NdyAdapter {
  version(): Promise<string>;
  login(mode: "browser" | "device" | "manual", orgId?: string): Promise<void>;
  status(): Promise<NdyStatus>;
  historyList(): Promise<NdyHistoryList>;
  historyShow(sessionId: string): Promise<NdyHistoryDetail>;
  rotationStatus(): Promise<NdyRotationStatus>;
  runCodex(options: {
    providerAccountId: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<number>;
}
```

### 13.3 Stdio rules

- Login uses inherited stdin/stdout/stderr so browser/device/manual prompts work naturally.
- JSON manager commands pipe stdout, inherit or capture stderr separately, and validate stdout with Zod.
- Codex invocation inherits terminal stdio.
- Never combine stderr with JSON stdout.
- Never use `shell: true`.
- Preserve argument boundaries exactly after the CLI’s `--` separator.
- Forward SIGINT, SIGTERM, and terminal resize semantics where applicable.
- Exit with the child’s exit code or conventional signal-derived status.

### 13.4 Schema isolation

Treat ndy JSON as an external versioned dependency even where it lacks an explicit schema version:

- Zod-validate required fields.
- Preserve unknown fields for diagnostics but do not pass them through as our public contract.
- Convert zero-based ndy indexes to our stable account keys immediately.
- Never pass raw `forecast.recommendedIndex` to `--account`; ndy’s numeric wrapper selector is one-based.
- Prefer provider account ID so index arithmetic is unnecessary.

### 13.5 Onboarding

Commands:

```text
codex-swap auth add
codex-swap auth add --device-auth
codex-swap auth add --manual
codex-swap auth add --org <org-id>
```

Implementation:

1. Spawn the corresponding ndy login command interactively.
2. On exit 0, reconcile the account catalog.
3. Identify newly added or changed account records.
4. Emit a redacted success object in JSON mode.
5. Mark the new/changed accounts immediately due for usage collection.
6. Never infer success from output text alone; require exit 0 and an account-store diff.

---

## 14. Credential broker

The credential broker is the only module allowed to see ndy token fields.

Responsibilities:

- supply a short-lived in-memory credential lease to one usage probe;
- verify that the account still matches the requested `account_key`;
- decide whether the cached access token is sufficiently fresh;
- refresh when necessary through the stable ndy auth API;
- commit a rotated token only if the account lineage still matches the snapshot used to refresh;
- reread and adopt a newer token if another process won the refresh race;
- classify permanent versus transient refresh failure;
- return redacted outcomes to callers.

Suggested result type:

```ts
type CredentialLeaseResult =
  | {
      kind: "ready";
      accountKey: string;
      providerAccountId: string;
      accessToken: string;       // in-memory only
      expiresAtMs?: number;
      lineageHmac: string;
    }
  | { kind: "relogin_required"; reason: string }
  | { kind: "transient_failure"; reason: string; retryAfterMs?: number }
  | { kind: "identity_conflict"; reason: string };
```

Refresh race algorithm:

1. Read the account snapshot and its refresh token.
2. If the access token is valid beyond a configurable buffer, return it.
3. Perform refresh outside the SQLite transaction and outside ndy’s storage lock.
4. Reopen ndy storage transactionally.
5. Find the account by `recordId`/`accountId`, not array index.
6. If the current refresh token differs from the snapshot:
   - another actor rotated it;
   - discard the local refresh result;
   - reread and use the newer credentials.
7. If it is unchanged, persist the successor atomically.
8. If refresh fails with `invalid_grant`, reread once before declaring death; another process may have successfully rotated the lineage.
9. Never persist a predecessor after a successor has appeared.

Add adversarial concurrency tests for this exact flow. Ndy’s own history includes bugs fixed around stale writers reverting newer refresh tokens; do not reintroduce that class of failure from the outside.

---

## 15. Usage probe architecture

Define an interface so the provider mechanism can change without touching storage or selection:

```ts
interface UsageProbe {
  readonly kind: string;
  fetch(input: {
    accountKey: string;
    providerAccountId: string;
    accessToken: string;
    signal: AbortSignal;
  }): Promise<UsageMeasurement>;
}
```

### 15.1 Primary probe: direct usage endpoint

The cma reference implementation successfully queries:

```text
GET https://chatgpt.com/backend-api/wham/usage
```

with fallback on 404 to:

```text
GET https://chatgpt.com/api/codex/usage
```

See cma’s [`usage/client.go`](https://github.com/prakersh/codexmultiauth/blob/d305e83822fb27497941d7e7ef97b5ebdfbe9ecb/internal/infra/usage/client.go#L20-L79).

Request contract:

```text
Authorization: Bearer <access-token>
Accept: application/json
ChatGPT-Account-Id: <provider-account-id>
User-Agent: codex-swap/<version>
```

Use the official Codex header spelling `ChatGPT-Account-Id`. Do not copy cma’s apparent `ChatClaude-Account-Id` typo.

Safety rules:

- ten-second total timeout initially;
- response size cap of 64 KiB;
- no credential-bearing redirects to another origin;
- only fallback between the two allowlisted `https://chatgpt.com` endpoints;
- parse `Retry-After` as seconds or HTTP date;
- never include auth headers or full response bodies in error logs;
- refresh once on a 401 and retry once if credential policy allows;
- treat a second 401 as authentication failure;
- treat 404 as endpoint capability fallback, not account failure;
- treat malformed success JSON as a schema failure and retain last-good usage;
- preserve unknown response fields only in bounded debug diagnostics, never public output by default.

Expected response fields include:

```text
plan_type
rate_limit.primary_window
rate_limit.secondary_window
code_review_rate_limit.primary_window
credits.balance
rate_limit_reset_credits.available_count
```

Each window may contain:

```text
used_percent
reset_at              # Unix seconds
limit_window_seconds
```

The cma parser reference is [`status_parser.go`](https://github.com/prakersh/codexmultiauth/blob/d305e83822fb27497941d7e7ef97b5ebdfbe9ecb/internal/infra/usage/status_parser.go).

### 15.2 Optional fallback probe: quota headers

Ndy’s internal probe sends a minimal Responses request and stops consuming the body after quota headers arrive. It is more invasive because it is a real inference/backend request. Keep an independently implemented fallback behind explicit configuration:

```text
usage.probeFallback = "disabled" | "header-probe"
```

Default to `disabled` in the first release. If the direct endpoint disappears, return a clear capability error rather than silently consuming inference requests. Enable the fallback only after product approval and test it against current Codex behavior.

Do not import ndy’s internal `fetchCodexQuotaSnapshot` to obtain this behavior.

### 15.3 Normalized measurement

```ts
interface UsageWindow {
  kind: "primary" | "secondary" | "code_review" | "other";
  label: string;
  windowSeconds?: number;
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: string;
}

interface UsageMeasurement {
  schemaVersion: 1;
  probeKind: "direct-wham" | "direct-codex" | "header-probe";
  planType?: string;
  creditsLeft?: number;
  resetCreditsAvailable?: number;
  windows: UsageWindow[];
  fetchedAt: string;
}
```

`resetCreditsAvailable` is display metadata only. It does not contribute to
binding headroom, eligibility, selection, polling, or invocation leases.

Validation:

- numbers must be finite;
- retain the raw finite `usedPercent` for diagnostics but clamp to `[0, 100]` for remaining/headroom math;
- reset timestamps must parse and be represented in UTC;
- an empty but otherwise successful response is not decision-grade usage;
- recognize primary/secondary by `limit_window_seconds`, not only array position;
- preserve code-review quota without letting it bind general Codex selection unless configured.

---

## 16. Usage state machine and transaction protocol

### 16.1 States

Conceptually:

```text
missing measurement
      │ due
      ▼
eligible ──reserve──> claimed ──network──> success
   ▲                    │                     │
   │                    │                     ├─ store last-good
   │                    │                     ├─ clear failures
   │                    │                     └─ commit next poll plan
   │                    │
   │                    └──────────────> failure
   │                                          │
   │                                          ├─ preserve last-good
   │                                          ├─ increment failures
   │                                          ├─ install backoff
   │                                          └─ maybe quarantine auth
   │
   └──────── backoff/plan/lease expires ──────┘
```

### 16.2 Reserve/fetch/record

Use Claude Swap’s protocol:

1. Begin an immediate SQLite transaction.
2. Reconcile identity and fetch eligibility under the transaction.
3. If eligible, write random `claim_id`, `claim_until_ms`, `last_attempt_at_ms`, and increment `claim_generation`.
4. Commit.
5. Perform token acquisition and network fetch without a database transaction.
6. Begin a new immediate transaction.
7. Re-read the row.
8. Accept the result only when:
   - `account_key` still exists and is present;
   - credential lineage has not changed incompatibly;
   - `claim_id` matches;
   - claim generation matches;
   - the row has not been replaced.
9. Clear the claim.
10. Apply success or failure and commit.

Initial fetch-claim TTL: 90 seconds. It must exceed token refresh, request timeout, stagger, and local scheduling delay. A crashed collector’s claim must expire automatically.

### 16.3 Success

On success:

- write `last_good_json` and `fetched_at_ms`;
- clear error, retry, backoff, failure count, and dead strikes;
- write `probe_kind`;
- compute and atomically commit `next_poll_at_ms` and `poll_interval_ms`;
- emit a redacted `usage_fetch_succeeded` event.

### 16.4 Failure

On failure:

- never modify `last_good_json` or `fetched_at_ms`;
- increment `consecutive_failures`;
- store a bounded error code and redacted summary;
- install `backoff_until_ms`;
- update `last_429_at_ms` only for a real 429;
- increment `auth_dead_strikes` only for permanent auth failures such as confirmed `invalid_grant` or missing refresh token;
- emit `usage_fetch_failed` without secrets.

### 16.5 Sentinels

Derive these at snapshot time:

```text
disabled
absent
no_credentials
relogin_required
auth_invalidated
identity_conflict
dependency_unavailable
```

Do not persist sentinel strings into `last_good_json`.

---

## 17. Freshness and trust model

Expose both last-good display data and decision-grade data.

Initial configurable defaults:

```text
serveTtlMs             = 180_000
normalTrustMaxAgeMs    = 3_600_000
rateLimitTrustMaxAgeMs = 7_200_000
fetchClaimTtlMs        = 90_000
```

Rules:

1. If no last-good measurement exists, decision usage is unavailable.
2. A measurement younger than `serveTtlMs` is fresh and must be served without a network request.
3. A transient failure does not erase last-good.
4. Deliberate staleness may remain decision-grade while:
   - the scheduler intentionally set a future poll time;
   - another collector has a live fetch claim;
   - a failure backoff is active;
   - and the applicable trust ceiling has not elapsed.
5. For a 429, usage is generally monotone within its current window. Last-good can remain a conservative lower bound until the earliest relevant reset, but never beyond a client-side maximum age.
6. For network, timeout, parse, or server failures, use the shorter normal trust ceiling.
7. Once trust expires, `decisionUsage` becomes null while `lastGoodUsage` remains visible with its age and error.
8. A reset timestamp in the past invalidates the old measurement for decisions even if its age is otherwise low.
9. An explicit account selection may launch with unavailable usage only if the caller knowingly chose that account and its authentication is usable.
10. Automatic selection excludes unknown usage unless `--allow-unknown` was explicitly passed.

The snapshot schema must make it impossible for consumers to confuse stale display data with trusted decision data.

---

## 18. Adaptive poll policy

### 18.1 Traffic invariant

One scheduler pass may normally fetch:

- the active or most recently selected account if it is due; and
- at most one due alternate, chosen by stalest successful measurement and then stable account key.

During initial pool bootstrap, do not sweep the pool. Fill it over successive passes. A deliberate operator command may request a bounded broader refresh, but it must still respect claims, 429 backoff, and a configurable request budget.

### 18.2 Initial Codex defaults

These are cautious starting values, not measured Codex guarantees:

```text
minimumIntervalMs          = 180_000
activeDefaultIntervalMs    = 180_000
activeMaximumIntervalMs    = 300_000
candidateDefaultIntervalMs = 300_000
candidateMaximumIntervalMs = 600_000
exhaustedIntervalMs        = 600_000
urgentIntervalMs           = 60_000
movementDeltaPercent       = 1.0
jitterFraction             = 0.10
post429MinimumIntervalMs   = 360_000
post429MaximumIntervalMs   = 1_800_000
recent429WindowMs          = 3_600_000
resetSlackMs               = 60_000
```

All values belong in validated configuration and should be observable through `doctor` or `config show`.

### 18.3 Plan-after-success algorithm

Pseudocode:

```text
previousBinding = max(relevant previous window used percentages)
newBinding      = max(relevant new window used percentages)
moving          = abs(newBinding - previousBinding) >= movementDelta

if no comparable usage:
    interval = role default
else if moving:
    interval = max(normal minimum, previous interval / 2)
else:
    interval = min(role ceiling, max(normal minimum, previous interval * 1.5))

if active and moving and near threshold and no recent 429:
    interval = urgent interval

if recent 429:
    interval = min(post429 maximum,
                   max(interval, previous interval * 1.5, post429 minimum))

if exhausted:
    interval = max(interval, exhausted interval)

nextPoll = now + jitter(interval)
nextPoll = min(nextPoll, earliest relevant future reset + reset slack)
```

Bound urgent mode: it is allowed only when the active account is demonstrably moving toward the threshold. If movement stops, the next success snaps back to the normal floor.

### 18.4 Failure backoff

Without `Retry-After`:

```text
30s, 60s, 120s, 240s, 480s, then cap at 10m
```

For 429:

- honor valid `Retry-After`;
- apply at least a five-minute edge backoff for `Retry-After: 0`;
- add jitter so processes do not retry simultaneously;
- cap pathological values to a configurable maximum, initially one hour;
- keep the post-429 poll interval floor after the first recovery.

For non-429 server overload with `Retry-After`, honor it but cap it at the normal trust maximum so an attacker or malformed proxy cannot park a row forever.

Do not copy Claude Swap’s Anthropic-specific 900-second deadline margin without Codex measurements. Add instrumentation first.

---

## 19. Snapshot service: the primary data API

`codex-swap snapshot --json` should perform one coherent operation:

1. reconcile ndy account inventory;
2. derive present authentication and policy sentinels;
3. select a bounded due fetch set;
4. reserve and perform allowed fetches;
5. read all account, usage, invocation-lease, and selection state;
6. compute per-account eligibility and selector scores;
7. emit one versioned snapshot.

Repeated calls are safe. The usage store decides whether any fetch occurs.

Suggested top-level schema:

```json
{
  "schemaVersion": 1,
  "command": "snapshot",
  "generatedAt": "2026-08-08T20:00:00Z",
  "dependency": {
    "name": "codex-multi-auth",
    "version": "2.8.3",
    "healthy": true
  },
  "canonicalCodexHome": "/Users/example/.codex",
  "recommendation": {
    "accountKey": "record:...",
    "providerAccountId": "acc_...",
    "strategy": "best",
    "reason": "highest trusted headroom after active-lease penalty",
    "headroomPercent": 72.0,
    "activeLeases": 0
  },
  "accounts": []
}
```

Suggested account row:

```json
{
  "accountKey": "record:...",
  "providerAccountId": "acc_...",
  "email": "person@example.com",
  "label": "person@example.com (Personal)",
  "enabled": true,
  "present": true,
  "auth": {
    "status": "ready",
    "reloginRequired": false
  },
  "policy": {
    "manuallyDisabled": false,
    "priority": 0,
    "weight": 1.0,
    "maxConcurrent": null
  },
  "usage": {
    "status": "ok",
    "decisionGrade": true,
    "measurement": {
      "planType": "plus",
      "windows": []
    },
    "fetchedAt": "2026-08-08T19:58:00Z",
    "ageSeconds": 120,
    "nextPollAt": "2026-08-08T20:03:00Z",
    "lastError": null
  },
  "lastGoodUsage": {
    "measurement": {},
    "fetchedAt": "2026-08-08T19:58:00Z",
    "ageSeconds": 120
  },
  "selection": {
    "eligible": true,
    "exclusions": [],
    "headroomPercent": 72.0,
    "score": 72.0,
    "activeLeases": 0
  }
}
```

Rules:

- Omit or null `usage.measurement` when data is not decision-grade.
- Keep `lastGoodUsage` when an older successful measurement exists.
- Never put token expiry, token hashes, authorization URLs, or private ndy storage paths in public JSON by default.
- JSON goes to stdout; logs and warnings go to stderr.
- `--json` disables ANSI and progress output.

---

## 20. Selection policy

### 20.1 Exclusions

Automatic selection excludes an account when any of these are true:

- not present in ndy storage;
- ndy account disabled;
- manually disabled in `codex-swap` policy;
- confirmed authentication invalidation;
- credential lineage quarantined/re-login required;
- identity conflict or ambiguous same-email identity;
- policy cooldown active;
- known exhausted binding quota before reset;
- `maxConcurrent` reached by live invocation leases;
- decision usage unknown, unless `allowUnknown` is set.

Explicit selection:

- may bypass `manuallyDisabled` after reporting it;
- may bypass unknown usage;
- may not bypass absent credentials, identity conflict, auth invalidation, or inability to enforce the forced account.

### 20.2 Binding headroom

Default relevant windows:

- general primary/5-hour window;
- general secondary/weekly window.

Binding used percentage is the maximum relevant `usedPercent`. Headroom is `100 - bindingUsedPercent`, clamped to `[0, 100]`.

Code-review quota does not bind general Codex sessions by default. Allow future named capability profiles.

### 20.3 Strategies

Implement initially:

1. `best`
   - Choose the eligible account with the highest trusted effective headroom.
   - Apply policy priority and weight only after correctness exclusions.
   - Penalize active invocation leases.
   - Ties rotate fairly using `selection_state.sequence` and last-selected account.

2. `next-available`
   - Rotate from the last selected account through stable account order.
   - Skip every excluded account.
   - Useful when callers prefer spreading over maximizing quota.

3. `consume-first` may be added after `best` is proven.
   - Prefer usable weekly quota that resets soonest so perishable quota is consumed before it disappears.
   - It requires recovery-time hysteresis to avoid bouncing between similar reset schedules.

Suggested effective score for `best`:

```text
effectiveHeadroom = bindingHeadroom
concurrencyPenalty = activeLeaseCount * config.concurrencyPenaltyPercent
score = (effectiveHeadroom - concurrencyPenalty) * weight + priority
```

Never allow the score to resurrect an excluded account. Keep raw headroom, penalty, priority, weight, score, and reasons separately visible.

### 20.4 Fail-safe result

Selection returns either:

```ts
type SelectionResult =
  | {
      kind: "selected";
      accountKey: string;
      providerAccountId: string;
      reason: SelectionReason;
    }
  | {
      kind: "none";
      reason: "all_exhausted" | "all_unknown" | "all_disabled" |
              "all_quarantined" | "no_accounts" | "dependency_unavailable";
      nextReadyAt?: string;
      exclusions: AccountExclusion[];
    };
```

If every account is exhausted, compute `nextReadyAt` from the reset of each account’s binding exhausted window and return the earliest credible recovery.

---

## 21. Atomic selection and invocation leases

Read-only recommendations are insufficient for parallel harnesses. Two processes can read the same state and both choose the same account.

### 21.1 Atomic claim

Within one `BEGIN IMMEDIATE` transaction:

1. expire stale leases;
2. read accounts, decision usage, policies, and active lease counts;
3. select the best candidate;
4. create a random lease ID and owner nonce;
5. insert a `reserved` invocation lease;
6. update selection sequence/last-selected account;
7. commit;
8. return the lease and redacted selection explanation.

Commands:

```text
codex-swap select --strategy best --json
codex-swap select --strategy best [--account <account-key>] --claim --json
codex-swap run --strategy best -- <codex args>
codex-swap run --account <selector> -- <codex args>
codex-swap run --claim <lease-id> -- <codex args>
codex-swap run --claim <lease-id> -- -c <config> app-server --listen <endpoint>
```

`select` without `--claim` is observational. `select --account` restricts the
normal eligibility gate to one exact account key and never substitutes another
account. `run --strategy` performs claim and launch as one workflow.
The final shape is the foreground App Server invocation contract: arguments
after `--` remain byte-for-byte Codex argv, the ordinary invocation lease is
heartbeated for the child lifetime, and the caller owns the endpoint, clients,
and termination. It creates no codex-swap registry or resident lifecycle.

### 21.2 Lease lifecycle

Initial defaults:

```text
reservation TTL before launch: 30 seconds
running heartbeat: every 30 seconds
running lease expiry: 120 seconds after last heartbeat
```

Lifecycle:

```text
reserved -> running -> released
                    -> failed
reserved -> expired
running  -> expired after crash/no heartbeat
```

The parent `codex-swap` process owns the heartbeat and releases in `finally`. A crash leaves a bounded stale lease that later transactions expire.

### 21.3 Why leases affect balancing, not authentication

An invocation lease says “this account is likely consuming capacity.” It does not transfer credentials and must not be passed to ndy. The actual wrapper selector remains provider account ID.

The first release should penalize active sessions but not try to estimate token burn. Add more sophisticated reservations only after real measurements.

---

## 22. Codex runner contract

Invocation always delegates to the package-local ndy forwarding wrapper:

```text
codex-multi-auth-codex --account <provider-account-id> <forwarded Codex args>
```

Ndy documents that forced selection is invocation-only, does not alter persistent pin state, never rotates during that session, and is safe for concurrent invocations. See its [forced-account command contract](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/docs/reference/commands.md#L182-L209).

Preflight:

1. account still exists and identity is unambiguous;
2. auth is not confirmed invalid;
3. provider account ID resolves;
4. ndy runtime rotation is enabled;
5. official Codex CLI is resolvable;
6. invocation lease is valid or atomically acquired.

Launch:

- use account ID, not numeric index;
- pass args as an array;
- inherit terminal stdio;
- preserve canonical `CODEX_HOME`;
- preserve working directory;
- apply the ndy containment environment from section 7.3;
- retain the runtime proxy;
- mark the invocation lease `running` only after child spawn succeeds;
- heartbeat until child exit;
- capture only exit code/signal, never the interactive transcript;
- release lease in all normal exit paths.

If ndy refuses the forced account, propagate its failure and mark the lease `failed`. Never rerun without `--account`.

---

## 23. Canonical history and resume

### 23.1 One store, no per-account homes

All sessions must use the canonical Codex home. Do not use one `CODEX_HOME` per account. Credentials are selected by the wrapper proxy; history remains in:

```text
<CODEX_HOME>/sessions
```

This is why there is no Claude-style merge operation in normal `codex-swap` operation.

### 23.2 Provider-filter caveat

Ndy’s proxy records `model_provider = codex-multi-auth-runtime-proxy`; native sessions use `openai`. Codex’s native interactive resume picker filters by provider, so one set may disappear from that picker even though files coexist.

Ndy’s `history` command scans rollout files directly, independent of provider, and emits:

```ts
interface HistorySessionSummary {
  id: string;
  threadName: string;
  updatedAt: string;
  provider: string | null;
  originator: string | null;
  cwd: string | null;
  path: string;
}
```

See [`history.ts`](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/codex-manager/commands/history.ts#L5-L314).

Official Codex source confirms the picker provider filter and that direct UUID lookup follows a separate path without that picker filter. See [`resume_picker.rs`](https://github.com/openai/codex/blob/936f5eb3ee223ab34dcb221fa7c5f9943c8092bd/codex-rs/tui/src/resume_picker.rs#L2088-L2114) and [`tui/src/lib.rs`](https://github.com/openai/codex/blob/936f5eb3ee223ab34dcb221fa7c5f9943c8092bd/codex-rs/tui/src/lib.rs#L626-L648).

### 23.3 Supported commands

```text
codex-swap history list --json
codex-swap history show <session-id> --json
codex-swap resume <session-id> --account <selector> -- <extra Codex args>
codex-swap resume <session-id> --strategy best -- <extra Codex args>
```

Resume delegates to:

```text
codex-multi-auth-codex --account <provider-account-id> resume <session-id> ...
```

The session ID is account-independent at the local rollout layer. Session metadata does not store an account selector. Make direct-ID resume the only promised complete-history contract.

### 23.4 Scanner fallback

Initially use ndy’s stable `history --json` binary. Implement a small internal read-only scanner later only if needed for independence. If implemented, it must:

- recursively scan rollout filenames under canonical `sessions`;
- tolerate partial/malformed JSONL lines;
- require a `session_meta` record;
- surface provider, originator, cwd, CLI version, and first user message;
- sort most recently updated first;
- never modify rollout files;
- never infer account ownership from provider.

---

## 24. CLI contract

Suggested initial commands:

| Command | Purpose |
| --- | --- |
| `codex-swap auth add` | Interactive browser OAuth onboarding through ndy |
| `codex-swap auth add --device-auth` | Headless/device onboarding |
| `codex-swap auth add --manual` | Manual callback onboarding |
| `codex-swap accounts [--json]` | Redacted account inventory, no forced live sweep |
| `codex-swap snapshot --json` | Coherent machine-facing account, usage, health, and recommendation snapshot |
| `codex-swap usage [selector] [--json]` | Store-governed usage view; may fetch only eligible due accounts |
| `codex-swap usage refresh [selector] [--json]` | Request refresh while still honoring claim/backoff safety |
| `codex-swap select [--strategy best] [--account <account-key>] [--claim] --json` | Explain or atomically claim an automatic or pinned eligible selection |
| `codex-swap run --strategy best -- ...` | Claim, pin, and launch Codex |
| `codex-swap run --account <selector> -- ...` | Explicit pinned launch |
| `codex-swap history [list] --json` | Provider-independent session list |
| `codex-swap history show <id> --json` | Session details |
| `codex-swap resume <id> --strategy best -- ...` | Select account and resume by UUID |
| `codex-swap leases [--json]` | Inspect active and recent invocation leases |
| `codex-swap doctor [--json]` | Dependency, storage, history, permissions, and proxy checks |
| `codex-swap config show/set/unset` | Validated configuration |

Account selector resolution order:

1. exact `account_key`;
2. exact provider account ID;
3. exact unique email;
4. exact unique configured alias if aliases are later added;
5. reject ambiguity explicitly.

Do not accept a bare numeric ndy index as a stable machine contract. A human-only convenience may be added, but JSON should always return stable IDs.

---

## 25. JSON and exit-code contracts

### 25.1 General envelope

Every non-streaming JSON command should emit one JSON object:

```json
{
  "schemaVersion": 1,
  "command": "select",
  "generatedAt": "2026-08-08T20:00:00Z",
  "data": {},
  "error": null
}
```

Error:

```json
{
  "schemaVersion": 1,
  "command": "select",
  "generatedAt": "2026-08-08T20:00:00Z",
  "data": null,
  "error": {
    "code": "NO_ELIGIBLE_ACCOUNT",
    "message": "No account has decision-grade quota and usable authentication.",
    "retryable": true,
    "details": {
      "nextReadyAt": null
    }
  }
}
```

Rules:

- one object, one newline;
- camelCase public fields;
- unknown additive fields allowed within a schema version;
- breaking changes require `schemaVersion` increment;
- never emit partial JSON followed by human text;
- redacted diagnostics only;
- arrays retain stable account-key association, never imply index identity.

### 25.2 Exit codes

Recommended:

```text
0  success / child exited successfully
1  operational or child failure
2  invalid arguments or incompatible JSON contract
3  no eligible account / selection blocked
4  re-login required or identity conflict
5  dependency unavailable or unsupported ndy version
130 interrupted by SIGINT where no child-specific code is available
```

For `run` and `resume`, prefer the Codex child exit code once the child actually launched. Use the reserved codes only for preflight failures.

---

## 26. Configuration contract

Store a versioned `settings.json` and preserve unknown fields on round trip.

Initial shape:

```json
{
  "schemaVersion": 1,
  "selection": {
    "strategy": "best",
    "allowUnknown": false,
    "concurrencyPenaltyPercent": 10,
    "defaultMaxConcurrent": null
  },
  "usage": {
    "serveTtlMs": 180000,
    "normalTrustMaxAgeMs": 3600000,
    "rateLimitTrustMaxAgeMs": 7200000,
    "fetchClaimTtlMs": 90000,
    "minimumIntervalMs": 180000,
    "activeDefaultIntervalMs": 180000,
    "activeMaximumIntervalMs": 300000,
    "candidateDefaultIntervalMs": 300000,
    "candidateMaximumIntervalMs": 600000,
    "exhaustedIntervalMs": 600000,
    "urgentIntervalMs": 60000,
    "movementDeltaPercent": 1,
    "jitterFraction": 0.1,
    "probeFallback": "disabled"
  },
  "leases": {
    "reservationTtlMs": 30000,
    "heartbeatIntervalMs": 30000,
    "runningExpiryMs": 120000
  }
}
```

Validate numeric bounds. A corrupt settings file should produce a visible diagnostic and safe defaults, not silently turn off backoff or allow unlimited concurrency.

---

## 27. Logging, events, and observability

Use structured JSONL logs to stderr and/or a private rotating file.

Every record should contain:

```text
timestamp
level
event
correlationId
accountKey, when relevant
leaseId, when relevant
durationMs, when relevant
errorCode, never raw secret-bearing errors
```

Useful events:

```text
account_catalog_reconciled
credential_lineage_changed
usage_claim_acquired
usage_claim_skipped
usage_fetch_succeeded
usage_fetch_failed
usage_result_fenced_out
usage_account_quarantined
usage_account_unquarantined
selection_completed
selection_blocked
invocation_lease_acquired
invocation_started
invocation_heartbeat_failed
invocation_finished
invocation_lease_expired
history_listed
dependency_contract_failed
```

Metrics derivable from logs or `doctor --json`:

- probes per hour overall and per account;
- 429 count and time in backoff;
- duplicate-claim prevention count;
- last-good age distribution;
- automatic-selection blocked reasons;
- active invocation leases by account;
- ndy command duration/failure rate;
- schema-validation failures after dependency upgrades.

Redaction tests must feed JWTs, refresh tokens, callback URLs, authorization headers, and email-like strings through every logging path.

---

## 28. Security and threat model

### 28.1 Credential exposure

Risk: ndy stores refresh and cached access tokens in owner-restricted JSON.

Mitigation:

- accept ndy’s storage as the dependency’s current boundary;
- never copy raw tokens into `codex-swap.db`, settings, events, stdout, or logs;
- keep credential access in one module;
- hold tokens only in memory for the duration of a request;
- zeroing JavaScript strings is not reliable, so minimize lifetime and references;
- document the plaintext-at-rest dependency caveat prominently.

If encrypted-at-rest credentials become mandatory, that is a trigger to replace/fork the credential runtime, because ndy’s wrapper must be able to read its own store.

### 28.2 Command injection

- use `spawn(process.execPath, [scriptPath, ...args])`;
- never concatenate a shell command;
- preserve `--` argument boundaries;
- treat account labels and emails as data, not executable strings.

### 28.3 Endpoint credential leakage

- allowlist HTTPS origin and paths;
- reject cross-origin redirects;
- never send Bearer or account headers to an arbitrary configured URL without an explicit unsafe-development option;
- scrub fetch exceptions and headers.

### 28.4 Local file attacks

- create private directories before database and secret files;
- refuse symlinked secret/database targets;
- use atomic settings writes;
- use SQLite transactions rather than ad hoc lock files for application state;
- do not trust rollout file contents as commands or paths to mutate.

### 28.5 Malformed upstream data

- validate all ndy JSON and usage responses;
- cap body and string sizes;
- reject non-finite numbers and absurd timestamps;
- tolerate individual malformed rollout lines without crashing history listing;
- never let malformed `Retry-After` create infinite backoff.

### 28.6 Terms and policy

This tool manages a user’s own Codex/ChatGPT accounts. Do not market it as a multi-user credential broker, resale service, high-volume extraction system, or mechanism to evade provider rules. Keep request rates conservative and visible.

---

## 29. Doctor command

`codex-swap doctor --json` should be non-destructive by default and report:

- Node and platform version;
- `codex-swap` version;
- exact ndy version and whether it matches the tested range;
- official Codex CLI resolution/version;
- canonical `CODEX_HOME`;
- ndy account-store readability and account count, without tokens;
- database path, schema version, WAL state, and permission health;
- install-secret existence/permissions;
- runtime rotation status;
- confirmation that app-bind and status-refresh opt-outs are applied to child processes;
- direct usage endpoint capability, only when `--live` is explicitly supplied;
- history directory readability and session count;
- stale fetch claims and invocation leases;
- ambiguous identities;
- quarantined accounts;
- recent dependency schema-validation errors.

`doctor --fix` must be a separate explicit command and should initially support only safe local repairs such as expiring stale leases or recreating missing private directories. Do not let it bind the Codex app or rewrite unrelated global settings.

---

## 30. Detailed implementation milestones

Each milestone should land as a coherent commit with tests. Do not begin with a broad code dump.

### Milestone 0: repository and contract skeleton

Deliver:

- new `~/code/codex-swap` repository;
- `AGENTS.md`, symlinked `CLAUDE.md`, and `CONTEXT.md`;
- ADRs 0001–0004 from the proposed layout;
- strict TypeScript build;
- package-local CLI entry point;
- exact ndy 2.8.4 dependency and lockfile;
- empty versioned JSON envelope and exit-code helpers;
- CI for typecheck and tests on macOS, Linux, and Windows where available.

Gate:

- `npm test` and `npm run typecheck` pass from a clean checkout;
- no postinstall or first-run mutation of Codex state occurs during tests.

### Milestone 1: ndy adapter vertical slice

Deliver:

- package-local bin resolver;
- containment environment;
- `auth add` passthrough;
- validated `status --json` adapter;
- validated `history --json` adapter;
- `run --account <providerAccountId>` forwarding;
- signal and exit-code forwarding;
- dependency version guard.

Tests:

- fake ndy package/binaries;
- TTY inheritance for login;
- JSON stdout/stderr isolation;
- account-ID argument fidelity;
- fail-hard wrapper result propagation;
- no shell injection;
- no app-bind/status-refresh environment regression.

Gate:

- with a fake dependency, one command can onboard, list, launch, list history, and resume without any project-internal token handling.

### Milestone 2: database, account catalog, and snapshots

Deliver:

- SQLite migrations and permissions;
- install-secret and HMAC lineage fingerprinting;
- account reconciliation from stable ndy storage;
- redacted `accounts --json`;
- initial `snapshot --json` without live usage;
- absent/reappearing account handling;
- ambiguity detection.

Tests:

- account reordering does not change keys;
- same email/different account ID remains distinct;
- credential rotation changes lineage HMAC and clears quarantine state;
- raw tokens never appear in database dump or JSON;
- concurrent reconciliations converge.

Gate:

- the snapshot is stable across ndy index changes and exposes no credentials.

### Milestone 3: direct usage probe and smart store

Deliver:

- direct wham endpoint probe with Codex endpoint fallback;
- normalized usage parser;
- credential broker with refresh race handling;
- usage-state schema and repository;
- fetch claim/fencing protocol;
- stale-on-error behavior;
- error classification and quarantine;
- store-governed `usage` and `snapshot` refresh.

Tests:

- successful 5h/weekly/code-review/credits parsing;
- 404 endpoint fallback;
- 401 refresh/retry once;
- concurrent refresh winner adoption;
- 429 and `Retry-After` parsing;
- timeout/network/5xx/malformed JSON;
- one account failure leaves other rows unchanged;
- late claim result is fenced out;
- identity change fences a result;
- process crash claim expiry;
- no token leakage in errors.

Gate:

- eight concurrent snapshot processes cause no more than one request for one due account;
- a failure retains and labels last-good usage.

### Milestone 4: adaptive scheduler

Deliver:

- role-aware intervals;
- movement detection;
- bounded urgent mode;
- exhausted cadence;
- reset caps;
- jitter;
- recent-429 AIMD;
- active-plus-one-due-candidate fetch budgeting;
- scheduler fields in snapshot and doctor.

Tests:

- repaint loops never exceed store cadence;
- new accounts bootstrap gradually;
- active movement tightens polling;
- idle alternates back off;
- exhausted accounts stay bounded;
- reset pulls a poll earlier;
- 429 floors and widens cadence;
- deterministic RNG injection makes plans testable.

Gate:

- request count stays bounded when simulated account count grows from 2 to 100.

### Milestone 5: selection and invocation leases

Deliver:

- exclusions and decision-grade headroom;
- `best` and `next-available` strategies;
- read-only selection explanation;
- atomic `--claim` selection;
- invocation lease lifecycle and heartbeat;
- `run --strategy`;
- explicit-selector override rules;
- reset-aware no-candidate result.

Tests:

- unknown data cannot win automatically;
- explicit unknown account is allowed only with usable auth;
- disabled account skipped automatically but explicit targeting reports override;
- exhausted/quarantined accounts excluded;
- ties distribute fairly;
- simultaneous selectors acquire different accounts when capacity allows;
- max concurrency enforced;
- crashed lease expires;
- forced wrapper failure never retries unpinned;
- child exit releases lease.

Gate:

- a concurrency test launching N fake sessions across M accounts produces the expected balanced lease distribution with no duplicate over-capacity choice.

### Milestone 6: canonical history and resume

Deliver:

- `history list/show` normalized JSON;
- `resume` with explicit account or strategy;
- direct UUID contract in docs;
- provider caveat in human output;
- optional internal scanner only if ndy history proves insufficient.

Tests:

- native and proxy-provider rollout fixtures both appear;
- malformed lines do not drop a valid session;
- results sort newest first;
- direct resume forwards exact ID and selected account ID;
- canonical `CODEX_HOME` is preserved;
- no history files are mutated.

Gate:

- a session created under account A can be listed and resumed through account B in an end-to-end manual test.

### Milestone 7: hardening and release candidate

Deliver:

- doctor and config commands;
- structured logging and pruning;
- dependency upgrade check script;
- security documentation;
- README quick start and machine integration examples;
- package smoke tests;
- recovery documentation.

Gate:

- every definition-of-done item passes;
- no live credentials are used in CI;
- manual two-account acceptance is recorded without capturing secrets.

---

## 31. Test matrix

### 31.1 Unit tests

Account identity:

- record ID preferred;
- account ID fallback;
- same email/different workspace remains distinct;
- index reorder irrelevant;
- absent/reappearing account;
- credential lineage HMAC changes without exposing input.

Usage parser:

- primary only;
- primary plus secondary;
- weekly-only window identified by duration;
- code review;
- numeric and string credits;
- missing reset;
- zero reset;
- unknown fields;
- finite percentage outside `[0,100]` preserved raw/clamped for math;
- NaN/infinite/really large body rejected.

Trust:

- fresh;
- scheduler-deliberately stale;
- claim trust bridge;
- transient failure trust ceiling;
- 429 trust until earliest reset and client cap;
- past reset invalidates;
- display-grade survives decision expiry.

Backoff:

- exponential progression and cap;
- 429 zero retry edge;
- seconds and date Retry-After;
- malformed and infinite Retry-After;
- recent-429 interval floor.

Selection:

- headroom calculation;
- known beats unknown;
- all unknown returns none;
- all exhausted returns earliest recovery;
- disabled/quarantine/auth/max-concurrency exclusions;
- priority/weight cannot resurrect exclusions;
- tie rotation;
- active-lease penalty;
- deterministic explanation.

### 31.2 Integration tests

Ndy adapter:

- mock executable writes JSON;
- warning only on stderr;
- malformed JSON;
- unsupported version;
- login prompt passthrough;
- device flag passthrough;
- history list/show;
- forced account ID;
- child signal and exit code.

HTTP:

- local TLS-capable or injected fetch server;
- exact headers excluding log output;
- redirect refusal;
- endpoint fallback;
- timeout/abort;
- response cap;
- refresh and one retry.

SQLite:

- multiple processes reserve one fetch;
- busy timeout;
- WAL recovery;
- late writer fenced;
- migration from each prior test schema;
- stale claim cleanup;
- invocation atomicity.

### 31.3 Property and concurrency tests

- arbitrary account reorder never maps usage to the wrong key;
- arbitrary late fetch ordering never overwrites a newer claim;
- arbitrary failures never erase last-good;
- no selected result belongs to the exclusion set;
- active invocation count never exceeds configured max under concurrent claims;
- traffic budget remains bounded as account count grows;
- redaction output never contains any generated secret substring.

### 31.4 Manual end-to-end acceptance

Use two test-owned Codex accounts. Do not record credentials.

1. Install project locally.
2. `codex-swap auth add --device-auth` for account A.
3. Repeat for account B.
4. Verify `accounts --json` distinguishes them by stable ID.
5. Verify first snapshots bootstrap quota gradually, then stop fetching within TTL.
6. Launch account A and B concurrently using explicit selectors.
7. Launch two strategy-selected sessions and verify invocation leases distribute them.
8. Create a session under A and note its UUID.
9. List it through `codex-swap history --json`.
10. Resume that UUID pinned to B.
11. Force a transient usage failure and verify last-good remains visible.
12. Disable one account and verify automatic selection skips it while explicit selection still works.
13. Kill a `codex-swap` parent and verify its lease expires.
14. Confirm ndy did not install an app bind or launcher and did not start its background quota sweep.
15. Search the database and logs for known token substrings; find none.

---

## 32. Definition of done

The first stable release is complete only when all are true:

- A user can add multiple accounts through browser, device, or manual auth prompts.
- Accounts are queryable through a documented, versioned, secret-free JSON schema.
- Usage is fetched account-specifically and stored per account.
- A failed fetch never blanks other accounts or destroys last-good usage.
- Repeated snapshots inside TTL generate no additional network requests.
- Multiple processes coordinate with claim fencing.
- Polling normally touches only the active account and one due candidate per pass.
- 429, timeout, 5xx, malformed response, 401, invalid grant, and dependency errors are distinct.
- Dead credentials are quarantined and automatically released when credential lineage changes.
- Automatic selection never chooses a disabled, exhausted, quarantined, ambiguous, over-capacity, or untrusted account.
- Selection explains every exclusion and no-selection result.
- `run --strategy` selects and leases atomically.
- Concurrent harnesses distribute across accounts according to lease-aware policy.
- Forced account invocation is ephemeral and fail-hard.
- All sessions use canonical `CODEX_HOME`.
- History includes native and proxy provider rollouts.
- Any listed session can be resumed by explicit ID while pinning another usable account.
- Tokens never appear in `codex-swap` SQLite, logs, JSON, or exception messages.
- Project-local installation does not bind the Codex app, install launchers, or enable ndy background quota sweeps.
- Typecheck, unit, integration, concurrency, security, and manual acceptance suites pass.

---

## 33. Known risks and decisions that may change later

### Private usage endpoint stability

The direct wham/Codex usage endpoints are not a promised public platform API. Isolate them behind `UsageProbe`, validate aggressively, and report capability failure clearly. Do not let endpoint churn infect selection or storage code.

### Codex-specific rate-limit shape is unmeasured

Claude Swap’s cadence numbers are backed by Anthropic observations, not Codex. Start conservative, log request and 429 rates, and revise constants based on evidence. Preserve the algorithmic shape.

### Ndy credential storage is plaintext JSON

Owner permissions help, but this is still a security downgrade from cma’s encrypted vault. Do not falsely claim encrypted credentials. A future encrypted runtime likely requires replacing or forking the wrapper, not merely encrypting our SQLite database.

### Refresh-token races across ndy and codex-swap processes

Use compare-and-adopt behavior and adversarial tests. If the stable ndy library API cannot safely support external refresh, prefer an upstream account-specific probe API that keeps refresh inside ndy.

### Provider split in native picker

This is a presentation/filtering problem, not separate account histories. Keep the direct-ID resume contract and provider-independent history listing.

### Same email, multiple workspaces

Never use email alone when `accountId` exists. Reject ambiguity instead of selecting the first match.

### Upstream dependency breadth

Ndy is large and fast-moving. Pin exactly, wrap every external shape, and keep our public contract independent. Do not mirror its TUI or internal policy model.

---

## 34. Dependency upgrade checklist

Before changing the pinned ndy version:

1. Read its release notes between old and new versions.
2. Diff `package.json` exports and binaries.
3. Diff the public API contract.
4. Diff `AccountMetadataV3` and storage migrations.
5. Diff `status --json` and `history --json` output builders.
6. Diff forced-account resolution and fail-hard behavior.
7. Confirm containment environment names still work.
8. Confirm `CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS=0` still suppresses detached forecast refresh.
9. Confirm project-local installs still skip machine app binding.
10. Run adapter contract fixtures against the real package.
11. Run two-account manual forced invocation and cross-account resume.
12. Search release changes for token storage, permissions, refresh, and proxy security.
13. Update the pinned revision and source links in this handoff’s successor docs.

Do not accept a dependency update solely because `npm update` succeeds.

---

## 35. Fork decision gate

Remain a dependency consumer when:

- Tier A binaries and subpaths still cover login, storage, history, and forced invocation;
- a narrow external account-specific usage probe can be implemented safely;
- ndy’s storage and proxy security are acceptable for the product;
- upstream contract drift is manageable through adapters.

Create a minimal patch fork when:

- the missing account-specific quota primitive must execute inside ndy to avoid token-refresh races;
- upstream declines a stable command/subpath;
- a small, isolated patch can expose it without altering storage or proxy behavior.

Consider a full fork or replacement only when:

- credentials must be encrypted at rest while still usable by the runtime;
- the runtime proxy must be materially rewritten or removed;
- canonical account storage format must change;
- essential behavior requires extensive Tier C internals;
- upstream direction makes the supported boundaries unusable.

If a fork is created, keep the diff small, rebase regularly, preserve upstream tests, and make `codex-swap` depend on the forked package rather than merging the two repositories.

---

## 36. First actions for the implementation agent

1. Read this document completely.
2. Inspect the exact local source revisions listed in section 4; do not start from mutable README summaries.
3. Create `~/code/codex-swap` as a new repository.
4. Add `AGENTS.md`, `CLAUDE.md` symlink, `CONTEXT.md`, and ADRs before implementation.
5. Build Milestone 1 as the thinnest vertical slice:
   - package-local ndy resolution;
   - interactive login;
   - redacted status adapter;
   - forced account launch;
   - provider-independent history and direct resume.
6. Prove that the containment environment prevents app binding and background quota sweeps.
7. Build the SQLite account catalog and secret-free snapshot.
8. Implement the direct usage probe behind an interface and mock server before touching selection.
9. Port Claude Swap’s store semantics with concurrency tests, not its Python syntax.
10. Add selection only after decision-grade freshness is explicit.
11. Add invocation leases before claiming the project is safe for balancing harnesses.
12. Finish with real two-account cross-resume acceptance.

Do not start by:

- porting the TUI;
- importing ndy deep internals;
- calling `forecast --live` on every invocation;
- globally switching `auth.json` before launching Codex;
- creating per-account `CODEX_HOME` directories;
- treating email or array index as stable identity;
- storing a second copy of refresh tokens;
- implementing a daemon.

---

## 37. High-value source index

### Claude Swap benchmark

- [README polling and selection behavior](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/README.md#L77-L103)
- [Usage store overview and transaction protocol](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/usage_store.py#L1-L26)
- [Usage entries, claims, fencing, and record](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/usage_store.py#L787-L1141)
- [Adaptive poll policy](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/poll_policy.py#L75-L244)
- [Snapshot read boundary](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/snapshot_source.py#L1-L62)
- [Coherent account snapshot models](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/models.py#L123-L162)
- [Collector and plan commit](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/switcher.py#L3466-L3625)
- [Fail-safe best-account selection](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/switcher.py#L3696-L3765)
- [History merge-before-share](https://github.com/realiti4/claude-swap/blob/b872b73f125b596d9e94da5c99a38057b4802c56/src/claude_swap/session.py#L1005-L1086)

### Recommended dependency

- [Ndy package exports and binary list](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/package.json#L6-L35)
- [Ndy public API stability tiers](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/docs/reference/public-api.md#L7-L45)
- [Ndy login modes](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/docs/getting-started.md#L95-L126)
- [Ndy account storage types](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/storage/public-types.ts#L24-L89)
- [Ndy status JSON](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/codex-manager/commands/status.ts#L223-L270)
- [Ndy live forecast and JSON](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/codex-manager/commands/forecast.ts#L245-L414)
- [Ndy one-shot forced account docs](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/docs/reference/commands.md#L182-L209)
- [Ndy forced account source](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/scripts/codex.js#L365-L529)
- [Ndy quota probe](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/quota-probe.ts#L345-L478)
- [Ndy quota cache](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/quota-cache.ts#L9-L37)
- [Ndy background quota refresh](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/scripts/codex.js#L813-L912)
- [Ndy provider-independent history](https://github.com/ndycode/codex-multi-auth/blob/7f5c61b5b2a7bc66e35f701054189572e35e8337/lib/codex-manager/commands/history.ts#L5-L314)

### Direct usage reference

- [cma direct usage client](https://github.com/prakersh/codexmultiauth/blob/d305e83822fb27497941d7e7ef97b5ebdfbe9ecb/internal/infra/usage/client.go#L20-L79)
- [cma response parser](https://github.com/prakersh/codexmultiauth/blob/d305e83822fb27497941d7e7ef97b5ebdfbe9ecb/internal/infra/usage/status_parser.go)
- [cma encrypted vault comparison](https://github.com/prakersh/codexmultiauth/blob/d305e83822fb27497941d7e7ef97b5ebdfbe9ecb/internal/infra/store/vault_repo.go#L51-L109)

### Official Codex history behavior

- [Session metadata does not encode selected account](https://github.com/openai/codex/blob/936f5eb3ee223ab34dcb221fa7c5f9943c8092bd/codex-rs/protocol/src/protocol.rs#L3078-L3141)
- [Resume picker provider filtering](https://github.com/openai/codex/blob/936f5eb3ee223ab34dcb221fa7c5f9943c8092bd/codex-rs/tui/src/resume_picker.rs#L2088-L2114)
- [Direct UUID lookup path](https://github.com/openai/codex/blob/936f5eb3ee223ab34dcb221fa7c5f9943c8092bd/codex-rs/tui/src/lib.rs#L626-L648)

---

## 38. Final architecture summary

The intended finished system is:

```text
                         ┌─────────────────────────────┐
                         │ External TUI / harnesses    │
                         └──────────────┬──────────────┘
                                        │ versioned JSON
                         ┌──────────────▼──────────────┐
                         │ codex-swap CLI/core         │
                         │ snapshot, select, run       │
                         └───────┬───────────┬─────────┘
                                 │           │
                     ┌───────────▼───┐   ┌──▼───────────────────┐
                     │ SQLite state  │   │ ndy stable adapter    │
                     │ usage/plans   │   │ login/storage/history │
                     │ fetch claims  │   │ forced Codex wrapper  │
                     │ run leases    │   └──┬────────────────────┘
                     └───────┬───────┘      │
                             │              │ ephemeral forced account
                  ┌──────────▼──────────┐   ▼
                  │ Account-specific    │ Official Codex CLI
                  │ direct usage probe  │ canonical CODEX_HOME
                  └─────────────────────┘ shared rollout history
```

The central invariant is separation of concerns:

- ndy owns authentication and the runtime credential injection mechanism;
- `codex-swap` owns data freshness, request pacing, selection, and balancing;
- official Codex owns the canonical rollout history;
- a future TUI owns presentation only.

If implementation preserves that separation, the project can track upstream authentication changes without surrendering the smart data behavior that made Claude Swap worth emulating.

---

## 39. Retired app-server sidecars

Retired 2026-08-12. codex-swap no longer starts, registers, attaches, or
proxies dedicated Codex app-server sidecars. The product boundary is back to
the original one-shot data and invocation layer: `run` and `resume` choose an
account, take an invocation lease, and launch the native Codex process
directly.

This does not forbid a foreground App Server invocation: `run` may forward
`-c ... app-server --listen ...` exactly like any other official Codex argv.
That child holds an ordinary invocation lease and is wholly caller-owned;
codex-swap keeps no endpoint record, process registry, attach path, or special
lease purpose. This distinction is the contract AgentLaunch binds.

The removed surface included:

- `codex-swap app-server run|check|list|threads`;
- `run`/`resume --server`, `--no-server`, and automatic `--remote`
  composition;
- resident lease special-casing (`purpose: "app-server"`);
- the app-server registry, ndy capability cache, identity proxy, and
  dedicated server helper.

Existing databases migrate by expiring any live `purpose: "app-server"`
leases and dropping the retired registry/capability tables. The ordinary
invocation lease table stays unchanged for Codex launches.

The ndy fork wiring that existed only to support app-server helper fixes is
therefore retired as well: `scripts/install.sh` sets `NDY_FORK_ACTIVE=0`, so
the installed shim resolves the exact npm pin again unless an operator
explicitly sets `CODEX_SWAP_NDY_PACKAGE_DIR` for testing.
