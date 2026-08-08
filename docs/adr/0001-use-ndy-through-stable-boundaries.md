# 0001: Consume codex-multi-auth only through stable boundaries

codex-swap depends on `codex-multi-auth` (exact-pinned) instead of forking it,
because it already solves OAuth onboarding, credential storage, and fail-hard
per-invocation account pinning — but it is large, fast-moving, and its
internals are unstable. We therefore consume it only via its package-local
binaries (spawned with argument arrays, no shell) and its documented Tier A
subpaths (`/auth`, `/storage`), wrap every external shape in Zod-validated
adapters under `src/ndy/`, and treat a wholesale fork as a last resort gated
by `docs/handoff.md` §35.
