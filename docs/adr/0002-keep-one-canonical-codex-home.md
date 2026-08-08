# 0002: Keep one canonical Codex home

All sessions run against the user's real `CODEX_HOME` (normally `~/.codex`)
regardless of which account is pinned, because credentials are injected by the
ndy runtime proxy — not by swapping homes — and a single rollout store is what
makes any session resumable under any account. Per-account Codex homes (the
clausona approach) fragment history and force lossy merge operations, so they
are rejected for normal operation.
