#!/usr/bin/env bash
# install-pre-commit-guard.sh — T12 (v2.0.17)
#
# Installs (or removes) a .git/hooks/pre-commit hook that alerts when
# Block A of agents/pm.md changes without an 'BLOCK-A: approved' line in
# the commit message.
#
# Usage:
#   bash bin/install-pre-commit-guard.sh           # install
#   bash bin/install-pre-commit-guard.sh --uninstall  # remove
#
# Prerequisites:
#   - cache_choreography.pre_commit_guard_enabled must be true in
#     .orchestray/config.json (this script will exit 0 with a message if not).
#   - Must be run from the git repository root (or any subdirectory).
#   - Will NOT overwrite an existing pre-commit hook unless it was installed by
#     this script (detected by the Orchestray guard header marker).
#
# POSIX-compatible; requires: bash, node (for config check), git.

set -euo pipefail

MARKER="# orchestray-block-a-guard"
SENTINEL_COMMENT="# installed by bin/install-pre-commit-guard.sh"

# ── Locate git root ──────────────────────────────────────────────────────────

GIT_ROOT=""
if git rev-parse --show-toplevel > /dev/null 2>&1; then
  GIT_ROOT="$(git rev-parse --show-toplevel)"
else
  echo "[orchestray] pre-commit-guard: not inside a git repository — nothing to do." >&2
  exit 0
fi

HOOKS_DIR="${GIT_ROOT}/.git/hooks"
HOOK_FILE="${HOOKS_DIR}/pre-commit"

# ── Check config gate ────────────────────────────────────────────────────────
# Read cache_choreography.pre_commit_guard_enabled from .orchestray/config.json.
# If the flag is false (the default), exit 0 — this script is strictly opt-in.

CONFIG_FILE="${GIT_ROOT}/.orchestray/config.json"
GUARD_ENABLED="false"

if [ -f "${CONFIG_FILE}" ]; then
  # Use node if available to parse JSON accurately.
  if command -v node > /dev/null 2>&1; then
    GUARD_ENABLED="$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('${CONFIG_FILE}', 'utf8'));
        const v = (c && c.cache_choreography && c.cache_choreography.pre_commit_guard_enabled);
        process.stdout.write(String(!!v));
      } catch(e) { process.stdout.write('false'); }
    " 2>/dev/null || echo 'false')"
  fi
fi

if [ "${GUARD_ENABLED}" != "true" ]; then
  echo "[orchestray] pre-commit-guard: cache_choreography.pre_commit_guard_enabled is not true."
  echo "             Set it to true in .orchestray/config.json to enable this guard."
  exit 0
fi

# ── Uninstall mode ───────────────────────────────────────────────────────────

if [ "${1:-}" = "--uninstall" ]; then
  if [ ! -f "${HOOK_FILE}" ]; then
    echo "[orchestray] pre-commit-guard: no pre-commit hook found — nothing to remove."
    exit 0
  fi
  # Only remove the hook if it was installed by this script (safety check).
  if grep -qF "${MARKER}" "${HOOK_FILE}" 2>/dev/null; then
    rm -f "${HOOK_FILE}"
    echo "[orchestray] pre-commit-guard: removed .git/hooks/pre-commit."
  else
    echo "[orchestray] pre-commit-guard: .git/hooks/pre-commit was not installed by Orchestray."
    echo "             Remove it manually if you no longer want it."
  fi
  exit 0
fi

# ── Install mode ─────────────────────────────────────────────────────────────

# If a hook file already exists AND it was not installed by us, refuse to overwrite.
if [ -f "${HOOK_FILE}" ]; then
  if grep -qF "${MARKER}" "${HOOK_FILE}" 2>/dev/null; then
    echo "[orchestray] pre-commit-guard: hook already installed (re-installing to update)."
    rm -f "${HOOK_FILE}"
  else
    echo "[orchestray] pre-commit-guard: a pre-commit hook already exists at ${HOOK_FILE}."
    echo "             Orchestray will NOT overwrite it (opt-in safety rule)."
    echo "             To use the Orchestray guard, either:"
    echo "               1. Remove or rename the existing hook, then re-run this script."
    echo "               2. Manually append the guard logic to your existing hook."
    exit 0
  fi
fi

# Write the hook.
mkdir -p "${HOOKS_DIR}"

cat > "${HOOK_FILE}" << 'HOOK_BODY'
#!/usr/bin/env bash
# orchestray-block-a-guard
# installed by bin/install-pre-commit-guard.sh
#
# Blocks commits that change Block A of agents/pm.md without an explicit
# 'BLOCK-A: approved' line in the commit message.
#
# Block A is defined as everything before the <!-- ORCHESTRAY_BLOCK_A_END -->
# sentinel in agents/pm.md. Changing Block A without approval risks breaking
# prompt-caching prefix stability (v2.0.17 S1 — T12).

SENTINEL="<!-- ORCHESTRAY_BLOCK_A_END -->"
BLOCK_A_CHANGED=0

# Check if agents/pm.md is staged for commit.
if git diff --cached --name-only | grep -qF "agents/pm.md"; then
  # Extract the staged version of agents/pm.md and find the sentinel.
  STAGED_CONTENT="$(git show ":agents/pm.md" 2>/dev/null || true)"

  if echo "${STAGED_CONTENT}" | grep -qF "${SENTINEL}"; then
    # The sentinel is present. Extract Block A (lines before the sentinel).
    STAGED_BLOCK_A="$(echo "${STAGED_CONTENT}" | sed "/${SENTINEL}/q" | sed '$d')"

    # Get the HEAD version for comparison (empty on first commit).
    HEAD_CONTENT="$(git show "HEAD:agents/pm.md" 2>/dev/null || true)"
    if [ -n "${HEAD_CONTENT}" ] && echo "${HEAD_CONTENT}" | grep -qF "${SENTINEL}"; then
      HEAD_BLOCK_A="$(echo "${HEAD_CONTENT}" | sed "/${SENTINEL}/q" | sed '$d')"
    else
      HEAD_BLOCK_A=""
    fi

    if [ "${STAGED_BLOCK_A}" != "${HEAD_BLOCK_A}" ]; then
      BLOCK_A_CHANGED=1
    fi
  fi
fi

if [ "${BLOCK_A_CHANGED}" -eq 1 ]; then
  # Read the commit message from the prepare-commit-msg tmp file if available,
  # otherwise fall back to COMMIT_EDITMSG.
  COMMIT_MSG_FILE="${GIT_DIR:-$(git rev-parse --git-dir)}/COMMIT_EDITMSG"
  COMMIT_MSG=""
  if [ -f "${COMMIT_MSG_FILE}" ]; then
    COMMIT_MSG="$(cat "${COMMIT_MSG_FILE}")"
  fi

  if ! echo "${COMMIT_MSG}" | grep -qi "BLOCK-A: approved"; then
    echo "" >&2
    echo "  [orchestray] BLOCKED: Block A of agents/pm.md was modified." >&2
    echo "" >&2
    echo "  Block A is the stable prefix used for prompt-caching (v2.0.17 S1)." >&2
    echo "  Any change to Block A can invalidate cached prefixes across all users." >&2
    echo "" >&2
    echo "  To proceed, add this line to your commit message:" >&2
    echo "    BLOCK-A: approved" >&2
    echo "" >&2
    echo "  Then re-run your commit command." >&2
    echo "" >&2
    echo "  To bypass this check entirely, run:" >&2
    echo "    bash bin/install-pre-commit-guard.sh --uninstall" >&2
    echo "" >&2
    exit 1
  fi
fi

exit 0
HOOK_BODY

chmod +x "${HOOK_FILE}"

echo "[orchestray] pre-commit-guard: installed .git/hooks/pre-commit."
echo "             Commits that change Block A of agents/pm.md now require"
echo "             'BLOCK-A: approved' in the commit message."
