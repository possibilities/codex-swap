#!/usr/bin/env bash
# codex-swap installer. Owns the `codex-swap` command.
#
# It briefly also owned a managed codex-multi-auth fork, because 2.8.3 routed
# `app-server` through an ephemeral shadow home where a resident
# account-pinned server cannot run. 2.8.4 carries the fix upstream
# (ndycode/codex-multi-auth#659), so the dependency is the exact npm pin again
# and there is nothing to provision.
#
# Safe to re-run.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="${CODEX_SWAP_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${CODEX_SWAP_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-swap}"
RECEIPT="$STATE_DIR/install-receipt"
NDY_UPSTREAM_REMOTE="origin"
NDY_UPSTREAM_BRANCH="main"
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

# ── the codex-swap command ──────────────────────────────────────────────────
# A source shim rather than a build: this project runs its TypeScript directly
# under Node's type stripping, so the command is a one-line exec into the
# checkout and stays current without a rebuild step. The dependency resolves
# from the exact npm pin; CODEX_SWAP_NDY_PACKAGE_DIR still overrides it for
# testing another build.
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
        printf 'exec %q %q "$@"\n' "${NODE_BIN}" "${ROOT}/src/cli/main.ts"
    } >"${temporary}"
    chmod 755 "${temporary}"
    mv -f "${temporary}" "${target}"
    note "codex-swap -> ${ROOT}"
}

status=0
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
} >"${RECEIPT}"
chmod 600 "${RECEIPT}"

if [ "${status}" -eq 0 ]; then
    note "verifying the app-server surface"
    "${BIN_DIR}/codex-swap" app-server check >/dev/null 2>&1 ||
        printf 'codex-swap install: `codex-swap app-server check` still refuses; see its output.\n' >&2
fi
exit "${status}"
