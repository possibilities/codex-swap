# 0006: Family rate-limit records gate selection, but only a live probe refuses

Selection scores accounts on codex-lane quota headroom, while ndy's runtime
proxy skips accounts on persisted **per-family rate-limit records**
(`rateLimitResetTimes`) — two disjoint signals. The 2026-08-15 incident is
what the gap costs: an account with 99% codex-lane headroom carried a
gpt-5.2 family record, selection kept choosing it, and every pinned session
wedged behind the proxy's local 503s — ndy's pinned path never re-validates
a record (its stale-state recovery runs only unpinned) and the record turned
out to be stale, so working capacity refused work for days.

Selection therefore resolves the launch's model to ndy's prompt family
(`models --json --model <m>` — the CLI contract; 2.8.5's cached `forecast`
cross-checks records against the hardwired codex family and cannot be
trusted for this) and excludes accounts whose record covers that family
(`family_rate_limited`). Reading `rateLimitResetTimes` from the store stays
inside the existing store-reader boundary, beside `coolingDownUntil`.

The record is **advisory, never verdict**: ndy writes it from one moment's
response headers or a preemptive quota mark, and nothing guarantees the
provider still enforces it. When records are the sole obstacle to a launch
(or an explicitly `--account`-targeted account is blocked), a live probe
(`forecast --live`) gets the final word — a 2xx disproves the record, which
is then cleared through ndy's own `rotation reset-rate-limits` and selection
retried once; a 429 confirms it and the refusal stands, naming the family
and reset time. A stamp file rate-limits verification so repeated launches
against a genuinely dry pool don't probe-spam. Trusting records outright is
rejected because stale records strand capacity; ignoring them is rejected
because a pinned session on a truly blocked account receives only 503s;
probing every launch is rejected on cost.
