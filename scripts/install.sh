#!/usr/bin/env bash
# codex-swap installer. Owns the `codex-swap` command and, only while the
# switch below is on, a managed codex-multi-auth fork that command binds to.
#
# The switch is off: 2.10.0 released the pinned-503 fixes carried by the fork
# (#682/#683), on top of the earlier prompt-bearing-TUI and blocker wording
# releases (#673/#674, #675/#676). The exact npm pin now ships the full fix and
# the checkout is no longer consulted. Turn it back on only for a fresh
# unreleased patch.
#
# Safe to re-run.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="${CODEX_SWAP_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${CODEX_SWAP_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-swap}"
RECEIPT="$STATE_DIR/install-receipt"
# 1 while we carry a patch upstream has not released; 0 uses the exact npm pin.
# Nothing else in this file needs editing to switch between them.
NDY_FORK_ACTIVE=0
NDY_CHECKOUT="${CODEX_SWAP_NDY_CHECKOUT:-$HOME/source/ndycode--codex-multi-auth}"
NDY_FORK_URL="${CODEX_SWAP_NDY_FORK_URL:-https://github.com/possibilities/codex-multi-auth.git}"
NDY_UPSTREAM_URL="https://github.com/ndycode/codex-multi-auth.git"
# The integration branch: the one ref this installer builds and binds, by the
# fleet's fork convention. Per-PR branches live beside it and are never moved
# by an install.
NDY_BRANCH="integration"
NDY_UPSTREAM_REMOTE="upstream"
NDY_UPSTREAM_BRANCH="main"
FORK_LOG="${CODEX_SWAP_FORK_LOG:-$STATE_DIR/fork-rebase.log}"
SHIM_MARKER="codex-swap-installer-owned:v1"
# The shim agentusage used to write for this command. One command with two
# owners races, so this installer takes it over when it sees that marker.
LEGACY_MARKER="agentusage-installer-owned:v1"

DRY=0
case "${1:-}" in
    --install) ;;
    --dry-run) DRY=1 ;;
    "") ;;
    *) printf 'Usage: install.sh [--install|--dry-run]\n' >&2; exit 64 ;;
esac

die() { printf 'codex-swap install: %s\n' "$*" >&2; exit 1; }
note() { printf 'codex-swap install: %s\n' "$*"; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is required"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 24 ] || die "node >= 24 is required (found $NODE_MAJOR)"

# ── carrying the integration branch forward ─────────────────────────────────
# Upstream keeps moving; a fork pinned to its own branch quietly stops
# receiving bugfixes and drifts until the patch it carries no longer applies.
# Every install tries to replay that patch onto current upstream — but never at
# the cost of the build that already works.
#
# `NDY_BRANCH` is the integration branch: every patch we carry, merged, and the
# only ref this installer builds and binds. It is what gets rebased here. A
# patch also offered upstream lives on its own branch, and rebasing the
# integration branch does NOT move it — keeping an open PR mergeable is a
# separate operation against a different audience, and conflating the two would
# force-push someone else's review context as a side effect of an install.
#
# The rebase happens in a scratch worktree, so the bound checkout is never left
# mid-rebase or dirty, and the live branch is repointed only after the rebase,
# the project's own CI gate, and the push have all succeeded. Any failure leaves
# the previously bound version bound and tells the human, because a fork that
# has silently stopped tracking upstream is the condition this exists to
# surface.

notify_fork() {
    local title="$1" message="$2"
    printf 'codex-swap install: %s\n' "${message}" >&2
    mkdir -p "$(dirname "${FORK_LOG}")"
    printf '%s  %s: %s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${title}" "${message}" >>"${FORK_LOG}"
    # A banner that never renders must not be the only record — the log above is
    # written first and unconditionally. `-group` replaces a previous notice in
    # place rather than stacking one per install.
    command -v terminal-notifier >/dev/null 2>&1 || return 0
    terminal-notifier -title "${title}" -message "${message}" \
        -group codex-swap-fork-rebase >/dev/null 2>&1 || true
}

# Replay `branch` onto `remote/upstream_branch`, gate it, publish it, and rebind
# the checkout to the result. Returns 0 when there was nothing to do or the whole
# sequence succeeded, 1 when the human needs to look. The caller's ff-only
# convergence must already have run, so HEAD is the fork's published tip on a
# clean tree.
rebase_fork_onto_upstream() {
    local checkout="$1" branch="$2" remote="$3" upstream_branch="$4" label="$5"
    shift 5
    local upstream_ref="${remote}/${upstream_branch}"

    if ! git -C "${checkout}" remote get-url "${remote}" >/dev/null 2>&1; then
        note "${label} has no ${remote} remote; not tracking upstream"
        return 0
    fi
    # An unreachable upstream is a network fact, not a fork problem: keep what
    # works and stay quiet. Only a real divergence failure is worth a banner.
    git -C "${checkout}" fetch --quiet "${remote}" "${upstream_branch}" 2>/dev/null || {
        note "cannot reach ${upstream_ref}; keeping ${label} on its current base"
        return 0
    }
    if git -C "${checkout}" merge-base --is-ancestor "${upstream_ref}" "${branch}"; then
        note "${label} already carries ${upstream_ref}"
        return 0
    fi

    local behind
    behind="$(git -C "${checkout}" rev-list --count "${branch}..${upstream_ref}")"
    note "${label} trails ${upstream_ref} by $([ "${behind}" -eq 1 ] && echo '1 commit' || echo "${behind} commits"); rebasing"

    local work_tree work_branch
    work_tree="$(mktemp -d "${TMPDIR:-/tmp}/${label}-rebase.XXXXXX")"
    work_branch="rebase/${label}-$$"
    rmdir "${work_tree}" 2>/dev/null || true
    git -C "${checkout}" worktree add --quiet -b "${work_branch}" \
        "${work_tree}" "${branch}" || {
        notify_fork "${label} rebase" \
            "could not create a scratch worktree; still on the previous build"
        return 1
    }

    local failure=""
    if ! git -C "${work_tree}" rebase --quiet "${upstream_ref}" >/dev/null 2>&1; then
        git -C "${work_tree}" rebase --abort >/dev/null 2>&1 || true
        failure="${label} conflicts with ${upstream_ref} and needs a hand"
    elif ! ( cd "${work_tree}" && "$@" ); then
        failure="${label} rebased onto ${upstream_ref} but its own gate failed"
    elif ! git -C "${work_tree}" push --quiet --force-with-lease \
        fork "HEAD:${branch}" >/dev/null 2>&1; then
        failure="${label} passed its gate but could not publish to fork/${branch}"
    fi

    git -C "${checkout}" worktree remove --force "${work_tree}" >/dev/null 2>&1 || true
    git -C "${checkout}" branch -D "${work_branch}" >/dev/null 2>&1 || true

    if [ -n "${failure}" ]; then
        notify_fork "${label} rebase" \
            "${failure}. Left bound to the previous build; nothing was published."
        return 1
    fi

    # Published history was rewritten, so the local branch no longer fast-forwards
    # onto it. The tree was verified clean and HEAD was the old published tip, so
    # there is nothing here to lose by taking the new one wholesale.
    git -C "${checkout}" fetch --quiet fork "${branch}" || return 1
    git -C "${checkout}" reset --quiet --hard "fork/${branch}" || return 1
    note "${label} rebased onto ${upstream_ref} and published"
}

# ── the managed codex-multi-auth fork ───────────────────────────────────────
# Returns non-zero without installing anything if the checkout cannot be
# converged: a stale or hand-edited dependency is worse than none.
install_ndy_fork() {
    (( NDY_FORK_ACTIVE )) || { note "codex-multi-auth fork retired; using the npm pin"; return 0; }

    local freshly_cloned=0
    if [ ! -d "${NDY_CHECKOUT}/.git" ]; then
        note "cloning codex-multi-auth upstream into ${NDY_CHECKOUT}"
        (( DRY )) && return 0
        mkdir -p "$(dirname "${NDY_CHECKOUT}")"
        git clone --quiet --origin upstream \
            "${NDY_UPSTREAM_URL}" "${NDY_CHECKOUT}" || return 1
        freshly_cloned=1
    fi

    local upstream_url fork_url
    upstream_url="$(git -C "${NDY_CHECKOUT}" remote get-url upstream 2>/dev/null || true)"
    if [ -z "${upstream_url}" ]; then
        (( DRY )) || git -C "${NDY_CHECKOUT}" remote add upstream "${NDY_UPSTREAM_URL}" || return 1
    elif [ "${upstream_url}" != "${NDY_UPSTREAM_URL}" ] &&
         [ "${upstream_url}" != "git@github.com:ndycode/codex-multi-auth.git" ] &&
         [ "${upstream_url}" != "https://github.com/ndycode/codex-multi-auth" ]; then
        printf 'codex-swap install: %s remote upstream points at %s, not %s; refusing.\n' \
            "${NDY_CHECKOUT}" "${upstream_url}" "${NDY_UPSTREAM_URL}" >&2
        return 1
    fi

    fork_url="$(git -C "${NDY_CHECKOUT}" remote get-url fork 2>/dev/null || true)"
    if [ -z "${fork_url}" ]; then
        (( DRY )) || git -C "${NDY_CHECKOUT}" remote add fork "${NDY_FORK_URL}" || return 1
    elif [ "${fork_url}" != "${NDY_FORK_URL}" ] &&
         [ "${fork_url}" != "git@github.com:possibilities/codex-multi-auth.git" ] &&
         [ "${fork_url}" != "https://github.com/possibilities/codex-multi-auth" ]; then
        printf 'codex-swap install: %s remote fork points at %s, not %s; refusing.\n' \
            "${NDY_CHECKOUT}" "${fork_url}" "${NDY_FORK_URL}" >&2
        return 1
    fi

    (( DRY )) && { note "would converge ${NDY_CHECKOUT} on fork/${NDY_BRANCH}, rebase it onto ${NDY_UPSTREAM_REMOTE}/${NDY_UPSTREAM_BRANCH} if upstream moved, and build it"; return 0; }

    git -C "${NDY_CHECKOUT}" fetch --quiet fork "${NDY_BRANCH}" || {
        printf 'codex-swap install: %s has no published fork/%s; publish the integration branch first.\n' \
            "${NDY_CHECKOUT}" "${NDY_BRANCH}" >&2
        return 1
    }
    if (( freshly_cloned )); then
        git -C "${NDY_CHECKOUT}" branch --quiet --track \
            "${NDY_BRANCH}" "fork/${NDY_BRANCH}" || return 1
        git -C "${NDY_CHECKOUT}" checkout --quiet "${NDY_BRANCH}" || return 1
    fi
    if [ -n "$(git -C "${NDY_CHECKOUT}" status --porcelain)" ]; then
        printf 'codex-swap install: %s has local changes; refusing to install them.\n' \
            "${NDY_CHECKOUT}" >&2
        return 1
    fi
    local current
    # Never move a checkout someone is working in. This is also where the
    # upstream PR that retires this fork gets written, and switching branches
    # under an author silently lands their next commit on the wrong ref —
    # which is exactly what happened once. Refuse and say so instead.
    current="$(git -C "${NDY_CHECKOUT}" rev-parse --abbrev-ref HEAD)"
    if [ "${current}" != "${NDY_BRANCH}" ]; then
        printf 'codex-swap install: %s is on %s, not %s; leaving it there. Switch back to install.\n' \
            "${NDY_CHECKOUT}" "${current}" "${NDY_BRANCH}" >&2
        return 1
    fi
    git -C "${NDY_CHECKOUT}" merge --quiet --ff-only "fork/${NDY_BRANCH}" || {
        printf 'codex-swap install: %s cannot fast-forward to fork/%s; refusing.\n' \
            "${NDY_CHECKOUT}" "${NDY_BRANCH}" >&2
        return 1
    }

    # HEAD is now the fork's published tip on a clean tree — the precondition the
    # rebase needs. The gate mirrors .github/workflows/ci.yml: install, typecheck,
    # lint, test, build. It runs in the scratch worktree, so its node_modules and
    # dist never touch the checkout this installer is about to build from. A
    # failure is reported, never fatal: the build below proceeds from whatever
    # this line left bound.
    rebase_fork_onto_upstream "${NDY_CHECKOUT}" "${NDY_BRANCH}" \
        "${NDY_UPSTREAM_REMOTE}" "${NDY_UPSTREAM_BRANCH}" "codex-multi-auth" \
        env HUSKY=0 bash -c \
        'npm ci --silent && npm run typecheck && npm run lint && npm run test && npm run build --silent' \
        || true

    # dist/ is generated and gitignored upstream, so a fresh clone has none.
    # Rebuild whenever HEAD moved past what the last successful build recorded.
    # The stamp lives in codex-swap's own state, not in the dependency's
    # checkout: leaving an untracked file there dirties a tree that is also
    # where the upstream PR gets rebased and reviewed.
    local head build_stamp
    head="$(git -C "${NDY_CHECKOUT}" rev-parse HEAD)"
    build_stamp="${STATE_DIR}/ndy-build-stamp"
    if [ ! -f "${NDY_CHECKOUT}/dist/index.js" ] ||
       [ "$(cat "${build_stamp}" 2>/dev/null || true)" != "${head}" ]; then
        note "building codex-multi-auth at ${head:0:8} (npm ci && npm run build)"
        ( cd "${NDY_CHECKOUT}" && HUSKY=0 npm ci --silent && HUSKY=0 npm run build --silent ) || return 1
        mkdir -p "${STATE_DIR}"
        printf '%s' "${head}" > "${build_stamp}"
    fi

    [ -f "${NDY_CHECKOUT}/scripts/codex.js" ] || {
        printf 'codex-swap install: %s has no scripts/codex.js after build; refusing.\n' \
            "${NDY_CHECKOUT}" >&2
        return 1
    }
    # The whole reason this fork is active right now. Binding a checkout that
    # does not carry the prompt-bearing-TUI canonical-home fix (#673) would
    # reinstall the startup stall under a name that claims to fix it — say so
    # here rather than discovering it in a stalled session later. The helper-
    # leak markers stay as regression guards: released 2.8.5+ carries them, so
    # their absence means a badly stale checkout. All markers live in the
    # shipped wrapper, not a test.
    if ! grep -q 'sweepStaleRuntimeRotationAppHelperMetadata' "${NDY_CHECKOUT}/scripts/codex.js" ||
       ! grep -q 'DEFAULT_APP_RUNTIME_HELPER_DETACHED_IDLE_MS' "${NDY_CHECKOUT}/scripts/codex.js"; then
        printf 'codex-swap install: %s does not carry the runtime helper-leak fix; refusing.\n' \
            "${NDY_CHECKOUT}" >&2
        return 1
    fi
    note "codex-multi-auth fork ready at ${NDY_CHECKOUT} (${head:0:8})"
}

# ── the codex-swap command ──────────────────────────────────────────────────
# A source shim rather than a build: this project runs its TypeScript directly
# under Node's type stripping, so the command is a one-line exec into the
# checkout and stays current without a rebuild step. While the fork is active
# the shim is also the one place that knows where it lives, so every caller —
# including launchd-supervised children that inherit nothing else — resolves it
# without plist plumbing. An explicit CODEX_SWAP_NDY_PACKAGE_DIR still wins,
# for testing another build; with the fork retired the dependency resolves from
# the exact npm pin and the shim names no directory at all.
install_command() {
    local target="${BIN_DIR}/codex-swap"
    if [ -e "${target}" ] &&
       ! grep -Fq "${SHIM_MARKER}" "${target}" 2>/dev/null &&
       ! grep -Fq "${LEGACY_MARKER}" "${target}" 2>/dev/null; then
        printf 'codex-swap install: %s exists and is not ours; leaving it alone.\n' "${target}" >&2
        return 1
    fi
    (( DRY )) && { note "would install ${target}"; return 0; }
    mkdir -p "${BIN_DIR}"
    local temporary="${target}.tmp.$$"
    {
        printf '#!/usr/bin/env bash\n'
        printf '# %s\n' "${SHIM_MARKER}"
        (( NDY_FORK_ACTIVE )) &&
            printf 'export CODEX_SWAP_NDY_PACKAGE_DIR="${CODEX_SWAP_NDY_PACKAGE_DIR:-%s}"\n' "${NDY_CHECKOUT}"
        printf 'exec %q %q "$@"\n' "${NODE_BIN}" "${ROOT}/src/cli/main.ts"
    } >"${temporary}"
    chmod 755 "${temporary}"
    mv -f "${temporary}" "${target}"
    if (( NDY_FORK_ACTIVE )); then
        note "codex-swap -> ${ROOT} (codex-multi-auth: ${NDY_CHECKOUT})"
    else
        note "codex-swap -> ${ROOT}"
    fi
}

status=0
install_ndy_fork || status=1
install_command || status=1

if (( DRY )); then
    exit "${status}"
fi

mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"
{
    printf '%s\n' "${SHIM_MARKER}"
    printf 'root=%s\n' "${ROOT}"
    printf 'bin=%s\n' "${BIN_DIR}"
    (( NDY_FORK_ACTIVE )) && printf 'ndy=%s\n' "${NDY_CHECKOUT}"
} >"${RECEIPT}"
chmod 600 "${RECEIPT}"

exit "${status}"
