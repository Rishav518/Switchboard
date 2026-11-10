#!/usr/bin/env bash
# Switchboard (claude-accounts) — one installer for every surface.
#   bash install.sh                 → all three (Claude Code CLI, VS Code, Hermes if present)
#   bash install.sh --claude-code   → status line, /accounts, /switch-account, MCP tools
#   bash install.sh --vscode        → VS Code extension (sidebar panel + status bar)
#   bash install.sh --hermes        → Hermes plugin (right-sidebar pane + gateway auto-switch)
#   add --watch to also run Claude Code auto-switch in the background via launchd
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
want() { [ $# -eq 0 ] && return 0; for a in "${ARGS[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }
ARGS=("$@"); ONLY=0
for a in "$@"; do case "$a" in --claude-code|--vscode|--hermes) ONLY=1;; esac; done
sel() { [ "$ONLY" = 0 ] || want "$1"; }
WATCH=""; want --watch && WATCH="--watch" || true

if sel --claude-code; then
  echo "== Claude Code =="; bash "$HERE/claude-code/install.sh" $WATCH
fi
if sel --vscode; then
  echo "== VS Code =="
  CODE="$(command -v code || true)"
  [ -z "$CODE" ] && [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ] && CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  if [ -n "$CODE" ]; then "$CODE" --install-extension "$HERE/vscode-extension/claude-accounts-1.3.0.vsix" --force; else echo "VS Code CLI not found — install $HERE/vscode-extension/claude-accounts-1.3.0.vsix via Extensions → … → Install from VSIX"; fi
fi
if sel --hermes; then
  if command -v hermes >/dev/null 2>&1; then echo "== Hermes =="; bash "$HERE/hermes/install.sh"; else echo "(Hermes not installed — skipping)"; fi
fi
