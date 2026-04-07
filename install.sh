#!/bin/bash
# Orchestray installer — clones or updates the plugin, then launches Claude Code with it loaded.

set -e

REPO="https://github.com/palginpav/orchestray.git"
INSTALL_DIR="${ORCHESTRAY_DIR:-$HOME/.claude-plugins/orchestray}"

echo ""
echo "  Orchestray — Multi-agent orchestration for Claude Code"
echo ""

# Install or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing installation..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "  Installing to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO" "$INSTALL_DIR"
fi

echo ""
echo "  Installed at: $INSTALL_DIR"
echo ""
echo "  Start Claude Code with Orchestray:"
echo ""
echo "    claude --plugin-dir $INSTALL_DIR"
echo ""
echo "  Or add an alias to your shell profile:"
echo ""
echo "    alias claude-o='claude --plugin-dir $INSTALL_DIR'"
echo ""
