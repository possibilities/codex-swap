# codex-swap

Multi-account balancing for the Codex CLI: prompted onboarding, secret-free
machine-readable account/quota data, smart adaptive usage fetching, atomic
account selection with invocation leases, and one canonical cross-account
resumable history. A TUI is explicitly out of scope; this project is the data
and invocation boundary a TUI or balancing harness consumes.

**`docs/handoff.md` is the build contract.** Do not reopen settled
architecture decisions unless a concrete source or failing test contradicts
them. `CONTEXT.md` is the glossary — use its canonical terms in code, JSON,
docs, and tests.

## Commands

```sh
npm run typecheck   # tsc --noEmit over src + test
npm test            # node --test, runs .ts directly via type stripping
npm run build       # emit dist/ (tsc -p tsconfig.build.json)
npm run check:ndy   # automated dependency-contract checks (handoff §34)
```

Node >= 24 required. Tests must never touch the real `~/.codex`, the real
ndy account store, the real codex-swap data root, or the network: every e2e
world sets `CODEX_SWAP_HOME`, `CODEX_HOME`, `CODEX_MULTI_AUTH_DIR`, and
`CODEX_SWAP_UNSAFE_USAGE_BASE_URL` to sandboxed values and uses the fake ndy
package under `test/fixtures/fake-ndy/`. Every account fixture needs a
distinct refreshToken (ndy merges same-token records on load) plus a fresh
`expiresAt` so the broker never live-refreshes.

## Architecture

`codex-multi-auth` (ndy) is an exactly pinned dependency consumed only at two
supported boundaries: its package-local binaries spawned with argument arrays
(no shell), and its documented stable package subpaths (`/auth`, `/storage`).
Never import `codex-multi-auth/dist/lib/...` or other internals. ndy owns
authentication and forced-account credential injection; codex-swap owns data
freshness, request pacing, selection, and balancing; official Codex owns the
canonical rollout history in one shared `CODEX_HOME`.

Dependency direction is one-way:

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

## Invariants

- Raw tokens, auth headers, authorization URLs, and callback codes never
  appear in the SQLite database, settings, logs, events, JSON output, or
  exception messages. Only `src/accounts/credential-broker.ts` may see ndy
  token fields, and only `src/pi/profile-auth.ts` may read a pi profile's
  auth.json — it exports derived identity facts, never credentials.
- Accounts are identified by stable `account_key`
  (`record:<recordId>` | `account:<providerAccountId>` | `legacy:<hash>`),
  never by array index or email alone.
- Every ndy child process gets the containment environment
  (`src/ndy/environment.ts`): no app bind, no launcher installs, no status
  line, no detached background quota sweeps. Runtime rotation proxy stays ON.
- A failed usage fetch never overwrites last-good measurements. Display-grade
  and decision-grade usage are distinct; unknown data never silently drives
  automatic selection.
- All persisted times are integer Unix epoch milliseconds UTC; JSON output
  renders ISO 8601 UTC strings.
- JSON commands emit exactly one envelope object
  (`{schemaVersion, command, generatedAt, data, error}`) on stdout; logs and
  warnings go to stderr. Exit codes per `src/cli/exit-codes.ts`.
- Child processes are spawned with argument arrays and `shell: false`, args
  after `--` forwarded byte-for-byte.
- Selection is fail-safe: forced accounts fail hard rather than fall back;
  automatic selection returns "none" with reasons rather than guessing.

## Dependency upgrades

`codex-multi-auth` is pinned exactly. Follow the upgrade checklist in
`docs/handoff.md` §34 before changing the pin; adapters in `src/ndy/` are the
only place its shapes may be consumed.
