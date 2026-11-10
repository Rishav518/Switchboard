#!/usr/bin/env bash
# Install the Claude Accounts plugin into Hermes (backend + right-sidebar pane).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HH="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HH/plugins" "$HH/desktop-plugins/claude-accounts"
rsync -a --exclude __pycache__ "$HERE/plugins/claude-accounts/" "$HH/plugins/claude-accounts/"
cp "$HERE/desktop-plugins/claude-accounts/plugin.js" "$HH/desktop-plugins/claude-accounts/plugin.js"
# disable+enable re-registers the plugin in a running gateway and hot-reloads the core (no restart)
hermes plugins disable claude-accounts </dev/null >/dev/null 2>&1 || true
hermes plugins enable claude-accounts </dev/null
echo "✓ Hermes: open the right sidebar → Claude Accounts (the pane hot-loads in the desktop app)."
