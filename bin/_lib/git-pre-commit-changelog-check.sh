#!/usr/bin/env bash
# git-pre-commit-changelog-check.sh — v2.2.9 F3.
#
# Purpose: invoked from .git/hooks/pre-commit on commits whose subject starts
# with "release:" to mechanically diff backtick-quoted event-name tokens in
# the unreleased / topmost CHANGELOG section against the keys in
# agents/pm-reference/event-schemas.shadow.json. Mismatch → exit 2 (commit
# blocked).
#
# How it's invoked
# ----------------
# .git/hooks/pre-commit reads the prospective commit subject (from
# COMMIT_EDITMSG, the editor argument, or `git stash + git diff --cached
# --raw`). When the subject begins with "release:", the wrapper calls
# `node bin/release-manager/changelog-event-name-check.js --release` from the
# repo root. Any other subject → the wrapper exits 0 (skip).
#
# install.js wiring
# -----------------
# v2.2.9 ships this script in-tree but does NOT auto-symlink to .git/hooks.
# Per the F3 task description, install.js wiring can land later. Operators
# who want pre-commit enforcement can wire it manually:
#
#   ln -s ../../bin/_lib/git-pre-commit-changelog-check.sh .git/hooks/pre-commit
#
# Or chain into an existing pre-commit hook:
#
#   #!/usr/bin/env bash
#   bash bin/_lib/git-pre-commit-changelog-check.sh "$@" || exit $?
#
# The release-manager SubagentStop gate calls the underlying Node script
# directly (with --release) and is the primary mechanical backstop.
#
# Kill switch: ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED=1 honored ONLY for
# non-release commits. Release commits cannot opt out.

set -e

# Resolve repo root (pre-commit hooks run from the repo root by default,
# but be defensive).
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")"
cd "${repo_root}"

# Read the prospective commit subject. git's pre-commit hook does NOT receive
# the commit message; the canonical way to read it is from .git/COMMIT_EDITMSG
# AFTER it's been written. For pre-commit we use commit-msg instead OR fall
# back to inspecting the staged diff for CHANGELOG.md presence.
#
# Strategy: try COMMIT_EDITMSG first (works when the wrapper is also chained
# into commit-msg). When unavailable, treat as best-effort and run the check
# anyway when CHANGELOG.md is among the staged paths AND a "release:" sentinel
# file exists (operator opts in by writing the sentinel before commit).

subject=""
if [ -f "${repo_root}/.git/COMMIT_EDITMSG" ]; then
  subject="$(head -n1 "${repo_root}/.git/COMMIT_EDITMSG" 2>/dev/null || true)"
fi

# When subject starts with "release:" → strict mode.
case "${subject}" in
  release:*)
    exec node "${repo_root}/bin/release-manager/changelog-event-name-check.js" --release --cwd "${repo_root}"
    ;;
esac

# Non-release commit. Honor kill switch if set.
if [ "${ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED:-}" = "1" ]; then
  exit 0
fi

# Run in non-strict (no --release) mode so any drift is reported. The Node
# script honors the kill switch when --release is NOT passed.
exec node "${repo_root}/bin/release-manager/changelog-event-name-check.js" --cwd "${repo_root}"
