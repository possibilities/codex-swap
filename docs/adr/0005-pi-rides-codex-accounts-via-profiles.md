# 0005: Pi rides Codex accounts via per-account pi profiles

Pi launches balance across the same ChatGPT account pool as Codex launches,
but pi is pinned through its environment, not through the ndy proxy: each
account is linked once to a pi profile — a `PI_CODING_AGENT_DIR` under the
codex-swap data root holding that account's **own pi OAuth grant** — and
`codex-swap pi run` launches pi with the profile as its agent dir, whose
`sessions` symlink resolves into the canonical pi session store (the ADR
0002 principle applied to pi: history is account-independent). The symlink,
not `PI_CODING_AGENT_SESSION_DIR`, is the sharing mechanism — pi treats an
explicit session-dir override as a flat final directory, which breaks its
project-nested layout and every id-pattern lookup built on it.

Sharing ndy's stored tokens with pi is rejected: both sides would refresh
the same grant, refresh-token rotation would have them invalidating each
other, and tokens would leave the credential-broker boundary. Ndy's loopback
bridge as a pi base URL is rejected for now: it is rotation-oriented where
codex-swap requires deterministic pinning, and it drags ndy runtime behavior
into the trust boundary. Separate grants per holder cost one interactive
`/login` per account at link time and nothing after; quota is per account,
not per grant, so the usage store observes pi burn with no extra machinery.

A link is only durable once verified — and verification compares
**identity claims, not ndy account ids**: ndy's `accountId` is an org-style
id for workspace logins, while both grants' access tokens carry the same
`chatgpt_account_id` claim for one underlying account. The credential
broker (the only module that may see ndy tokens) derives each pool
account's claim as a non-secret fact; the profile's claim must match
exactly one of them (`providerAccountId` equality is accepted as a
fallback when the id spaces align). Mismatched, ambiguous, or out-of-pool
logins are discarded rather than stored.

Account keys are derived rather than stored, so a link can be stranded
without anything being wrong with it: the day ndy starts supplying
recordIds, every account re-keys from `account:<providerAccountId>` to
`record:<recordId>`, the key-named profile directory stops matching, and a
perfectly good grant reads as unlinked. Such a profile is **adopted** rather
than re-linked — renamed onto the current key with its verification and link
timestamp intact — when its own token's claim identifies exactly one pool
account. The proof is the same claim comparison a link performs, so adoption
widens no trust boundary; it only spares an interactive `/login` that would
produce an equivalent grant. Ambiguity, a missing credential, a token that
contradicts the recorded verification, and an occupied destination each
decline the adoption and leave `pi link` as the answer.

Pi
runs take the same invocation leases as Codex runs (purpose `pi-session`),
and strategy selection excludes accounts without a verified profile
(`pi_profile_missing`) — quota alone cannot make an account launchable by a
harness it was never linked to.
