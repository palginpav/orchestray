#!/usr/bin/env bash
# replay-last-n.sh — T-S2 (v2.0.17)
#
# Reads the last N orchestrations from .orchestray/history/*/events.jsonl,
# extracts the sequence of routing_outcome events from each, and prints a
# deterministic summary to stdout.
#
# Usage:
#   bin/replay-last-n.sh [N] [--save FILE | --compare FILE]
#
# Arguments:
#   N              Number of most-recent orchestrations to include (default: 10)
#   --save FILE    Write the current extract to FILE as a reference snapshot
#   --compare FILE Diff current extract against FILE; exit 1 if they differ
#
# Output format per orchestration (only those with >= 1 routing_outcome event):
#   ORCH <orchestration_id>
#     <agent_type>:<model_assigned>
#     <agent_type>:<model_assigned>:esc   (when escalated: true)
#     ...
#
# Fail-open: if .orchestray/history/ is missing or empty, print a note to
# stderr and exit 0.
#
# Requires: bash 4+, jq.

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────

N=10
SAVE_FILE=""
COMPARE_FILE=""

# ── Argument parsing ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --save)
      shift
      if [[ $# -eq 0 ]]; then
        echo "[orchestray] replay-last-n: --save requires a FILE argument." >&2
        exit 1
      fi
      SAVE_FILE="$1"
      shift
      ;;
    --compare)
      shift
      if [[ $# -eq 0 ]]; then
        echo "[orchestray] replay-last-n: --compare requires a FILE argument." >&2
        exit 1
      fi
      COMPARE_FILE="$1"
      shift
      ;;
    [0-9]*)
      N="$1"
      shift
      ;;
    *)
      echo "[orchestray] replay-last-n: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$SAVE_FILE" && -n "$COMPARE_FILE" ]]; then
  echo "[orchestray] replay-last-n: --save and --compare are mutually exclusive." >&2
  exit 1
fi

# ── Locate history directory ──────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HISTORY_DIR="${ORCHESTRAY_HISTORY_DIR:-${REPO_ROOT}/.orchestray/history}"

if [[ ! -d "${HISTORY_DIR}" ]]; then
  echo "[orchestray] replay-last-n: history directory not found: ${HISTORY_DIR}" >&2
  exit 0
fi

# ── Require jq ───────────────────────────────────────────────────────────────
# jq is required for reliable JSON parsing of events.jsonl.
# The previous POSIX-sed fallback used \s* (GNU-only) and was fragile against
# varied JSON formatting. Rather than maintain a broken fallback, we require jq.

if ! command -v jq > /dev/null 2>&1; then
  echo "[orchestray] replay-last-n.sh requires jq; skipping routing extraction" >&2
  exit 0
fi

# ── Extract routing decisions ─────────────────────────────────────────────────

# Collect last N orchestration directories (sorted newest-first by ls -t).
# We use process substitution to avoid a subshell pipe that breaks set -e.
mapfile -t ORCH_DIRS < <(ls -t "${HISTORY_DIR}" | head -n "${N}")

OUTPUT=""

for orch_name in "${ORCH_DIRS[@]}"; do
  events_file="${HISTORY_DIR}/${orch_name}/events.jsonl"
  [[ -f "${events_file}" ]] || continue

  orch_id=""
  decisions=""

  # Use jq for reliable JSON parsing.
  # Extract routing_outcome lines: one per line in format "agent_type|model_assigned|escalated"
  routing_lines="$(jq -r 'select(.type == "routing_outcome") | [.agent_type, (.model_assigned // "unknown"), (if .escalated == true then "esc" else "" end)] | join("|")' "${events_file}" 2>/dev/null || true)"

  if [[ -z "${routing_lines}" ]]; then
    continue
  fi

  # Get orchestration_id from the first routing_outcome event.
  orch_id="$(jq -r 'select(.type == "routing_outcome") | .orchestration_id' "${events_file}" 2>/dev/null | head -n 1)"
  [[ -z "${orch_id}" ]] && orch_id="${orch_name}"

  while IFS='|' read -r agent_type model_assigned escalated; do
    [[ -z "${agent_type}" ]] && continue
    entry="  ${agent_type}:${model_assigned}"
    [[ "${escalated}" == "esc" ]] && entry="${entry}:esc"
    decisions="${decisions}${entry}"$'\n'
  done <<< "${routing_lines}"

  [[ -z "${decisions}" ]] && continue

  block="ORCH ${orch_id}"$'\n'"${decisions}"
  OUTPUT="${OUTPUT}${block}"
done

# ── Emit output ───────────────────────────────────────────────────────────────

printf '%s' "${OUTPUT}"

# ── --save mode ───────────────────────────────────────────────────────────────

if [[ -n "${SAVE_FILE}" ]]; then
  printf '%s' "${OUTPUT}" > "${SAVE_FILE}"
  echo "[orchestray] replay-last-n: saved reference snapshot to ${SAVE_FILE}" >&2
fi

# ── --compare mode ────────────────────────────────────────────────────────────

if [[ -n "${COMPARE_FILE}" ]]; then
  if [[ ! -f "${COMPARE_FILE}" ]]; then
    echo "[orchestray] replay-last-n: reference file not found: ${COMPARE_FILE}" >&2
    exit 1
  fi

  # Compare file content against current output. Both are normalized to remove
  # a single trailing newline so that printf '%s' vs printf '%s\n' round-trips
  # do not produce false positives.
  ref_content="$(cat "${COMPARE_FILE}")"
  # Normalize: strip exactly one trailing newline from both sides if present.
  output_norm="${OUTPUT%$'\n'}"
  ref_norm="${ref_content%$'\n'}"
  if [[ "${output_norm}" == "${ref_norm}" ]]; then
    echo "[orchestray] replay-last-n: routing decisions match reference — OK" >&2
    exit 0
  else
    echo "[orchestray] replay-last-n: routing decisions DIFFER from reference!" >&2
    diff <(printf '%s\n' "${ref_norm}") <(printf '%s\n' "${output_norm}") >&2 || true
    exit 1
  fi
fi
