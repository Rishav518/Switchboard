# Claude Accounts (Hermes plugin)

Several Claude logins in one Hermes, with usage for each one, context for each chat, and an automatic switch to another account before the current one runs out.

## Pieces

| Path | What it does |
|---|---|
| `~/.hermes/plugins/claude-accounts/claude_accounts_core.py` | All the logic: pool reads, usage/profile fetches, threshold policy, moving live sessions, PKCE add-account. |
| `~/.hermes/plugins/claude-accounts/dashboard/plugin_api.py` | REST routes at `/api/plugins/claude-accounts/*`. Starts the watchdog in the gateway. |
| `~/.hermes/plugins/claude-accounts/__init__.py` | The `/claude-accounts [on\|off\|<pct>]` slash command. Hot-reloads the core when it changes. |
| `~/.hermes/desktop-plugins/claude-accounts/plugin.js` | The right-sidebar pane and the status-bar chip (`Claude NN%`). |
| `~/.hermes/plugin-data/claude-accounts/` | `settings.json`, `events.json` (activity), `overrides.json`, `status.json` (watchdog health). |

## How switching works

* Each account is one entry in Hermes' `anthropic` credential pool (`hermes auth list anthropic`).
* The watchdog runs every `poll_seconds` (3 min by default). It reads `GET api.anthropic.com/api/oauth/usage` for each OAuth account to get the 5-hour, weekly and per-model windows.
* An account is *hot* when a watched window is at or above the threshold (90% by default). If another account is still below the threshold, the hot one is benched in the pool until that window resets (reason `usage_threshold`). New chats then start on the next account. Every 15 s, idle open chats on a benched account are moved over between turns. A chat that is mid-turn is never touched.
* If every account is hot, nothing gets benched. Hermes' own 429 rotation and fallback take over from there.
* **Use** (manual switch) moves the account to the front. Hermes always keeps manually added logins ahead of auto-discovered ones (Claude Code's login), so any account still ahead of the one you picked is put on *standby* (reason `manual_switch`). Auto-switch brings standby accounts back if the active account runs hot.
* Rotating to another account resets the provider's prompt cache. The next request in a moved chat re-reads the whole history once.

## Ops

```bash
hermes plugins enable claude-accounts        # Python half (backend + slash command)
# After editing claude_accounts_core.py, hot-reload it in the running gateway (no restart):
hermes plugins disable claude-accounts && hermes plugins enable claude-accounts
cat ~/.hermes/plugin-data/claude-accounts/status.json   # watchdog health and live agents
```

Adding an account from the pane: **+ → Open Claude sign-in → paste the `code#state` → Connect.** This runs the same PKCE flow as `hermes auth add anthropic --type oauth`. The CLI command also works.
