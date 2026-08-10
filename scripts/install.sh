#!/usr/bin/env bash
# codex-swap installer. Owns two things: the managed codex-multi-auth fork
# this project depends on, and the `codex-swap` command that points at it.
#
# The fork exists because stock codex-multi-auth 2.8.3 routes `app-server`
# through an ephemeral shadow home, where a resident account-pinned server
# cannot run (docs/handoff.md §39.1). The patch is one predicate and is
# offered upstream; when a release carries it this whole provisioning step
# collapses back to the npm dependency. Until then the fork is a first-class
# managed install, the same shape agentusage uses for the claude-swap fork:
# clone once, converge on fork/main by fast-forward only, and refuse rather
# than clobber anything local.
#
# Safe to re-run. Every step either converges or refuses; none destroys work.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="${CODEX_SWAP_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${CODEX_SWAP_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-swap}"
RECEIPT="$STATE_DIR/install-receipt"
NDY_CHECKOUT="${CODEX_SWAP_NDY_CHECKOUT:-$HOME/src/codex-multi-auth}"
NDY_FORK_URL="${CODEX_SWAP_NDY_FORK_URL:-https://github.com/possibilities/codex-multi-auth.git}"
NDY_UPSTREAM_URL="https://github.com/ndycode/codex-multi-auth.git"
NDY_BRANCH="main"
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

# ── the managed codex-multi-auth fork ───────────────────────────────────────
# Returns non-zero without installing anything if the checkout cannot be
# converged: a stale or hand-edited dependency is worse than none, because
# codex-swap would silently launch app-servers that bill the wrong account.
install_ndy_fork() {
    if [ ! -d "${NDY_CHECKOUT}/.git" ]; then
        note "cloning the codex-multi-auth fork into ${NDY_CHECKOUT}"
        (( DRY )) && return 0
        mkdir -p "$(dirname "${NDY_CHECKOUT}")"
        git clone --quiet --origin fork --branch "${NDY_BRANCH}" \
            "${NDY_FORK_URL}" "${NDY_CHECKOUT}" || return 1
        # Upstream stays reachable as `origin` so the checkout is also where
        # the PR keeping this fork small gets rebased and re-offered.
        git -C "${NDY_CHECKOUT}" remote add origin "${NDY_UPSTREAM_URL}" 2>/dev/null || true
    fi

    local fork_url
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

    (( DRY )) && { note "would converge ${NDY_CHECKOUT} on fork/${NDY_BRANCH} and build it"; return 0; }

    git -C "${NDY_CHECKOUT}" fetch --quiet fork "${NDY_BRANCH}" || return 1
    if [ -n "$(git -C "${NDY_CHECKOUT}" status --porcelain)" ]; then
        printf 'codex-swap install: %s has local changes; refusing to install them.\n' \
            "${NDY_CHECKOUT}" >&2
        return 1
    fi
    local current
    current="$(git -C "${NDY_CHECKOUT}" rev-parse --abbrev-ref HEAD)"
    if [ "${current}" != "${NDY_BRANCH}" ]; then
        git -C "${NDY_CHECKOUT}" checkout --quiet "${NDY_BRANCH}" || return 1
    fi
    git -C "${NDY_CHECKOUT}" merge --quiet --ff-only "fork/${NDY_BRANCH}" || {
        printf 'codex-swap install: %s cannot fast-forward to fork/%s; refusing.\n' \
            "${NDY_CHECKOUT}" "${NDY_BRANCH}" >&2
        return 1
    }

    # dist/ is generated and gitignored upstream, so a fresh clone has none.
    # Rebuild whenever HEAD moved past what the last successful build recorded.
    local head build_stamp
    head="$(git -C "${NDY_CHECKOUT}" rev-parse HEAD)"
    build_stamp="${NDY_CHECKOUT}/.codex-swap-build-stamp"
    if [ ! -f "${NDY_CHECKOUT}/dist/index.js" ] ||
       [ "$(cat "${build_stamp}" 2>/dev/null || true)" != "${head}" ]; then
        note "building codex-multi-auth at ${head:0:8} (npm ci && npm run build)"
        ( cd "${NDY_CHECKOUT}" && HUSKY=0 npm ci --silent && HUSKY=0 npm run build --silent ) || return 1
        printf '%s' "${head}" > "${build_stamp}"
    fi

    [ -f "${NDY_CHECKOUT}/scripts/codex.js" ] || {
        printf 'codex-swap install: %s has no scripts/codex.js after build; refusing.\n' \
            "${NDY_CHECKOUT}" >&2
        return 1
    }
    # The whole reason this fork exists. If the wrapper does not carry the
    # canonical-home routing, installing it would hand codex-swap a dependency
    # that fails `app-server check` anyway — say so here rather than at run time.
    if ! grep -q 'isCodexAppServerCommand(rawArgs)' "${NDY_CHECKOUT}/scripts/codex.js" ||
       ! grep -q 'useCanonicalHome' "${NDY_CHECKOUT}/scripts/codex.js"; then
        printf 'codex-swap install: %s does not carry the app-server canonical-home fix; refusing.\n' \
            "${NDY_CHECKOUT}" >&2
        return 1
    fi
    note "codex-multi-auth fork ready at ${NDY_CHECKOUT} (${head:0:8})"
}

# ── the codex-swap command ──────────────────────────────────────────────────
# A source shim rather than a build: this project runs its TypeScript directly
# under Node's type stripping. The shim is also the one place that knows where
# the managed fork lives, so every caller — including launchd-supervised
# children that inherit nothing else — resolves it without plist plumbing. An
# explicit CODEX_SWAP_NDY_PACKAGE_DIR still wins, for testing another build.
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
        printf 'export CODEX_SWAP_NDY_PACKAGE_DIR="${CODEX_SWAP_NDY_PACKAGE_DIR:-%s}"\n' "${NDY_CHECKOUT}"
        printf 'exec %q %q "$@"\n' "${NODE_BIN}" "${ROOT}/src/cli/main.ts"
    } >"${temporary}"
    chmod 755 "${temporary}"
    mv -f "${temporary}" "${target}"
    note "codex-swap -> ${ROOT} (codex-multi-auth: ${NDY_CHECKOUT})"
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
    printf 'ndy=%s\n' "${NDY_CHECKOUT}"
} >"${RECEIPT}"
chmod 600 "${RECEIPT}"

if [ "${status}" -eq 0 ]; then
    note "verifying the app-server surface"
    "${BIN_DIR}/codex-swap" app-server check >/dev/null 2>&1 ||
        printf 'codex-swap install: `codex-swap app-server check` still refuses; see its output.\n' >&2
fi
exit "${status}"
