# 0006: A session can own its app-server, and the socket is its identity

`run`/`resume --server` starts an exclusive, account-pinned app-server for
that one launch and tears it down with it, instead of attaching to the
account's shared resident server. The trade is one ~25MB process and
~0.1–0.3s of startup per session for a property nothing else could provide:
the thread that appears on the session's socket can only be that session, so
consumers correlate thread↔launch deterministically and before any turn —
where every shared-server heuristic (cwd joins, creation-time ordering,
environment stamps) had failed silently or not at all. Lifecycle is the
process tree plus a `--parent-pid` watchdog rather than a supervisor, the
`exclusive` registry marking keeps `liveForAccount` from ever composing one
session's server onto another launch, and the billing invariant of ADR 0002
is untouched: dedicated servers are pinned to the leased account exactly as
shared ones are.
