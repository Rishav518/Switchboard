#!/usr/bin/env bash
# Claude Accounts — Claude Code integration installer.
#   bash install.sh            status line + /accounts commands + MCP tools + save current login
#   bash install.sh --watch    also run auto-switch in the background (launchd, every 3 min)
#   bash install.sh --force    replace an existing statusLine in ~/.claude/settings.json
#   bash install.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SRC="$HERE/../core/claude_accounts.py"
[ -f "$CORE_SRC" ] || CORE_SRC="$HERE/claude_accounts.py"
APP_HOME="${CLAUDE_ACCOUNTS_HOME:-$HOME/.claude-accounts}"
BIN="$APP_HOME/bin/claude_accounts.py"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PY="$(command -v python3 || echo /usr/bin/python3)"
PLIST="$HOME/Library/LaunchAgents/com.claude-accounts.watch.plist"
WATCH=0; FORCE=0; UNINSTALL=0
for a in "$@"; do case "$a" in --watch) WATCH=1;; --force) FORCE=1;; --uninstall) UNINSTALL=1;; esac; done

find_claude() {
  command -v claude 2>/dev/null && return
  ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1
}
CLAUDE_BIN="$(find_claude || true)"

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }

if [ "$UNINSTALL" = 1 ]; then
  [ -n "$CLAUDE_BIN" ] && "$CLAUDE_BIN" mcp remove claude-accounts -s user >/dev/null 2>&1 || true
  rm -f "$CLAUDE_DIR/commands/accounts.md" "$CLAUDE_DIR/commands/switch-account.md"
  "$PY" - "$CLAUDE_DIR/settings.json" <<'EOF'
import json, sys, os
p = sys.argv[1]
try: s = json.load(open(p))
except Exception: sys.exit(0)
sl = s.get("statusLine") or {}
if "claude_accounts.py" in str(sl.get("command", "")):
    s.pop("statusLine"); json.dump(s, open(p, "w"), indent=2); print("removed statusLine")
EOF
  [ -f "$PLIST" ] && launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"
  say "Uninstalled the Claude Code integration (saved accounts stay in $APP_HOME)."
  exit 0
fi

say "Installing engine → $BIN"
mkdir -p "$APP_HOME/bin" && chmod 700 "$APP_HOME"
cp "$CORE_SRC" "$BIN" && chmod +x "$BIN"
cp "$(dirname "$CORE_SRC")/providers.py" "$APP_HOME/bin/providers.py"   # Antigravity + Copilot
cp "$(dirname "$CORE_SRC")/routing.py" "$APP_HOME/bin/routing.py"       # model routing per agent

say "Saving the account Claude Code is logged into (so you can always switch back)"
"$PY" "$BIN" import || true

say "Model routing (fast-worker / builder / architect sub-agents in $CLAUDE_DIR/agents)"
"$PY" "$BIN" routing || true

say "Status line"
"$PY" - "$CLAUDE_DIR/settings.json" "$PY $BIN statusline" "$FORCE" <<'EOF'
import json, sys, os, shutil, time
p, cmd, force = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
os.makedirs(os.path.dirname(p), exist_ok=True)
try: s = json.load(open(p))
except FileNotFoundError: s = {}
cur = s.get("statusLine")
if cur and "claude_accounts.py" not in str(cur.get("command", "")) and not force:
    print(f"  kept your existing statusLine ({cur.get('command')}). Re-run with --force to replace it, or chain:\n    {cmd}")
    sys.exit(0)
if os.path.exists(p): shutil.copy(p, p + f".bak-{time.strftime('%Y%m%d%H%M%S')}")
s["statusLine"] = {"type": "command", "command": cmd, "padding": 0}
json.dump(s, open(p, "w"), indent=2)
print("  statusLine →", cmd)
EOF

say "Slash commands → $CLAUDE_DIR/commands (/accounts, /switch-account)"
mkdir -p "$CLAUDE_DIR/commands"
for f in "$HERE"/commands/*.md; do sed "s#__BIN__#$BIN#g; s#__PY__#$PY#g" "$f" > "$CLAUDE_DIR/commands/$(basename "$f")"; done

if [ -n "$CLAUDE_BIN" ]; then
  say "MCP server (user scope) via $CLAUDE_BIN"
  "$CLAUDE_BIN" mcp remove claude-accounts -s user >/dev/null 2>&1 || true
  "$CLAUDE_BIN" mcp add -s user claude-accounts -- "$PY" "$BIN" mcp
else
  say "Claude Code CLI not found — add the MCP server later with:"
  echo "    claude mcp add -s user claude-accounts -- $PY $BIN mcp"
fi

if [ "$WATCH" = 1 ]; then
  say "Background auto-switch (launchd, every 180 s)"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-accounts.watch</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$BIN</string><string>check</string><string>--quiet</string></array>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$APP_HOME/watch.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
fi

say "Done. Try:  $PY $BIN status"
echo "  Add your other Claude account:  $PY $BIN add"
