# Architecture

codex-swap is a one-shot CLI (no daemon) coordinating through SQLite. Every
command performs a bounded, deterministic operation and exits; concurrent
processes coordinate via WAL-mode transactions, fetch claims, and invocation
leases rather than a resident server.

## Separation of concerns

- **ndy (`codex-multi-auth`, exact-pinned)** owns authentication: OAuth
  onboarding, credential storage, token refresh, and per-invocation forced
  account credential injection through its runtime proxy.
- **codex-swap** owns the smart data layer: the secret-free account read
  model, persisted usage store with claims/fencing, adaptive poll plans,
  freshness/trust rules, selection policy, and invocation leases.
- **Official Codex CLI** owns the canonical rollout history under one shared
  `CODEX_HOME`.
- **A future TUI / balancing harness** owns presentation, consuming only the
  versioned JSON contracts (`snapshot --json`, `select --json`, …).

## Module map (dependency direction is one-way, downward)

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

- `src/ndy/` — the only module allowed to touch ndy shapes: package-local bin
  resolution, containment environment, Zod-validated JSON adapters.
- `src/accounts/` — reconciliation of ndy's store into the stable
  `account_key` catalog; `credential-broker.ts` is the only file that may see
  token fields.
- `src/usage/` — probes, parser, error classification, usage store
  (claims/fencing/backoff/quarantine), adaptive poll policy, trust rules.
- `src/selection/` — exclusions, scoring, strategies, invocation leases.
- `src/snapshot/` — the coherent read boundary; assembles one versioned
  snapshot from a single pass.
- `src/runner/` — spawns the ndy forced-account wrapper with inherited stdio,
  heartbeats the invocation lease, forwards signals and exit codes.
- `src/history/` — provider-independent session listing and direct-ID resume.
- `src/storage/` — SQLite open/migrate/permissions; all times epoch ms UTC.

## Key flows

**snapshot**: reconcile accounts → derive sentinels → pick bounded due fetch
set (active + at most one due alternate) → reserve claims → fetch → record →
read everything → emit one envelope. Repeats are safe: the store, not the
caller, decides whether any network request happens.

**run --strategy**: expire stale leases → score eligible accounts → insert
`reserved` invocation lease atomically → spawn
`codex-multi-auth-codex --account <providerAccountId> …` → mark lease
`running` → heartbeat until child exit → release. Forced accounts fail hard;
there is no silent fallback.

**resume**: same as run, with `resume <session-id>` forwarded to the wrapper.
Session IDs are account-independent because history lives in one canonical
`CODEX_HOME`.
