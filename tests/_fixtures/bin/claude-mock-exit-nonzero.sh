#!/usr/bin/env bash
# claude-mock-exit-nonzero.sh — mock claude that exits with code 137 (test).

echo "Error: claude exited unexpectedly" >&2
exit 137
