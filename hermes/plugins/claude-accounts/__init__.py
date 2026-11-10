"""Claude Accounts — agent half: a /claude-accounts slash command (read-only summary).

The watchdog (auto-switch) runs only in the gateway via dashboard/plugin_api.py. When the gateway
re-registers this plugin (``hermes plugins disable/enable``, a reload) and the core module changed on
disk, the running watchdog is stopped and the fresh core is swapped in — no gateway restart needed.
"""
from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

_CORE_NAME = "claude_accounts_core"
_CORE_PATH = Path(__file__).resolve().parent / "claude_accounts_core.py"
log = logging.getLogger("plugins.claude_accounts")


def _load_fresh():
    spec = importlib.util.spec_from_file_location(_CORE_NAME, _CORE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod._loaded_mtime = _CORE_PATH.stat().st_mtime
    sys.modules[_CORE_NAME] = mod
    return mod


def _core():
    mod = sys.modules.get(_CORE_NAME)
    if mod is None:
        return _load_fresh()
    try:
        current = _CORE_PATH.stat().st_mtime
    except OSError:
        return mod
    if getattr(mod, "_loaded_mtime", None) == current:
        return mod
    # Stale core in this process: stop its watchdog, load the new one, rebind the API module.
    wd = getattr(mod, "_watchdog", None) or {}
    thread = wd.get("thread")
    had_watchdog = bool(thread and thread.is_alive())
    try:
        wd["stop"].set()
        wd["wake"].set()
        if thread:
            thread.join(timeout=5)
    except Exception:
        pass
    new = _load_fresh()
    for m in list(sys.modules.values()):
        if getattr(m, "_CORE_NAME", None) == _CORE_NAME and hasattr(m, "router") and hasattr(m, "core"):
            m.core = new
    if had_watchdog:
        new.ensure_watchdog()
    log.info("claude-accounts: hot-reloaded core (watchdog %s)", "restarted" if had_watchdog else "not running here")
    return new


def _handle(raw_args: str = "") -> str:
    arg = (raw_args or "").strip().lower()
    try:
        core = _core()
        if arg in ("on", "off"):
            core.save_settings({"auto_switch": arg == "on"})
        elif arg.isdigit():
            core.save_settings({"threshold": int(arg)})
        return core.text_summary(refresh=True)
    except Exception as exc:  # never break the session over a status readout
        return f"claude-accounts: {type(exc).__name__}: {exc}"


def register(ctx) -> None:
    try:
        _core()
    except Exception:
        log.warning("claude-accounts: core load failed", exc_info=True)
    ctx.register_command(
        "claude-accounts",
        handler=_handle,
        description="Claude account usage + auto-switch status (args: on | off | <threshold %>)",
        args_hint="[on|off|<pct>]",
    )
