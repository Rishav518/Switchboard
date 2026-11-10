# Switchboard

**One sidebar for all your AI coding accounts**: Claude, Antigravity and GitHub Copilot.

- **Usage per account**: Claude's 5-hour and weekly limits, Antigravity's quota per model group and Copilot's premium requests, with reset times. Each card has its own refresh button.
- **Automatic switching**: when the account in use reaches the threshold (90% by default), Switchboard moves to the least-used account that still has room. New Claude Code sessions start on the new account.
- **Context per session**: a ring shows how full the current Claude Code session's context window is, plus a list of recent sessions.
- **Model routing**: the Routing tab sends small tasks to a fast model and hard thinking to the best one, through three Claude Code sub-agents (`fast-worker`, `builder`, `architect`).
- **Running now**: every active session and the sub-agents it started, with the model each one runs on and what it is doing.
- **Delegated tasks**: a history of every hand-off with its model, result and tokens.
- **Status bar**: shows `account 5h% · week%` and the context %. Click it to switch.
- **Adding accounts**: use **Add** at the top of the panel. Claude signs in on claude.ai, Antigravity with Google, and Copilot with a GitHub device code.

The bundled `core/claude_accounts.py` engine does the work. It needs Python 3.9+ and uses only the standard library.

Run **Switchboard: Set up Claude Code integration** from the Command Palette to also install the Claude Code status line, the `/accounts` and `/switch-account` commands, and the MCP tools.

For Copilot, **Use** opens VS Code's own account picker, because VS Code has no way to switch the Copilot account silently.
