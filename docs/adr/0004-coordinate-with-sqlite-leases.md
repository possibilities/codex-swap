# 0004: Coordinate concurrent processes with SQLite leases

Multiple codex-swap processes (snapshots, harnesses, launched sessions) must
not duplicate usage probes or stampede one account, so all cross-process
coordination lives in one WAL-mode SQLite database using `BEGIN IMMEDIATE`
transactions: short fenced fetch claims for usage probes, and longer-lived
heartbeated invocation leases for running sessions. SQLite was chosen over
lock files or JSON because claims, fencing generations, and lease expiry are
inherently transactional; a crashed process's claims expire instead of
wedging the pool. `node:sqlite` is used behind a small repository interface
so `better-sqlite3` can substitute if the built-in proves insufficient.
