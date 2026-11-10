"""Claude Accounts — multi-account usage monitor + proactive switcher for Hermes.

Runs inside the process that imports it. The dashboard backend (``dashboard/plugin_api.py``)
imports it in the gateway process the desktop app talks to and starts the watchdog there; the
CLI slash command imports it read-only (no watchdog).

What it does
------------
* Lists every credential in Hermes' ``anthropic`` credential pool (each one = a Claude login).
* Polls ``/api/oauth/usage`` + ``/api/oauth/profile`` per OAuth account (cached, default 3 min).
* When an account's 5-hour or weekly window reaches the threshold (default 90 %) and another
  account is still below it, the hot account is benched in the pool until that window resets
  (``last_error_reason = usage_threshold``). New sessions then pick the next account, and idle
  live desktop sessions on the hot account are moved over between turns.
* Manual "use this account", "clear bench", add-account (PKCE paste-code flow) and remove.

No secret ever leaves this module: API responses carry ids/labels/percentages only.
"""
from __future__ import annotations

import contextlib
import io
import json
import re
import logging
import secrets
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("plugins.claude_accounts")

PLUGIN_ID = "claude-accounts"
PROVIDER = "anthropic"
BENCH_REASON = "usage_threshold"
MANUAL_REASON = "manual_switch"
OUR_REASONS = (BENCH_REASON, MANUAL_REASON)
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

WINDOW_LABELS = {
    "five_hour": "Session · 5h",
    "seven_day": "Weekly · 7d",
    "seven_day_opus": "Opus · weekly",
    "seven_day_sonnet": "Sonnet · weekly",
}
ACCOUNT_WINDOWS = ("five_hour", "seven_day")

DEFAULT_SETTINGS: dict[str, Any] = {
    "auto_switch": True,
    "threshold": 90,
    "poll_seconds": 180,
    "windows": list(ACCOUNT_WINDOWS),
    "move_live_sessions": True,
    "provider_auto": {"antigravity": True, "copilot": True},
}

PROFILE_TTL_S = 6 * 3600
FAST_LOOP_S = 15
FORCE_TARGET_TTL_S = 600

_state_lock = threading.RLock()
_check_lock = threading.Lock()
_usage_cache: dict[str, dict[str, Any]] = {}     # entry id -> {at, data, error, error_at}
_profile_cache: dict[str, dict[str, Any]] = {}   # entry id -> {at, data}
_blind_notice: dict[str, float] = {}
_token_fp: dict[str, str] = {}                   # entry id -> fingerprint of the token the caches were read with
_pending_logins: dict[str, dict[str, Any]] = {}  # oauth state -> {verifier, created, label}
_force_target: dict[str, Any] = {}               # {"id": str, "until": ts}
_last_check: dict[str, Any] = {"at": None, "reason": None, "duration_ms": None}
_watchdog: dict[str, Any] = {"thread": None, "stop": threading.Event(), "wake": threading.Event()}
_all_hot_notice: dict[str, Any] = {"key": None}


# ─── paths / persistence ──────────────────────────────────────────────────────────────────────

def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


def _data_dir() -> Path:
    d = _home() / "plugin-data" / PLUGIN_ID
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_json(name: str, default: Any) -> Any:
    try:
        return json.loads((_data_dir() / name).read_text("utf-8"))
    except Exception:
        return default


def _write_json(name: str, data: Any) -> None:
    path = _data_dir() / name
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str), "utf-8")
    tmp.replace(path)


def load_settings() -> dict[str, Any]:
    raw = _read_json("settings.json", {})
    out = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        out.update({k: v for k, v in raw.items() if k in DEFAULT_SETTINGS})
    return _validate_settings(out)


def _validate_settings(s: dict[str, Any]) -> dict[str, Any]:
    s["auto_switch"] = bool(s.get("auto_switch"))
    s["move_live_sessions"] = bool(s.get("move_live_sessions"))
    try:
        s["threshold"] = max(50, min(99, int(round(float(s.get("threshold", 90))))))
    except (TypeError, ValueError):
        s["threshold"] = 90
    try:
        s["poll_seconds"] = max(60, min(1800, int(s.get("poll_seconds", 180))))
    except (TypeError, ValueError):
        s["poll_seconds"] = 180
    wins = [w for w in (s.get("windows") or []) if w in WINDOW_LABELS]
    s["windows"] = wins or list(ACCOUNT_WINDOWS)
    pa = s.get("provider_auto") if isinstance(s.get("provider_auto"), dict) else {}
    s["provider_auto"] = {k: bool(pa.get(k, True)) for k in ("antigravity", "copilot")}
    return s


def _safe(fn, default):
    try:
        return fn()
    except Exception:
        log.warning("claude-accounts: %s failed", getattr(fn, "__name__", fn), exc_info=True)
        return default


def refresh_account(key: str) -> dict[str, Any]:
    """Re-read one account's usage (and name) right now."""
    provider, pid = _split_provider(key)
    if provider:
        P = _engine()
        if P is not None:
            P.forget_usage(pid)
            providers_snapshot()
        return {"ok": P is not None}
    for e in _load_pool().entries():
        if e.id == key:
            _refresh_entry(e, force=True, poll_s=load_settings()["poll_seconds"])
            return {"ok": True, "error": (_usage_cache.get(e.id) or {}).get("error")}
    return {"ok": False, "error": "No such account"}


def save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    if isinstance(patch, dict) and patch.get("refresh_account"):
        # routed through /settings so it works on a gateway that mounted the API before this existed
        return {**load_settings(), "_refresh": refresh_account(str(patch["refresh_account"]))}
    if isinstance(patch, dict) and isinstance(patch.get("routing"), dict):
        # routed through /settings so it works on a gateway that mounted the API before this existed
        rest = {k: v for k, v in patch.items() if k != "routing"}
        res = routing_save(patch["routing"])
        if rest:
            save_settings(rest)
        return {**load_settings(), "_routing": res}
    with _state_lock:
        cur = load_settings()
        patch = dict(patch or {})
        if isinstance(patch.get("provider_auto"), dict):
            patch["provider_auto"] = {**cur.get("provider_auto", {}), **patch["provider_auto"]}
        cur.update({k: v for k, v in patch.items() if k in DEFAULT_SETTINGS})
        cur = _validate_settings(cur)
        _write_json("settings.json", cur)
    _mirror_engine_settings(cur)
    _watchdog["wake"].set()
    return cur


def _overrides() -> dict[str, float]:
    raw = _read_json("overrides.json", {})
    now = time.time()
    return {k: float(v) for k, v in (raw.items() if isinstance(raw, dict) else []) if _num(v) and float(v) > now}


def _set_override(entry_id: str, until: Optional[float]) -> None:
    with _state_lock:
        cur = _overrides()
        if until:
            cur[entry_id] = until
        else:
            cur.pop(entry_id, None)
        _write_json("overrides.json", cur)


def events(limit: int = 30) -> list[dict[str, Any]]:
    raw = _read_json("events.json", [])
    return raw[-limit:][::-1] if isinstance(raw, list) else []


def _event(kind: str, message: str, **extra: Any) -> dict[str, Any]:
    ev = {"id": uuid.uuid4().hex[:8], "at": time.time(), "kind": kind, "message": message, **extra}
    with _state_lock:
        raw = _read_json("events.json", [])
        raw = raw if isinstance(raw, list) else []
        raw.append(ev)
        _write_json("events.json", raw[-60:])
    log.info("claude-accounts: %s — %s", kind, message)
    _broadcast("event", ev)
    return ev


def _broadcast(name: str, payload: Optional[dict] = None) -> None:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
        broadcast_plugin_event(PLUGIN_ID, name, payload or {})
    except Exception:
        log.debug("broadcast failed", exc_info=True)


# ─── profile secret scope (multiplexing gateway requires one for credential reads) ───────────

def _scoped(fn):
    import functools

    @functools.wraps(fn)
    def wrapper(*a, **kw):
        token = None
        try:
            from agent.secret_scope import build_profile_secret_scope, current_secret_scope, set_secret_scope
            if current_secret_scope() is None:
                home = _home()
                token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
        except Exception:
            token = None
        try:
            return fn(*a, **kw)
        finally:
            if token is not None:
                with contextlib.suppress(Exception):
                    from agent.secret_scope import reset_secret_scope
                    reset_secret_scope(token)
    return wrapper


# ─── helpers ──────────────────────────────────────────────────────────────────────────────────

def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _parse_ts(v: Any) -> Optional[float]:
    if v in (None, ""):
        return None
    if _num(v):
        f = float(v)
        return f / 1000.0 if f > 1e12 else f
    try:
        text = str(v).strip()
        text = text[:-1] + "+00:00" if text.endswith("Z") else text
        dt = datetime.fromisoformat(text)
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None


def _iso(ts: Optional[float]) -> Optional[str]:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None


def _load_pool():
    from agent.credential_pool import load_pool
    return load_pool(PROVIDER)


def _strategy() -> str:
    try:
        from agent.credential_pool import get_pool_strategy
        return get_pool_strategy(PROVIDER)
    except Exception:
        return "fill_first"


def _token(entry: Any) -> str:
    return str(getattr(entry, "runtime_api_key", "") or getattr(entry, "access_token", "") or "").strip()


def _is_oauth_token(tok: str) -> bool:
    try:
        from agent.anthropic_credentials import _is_oauth_token as f
        return bool(f(tok))
    except Exception:
        return tok.startswith("sk-ant-oat")


def _headers(tok: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {tok}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
    }


def _http_get(url: str, tok: str) -> tuple[int, Any]:
    import httpx
    with httpx.Client(timeout=15.0) as c:
        r = c.get(url, headers=_headers(tok))
    try:
        body = r.json()
    except Exception:
        body = None
    return r.status_code, body


def _entry_status(entry: Any, now: float) -> dict[str, Any]:
    from agent.credential_pool import STATUS_DEAD, STATUS_EXHAUSTED, _exhausted_until
    st = getattr(entry, "last_status", None) or "ok"
    until = None
    if st == STATUS_EXHAUSTED:
        until = _exhausted_until(entry)
        if until is not None and until <= now:
            st, until = "ok", None
    elif st == STATUS_DEAD:
        st = "dead"
    cooldowns = {}
    for model, ts in (getattr(entry, "model_cooldowns", None) or {}).items():
        t = _parse_ts(ts)
        if t and t > now:
            cooldowns[model] = t
    return {
        "status": "benched" if st == STATUS_EXHAUSTED else st,
        "benched_until": until,
        "bench_reason": getattr(entry, "last_error_reason", None) if st == STATUS_EXHAUSTED else None,
        "bench_message": getattr(entry, "last_error_message", None) if st == STATUS_EXHAUSTED else None,
        "bench_code": getattr(entry, "last_error_code", None) if st == STATUS_EXHAUSTED else None,
        "by_us": st == STATUS_EXHAUSTED and getattr(entry, "last_error_reason", None) in OUR_REASONS,
        "bench_kind": (None if st != STATUS_EXHAUSTED else
                       "auto" if getattr(entry, "last_error_reason", None) == BENCH_REASON else
                       "manual" if getattr(entry, "last_error_reason", None) == MANUAL_REASON else "hermes"),
        "model_cooldowns": cooldowns,
    }


# ─── fetching ─────────────────────────────────────────────────────────────────────────────────

def _parse_usage(payload: dict) -> dict[str, Any]:
    windows: dict[str, Any] = {}
    for key, win in (payload or {}).items():
        if not isinstance(win, dict) or "utilization" not in win:
            continue
        used = win.get("utilization")
        if not _num(used):
            continue
        windows[key] = {
            "key": key,
            "label": WINDOW_LABELS.get(key, key.replace("_", " ").title()),
            "pct": max(0.0, float(used)),
            "resets_at": _parse_ts(win.get("resets_at")),
            "scope": "account" if key in ACCOUNT_WINDOWS else "model",
        }
    extra = payload.get("extra_usage") if isinstance(payload, dict) else None
    extra_out = None
    if isinstance(extra, dict) and extra.get("is_enabled"):
        extra_out = {
            "used": extra.get("used_credits"), "limit": extra.get("monthly_limit"),
            "currency": extra.get("currency") or "USD",
        }
    return {"windows": windows, "extra": extra_out}


_PLAN_NAMES = {
    "claude_max": "Max", "claude_pro": "Pro", "claude_team": "Team",
    "claude_enterprise": "Enterprise", "claude_free": "Free",
}


def _parse_profile(payload: dict) -> dict[str, Any]:
    acc = (payload or {}).get("account") or {}
    org = (payload or {}).get("organization") or {}
    otype = str(org.get("organization_type") or "")
    tier = str(org.get("rate_limit_tier") or "")
    plan = _PLAN_NAMES.get(otype) or (otype.replace("claude_", "").title() if otype else None)
    if acc.get("has_claude_max") and plan in (None, "Pro"):
        plan = "Max"
    if "20x" in tier:
        plan = f"{plan or 'Max'} 20x"
    elif "5x" in tier:
        plan = f"{plan or 'Max'} 5x"
    return {
        "account_uuid": acc.get("uuid"),
        "email": acc.get("email") or acc.get("email_address"),
        "name": acc.get("display_name") or acc.get("full_name"),
        "org": org.get("name"),
        "plan": plan,
        "subscription": org.get("subscription_status"),
    }


def _refresh_entry(entry: Any, *, force: bool, poll_s: int) -> None:
    eid = entry.id
    tok = _token(entry)
    now = time.time()
    if not tok or not _is_oauth_token(tok):
        return
    # A pool entry can change hands: the `claude_code` entry follows whichever account Claude Code is
    # signed into. A new token means the cached name AND usage may belong to someone else — drop both.
    fp = __import__("hashlib").sha256(tok.encode()).hexdigest()[:16]
    if _token_fp.get(eid) not in (None, fp):
        _usage_cache.pop(eid, None)
        _profile_cache.pop(eid, None)
    _token_fp[eid] = fp
    cached = _usage_cache.get(eid) or {}
    fresh = cached.get("at") and now - cached["at"] < max(30, poll_s - 5)
    # two logins of one account share one reading: don't ask the API twice for the same numbers
    uuid_ = ((_profile_cache.get(eid) or {}).get("data") or {}).get("account_uuid")
    twin = next((u for k, u in _usage_cache.items() if k != eid and uuid_ and u.get("at") and now - u["at"] < 30 and not u.get("error")
                 and ((_profile_cache.get(k) or {}).get("data") or {}).get("account_uuid") == uuid_), None)
    limited = "rate-limited" in str(cached.get("error") or "") and now - float(cached.get("error_at") or 0) < 300
    if fresh and not force:
        pass
    elif twin is not None:
        _usage_cache[eid] = {"at": twin["at"], "data": twin["data"], "error": None}
    elif limited and not force:
        pass  # the API asked us to slow down: wait five minutes before trying this login again
    else:
        exp = _parse_ts(getattr(entry, "expires_at_ms", None))
        if exp and exp <= now:
            _usage_cache[eid] = {**cached, "error": "Token expired — refreshes on next use", "error_at": now}
        else:
            try:
                code, body = _http_get(USAGE_URL, tok)
                if code == 200 and isinstance(body, dict):
                    _usage_cache[eid] = {"at": now, "data": _parse_usage(body), "error": None}
                else:
                    msg = {401: "Token expired or revoked", 403: "Usage API refused this token",
                           429: "Usage API rate-limited — showing last reading"}.get(code, f"Usage API HTTP {code}")
                    _usage_cache[eid] = {**cached, "error": msg, "error_at": now}
            except Exception as exc:
                _usage_cache[eid] = {**cached, "error": f"Network error: {type(exc).__name__}", "error_at": now}
    pc = _profile_cache.get(eid) or {}
    if force or not pc.get("at") or now - pc["at"] > PROFILE_TTL_S:
        try:
            code, body = _http_get(PROFILE_URL, tok)
            if code == 200 and isinstance(body, dict):
                _profile_cache[eid] = {"at": now, "data": _parse_profile(body)}
            elif pc:
                _profile_cache[eid] = {**pc, "at": now - PROFILE_TTL_S + 300}
        except Exception:
            pass


def _shared_reading(account_uuid: Optional[str]) -> Optional[dict[str, Any]]:
    """The newest usage reading for this account taken by Claude Code / VS Code (same account, same limit)."""
    if not account_uuid:
        return None
    try:
        hit = json.loads((Path.home() / ".claude-accounts" / "usage.json").read_text("utf-8")).get(account_uuid)
    except Exception:
        return None
    if isinstance(hit, dict) and hit.get("at") and isinstance(hit.get("data"), dict) and hit["data"].get("windows"):
        return {"at": float(hit["at"]), "data": hit["data"]}
    return None


def _backfill(entries: list[Any]) -> None:
    """Never go blind: when our own read is missing or older, use the reading the other surface took."""
    for e in entries:
        uuid_ = ((_profile_cache.get(e.id) or {}).get("data") or {}).get("account_uuid")
        shared = _shared_reading(uuid_)
        cur = _usage_cache.get(e.id) or {}
        if shared and shared["at"] > float(cur.get("at") or 0) and time.time() - shared["at"] < 1800:
            _usage_cache[e.id] = {"at": shared["at"], "data": shared["data"], "error": None, "shared": True}


def _save_caches() -> None:
    with contextlib.suppress(Exception):
        _write_json("cache.json", {"usage": _usage_cache, "profile": _profile_cache, "fp": _token_fp})


def _load_caches() -> None:
    """A plugin reload starts with empty memory; pick the last readings back up from disk."""
    if _usage_cache or _profile_cache:
        return
    c = _read_json("cache.json", {})
    if isinstance(c, dict):
        _usage_cache.update(c.get("usage") or {})
        _profile_cache.update(c.get("profile") or {})
        _token_fp.update(c.get("fp") or {})


# ─── live sessions (gateway process only) ─────────────────────────────────────────────────────

def _server():
    return sys.modules.get("tui_gateway.server")


def _runner():
    mod = sys.modules.get("gateway.run_api")
    return getattr(mod, "_ACTIVE_RUNNER", None) if mod else None


_title_cache: dict[str, tuple[float, str]] = {}


def _title(session_id: str) -> str:
    """Session title straight from state.db (read-only, cached 60 s)."""
    if not session_id:
        return ""
    hit = _title_cache.get(session_id)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    title = ""
    with contextlib.suppress(Exception):
        import sqlite3
        db = _home() / "state.db"
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        try:
            row = con.execute("SELECT title FROM sessions WHERE id = ?", (session_id,)).fetchone()
            title = (row[0] or "") if row else ""
        finally:
            con.close()
    _title_cache[session_id] = (time.time(), title)
    return title


def _iter_agents():
    """Yield ``(sid, info, agent)`` for every live agent in this process.

    Two homes: the TUI/desktop session registry (``tui_gateway.server._sessions``) and the
    gateway runner's agent cache (desktop chats served through the local gateway, messaging
    platforms). ``info`` carries ``running``, ``title``, ``stored_id``, ``last_active``.
    """
    seen: set[int] = set()
    srv = _server()
    if srv is not None:
        for sid, sess in list((getattr(srv, "_sessions", None) or {}).items()):
            if not isinstance(sess, dict) or sess.get("agent") is None:
                continue
            agent = sess["agent"]
            seen.add(id(agent))
            title = ""
            with contextlib.suppress(Exception):
                title = srv._session_live_title(sess, sess.get("session_key")) or ""
            yield sid, {
                "stored_id": sess.get("session_key") or getattr(agent, "session_id", None),
                "running": bool(sess.get("running")), "last_active": sess.get("last_active"),
                "title": title or _title(sess.get("session_key") or ""),
            }, agent
    runner = _runner()
    if runner is not None:
        cache = dict(getattr(runner, "_agent_cache", None) or {})
        running = getattr(runner, "_running_agents", None) or {}
        for key, val in cache.items():
            agent = val[0] if isinstance(val, tuple) and val else val
            if agent is None or not hasattr(agent, "_swap_credential") or id(agent) in seen:
                continue
            seen.add(id(agent))
            sid = getattr(agent, "session_id", None) or str(key)
            is_running = False
            with contextlib.suppress(Exception):
                is_running = key in running
            yield sid, {
                "stored_id": sid, "session_key": str(key), "running": is_running,
                "last_active": getattr(agent, "_last_activity_ts", None) or getattr(agent, "_last_activity", None),
                "title": _title(sid), "platform": getattr(agent, "platform", None),
            }, agent


def _diag() -> dict[str, Any]:
    out = {"registry": _server() is not None, "runner": _runner() is not None, "agents": []}
    with contextlib.suppress(Exception):
        for sid, info, agent in _iter_agents():
            out["agents"].append({"sid": str(sid)[:24], "running": info["running"],
                                  "provider": getattr(agent, "provider", None),
                                  "entry": getattr(agent, "_credential_pool_entry_id", None)})
    return out


def live_sessions() -> list[dict[str, Any]]:
    out = []
    for sid, info, agent in _iter_agents():
        provider = str(getattr(agent, "provider", "") or "").lower()
        row: dict[str, Any] = {
            "sid": sid,
            "stored_id": info.get("stored_id"),
            "title": info.get("title") or "",
            "model": getattr(agent, "model", "") or "",
            "provider": provider,
            "platform": info.get("platform") or getattr(agent, "platform", None),
            "running": bool(info.get("running")),
            "account_id": getattr(agent, "_credential_pool_entry_id", None) if provider == PROVIDER else None,
            "last_active": info.get("last_active") if _num(info.get("last_active")) else None,
        }
        with contextlib.suppress(Exception):
            comp = getattr(agent, "context_compressor", None)
            if comp is not None:
                from agent.context_breakdown import context_usage_fields
                ctx = context_usage_fields(comp) or {}
                row.update({k: ctx.get(k) for k in ("context_used", "context_max", "context_percent")})
                row["compressions"] = getattr(comp, "compression_count", 0) or 0
        g = lambda *names: next((getattr(agent, n, 0) for n in names if getattr(agent, n, 0)), 0)  # noqa: E731
        row["tokens_total"] = g("session_total_tokens")
        row["tokens_in"] = g("session_input_tokens", "session_prompt_tokens")
        row["tokens_out"] = g("session_output_tokens", "session_completion_tokens")
        row["calls"] = g("session_api_calls")
        out.append(row)
    out.sort(key=lambda r: (not r["running"], -(r.get("last_active") or 0)))
    return out


def _swap_agent(agent: Any, entry: Any) -> bool:
    try:
        return agent._swap_credential(entry) is not False
    except Exception:
        log.warning("claude-accounts: credential swap failed", exc_info=True)
        return False


@_scoped
def migrate_live_sessions() -> int:
    """Move idle anthropic sessions off benched accounts (and onto a manual target). No network."""
    if _server() is None and _runner() is None:
        return 0
    settings = load_settings()
    now = time.time()
    try:
        disk = _load_pool()
        entries = {e.id: e for e in disk.entries()}
    except Exception:
        return 0
    benched = {eid: e for eid, e in entries.items() if _entry_status(e, now)["status"] in ("benched", "dead")}
    target = _force_target.get("id") if (_force_target.get("until") or 0) > now else None
    moved = 0
    pending_target = False
    for sid, info, agent in list(_iter_agents()):
        if str(getattr(agent, "provider", "") or "").lower() != PROVIDER:
            continue
        cur = getattr(agent, "_credential_pool_entry_id", None)
        if info.get("running"):
            if target and cur != target:
                pending_target = True
            continue
        apool = getattr(agent, "_credential_pool", None)
        if apool is None or not cur:
            continue
        model = getattr(agent, "model", None)
        try:
            if target and cur != target and target in entries:
                entry = apool.reclaim(target, model=model)
                if entry is None:
                    with contextlib.suppress(Exception):
                        apool.reset_status(target)
                    entry = apool.reclaim(target, model=model)
                if entry is not None and _swap_agent(agent, entry):
                    moved += 1
                    _event("session_moved", f"“{info.get('title') or 'Chat'}” moved to {_display_name(entry)}",
                           sid=sid, from_id=cur, to_id=entry.id)
                else:
                    pending_target = True
            elif cur in benched and settings.get("move_live_sessions", True):
                b = benched[cur]
                nxt = apool.mark_exhausted_and_rotate(
                    status_code=getattr(b, "last_error_code", None) or 429,
                    error_context={
                        "reason": getattr(b, "last_error_reason", None) or BENCH_REASON,
                        "message": getattr(b, "last_error_message", None) or "benched",
                        "reset_at": getattr(b, "last_error_reset_at", None),
                    },
                    credential_id=cur,
                )
                if nxt is not None and nxt.id != cur and _swap_agent(agent, nxt):
                    moved += 1
                    _event("session_moved",
                           f"“{info.get('title') or 'Chat'}” moved {_display_name(b)} → {_display_name(nxt)}",
                           sid=sid, from_id=cur, to_id=nxt.id)
        except Exception:
            log.warning("claude-accounts: live migration failed for %s", sid, exc_info=True)
    if target and not pending_target:
        _force_target.clear()
    if moved:
        _broadcast("updated", {"reason": "sessions_moved"})
    return moved


# ─── display ──────────────────────────────────────────────────────────────────────────────────

def _display_name(entry: Any) -> str:
    prof = (_profile_cache.get(getattr(entry, "id", "")) or {}).get("data") or {}
    return prof.get("email") or prof.get("name") or getattr(entry, "label", None) or getattr(entry, "id", "?")


def _peak(usage: Optional[dict], keys) -> tuple[Optional[float], Optional[str]]:
    best, best_key = None, None
    for k in keys:
        w = ((usage or {}).get("windows") or {}).get(k)
        if w and (best is None or w["pct"] > best):
            best, best_key = w["pct"], k
    return best, best_key


# ─── threshold policy ─────────────────────────────────────────────────────────────────────────

def _apply_threshold(settings: dict[str, Any]) -> list[dict[str, Any]]:
    thr = float(settings["threshold"])
    keys = settings["windows"]
    now = time.time()
    pool = _load_pool()
    entries = pool.entries()
    overrides = _overrides()
    available, hot = [], {}
    for e in entries:
        st = _entry_status(e, now)
        if st["status"] != "ok":
            continue
        available.append(e)
        usage = (_usage_cache.get(e.id) or {}).get("data")
        hot_wins = [w for k, w in ((usage or {}).get("windows") or {}).items() if k in keys and w["pct"] >= thr]
        if hot_wins and e.id not in overrides:
            hot[e.id] = hot_wins
    actions = []
    healthy = [e for e in available if e.id not in hot]
    if hot and not healthy:
        # Accounts parked by a manual switch are the reserve: bring back any that are below threshold.
        for e in entries:
            st = _entry_status(e, now)
            if st["bench_kind"] != "manual":
                continue
            usage = (_usage_cache.get(e.id) or {}).get("data")
            peak, _k = _peak(usage, keys)
            if peak is None or peak < thr:
                released = pool.reset_status(e.id)
                if released is not None:
                    healthy.append(released)
                    _event("released", f"Brought {_display_name(released)} back from standby "
                                       f"({'no reading' if peak is None else f'{peak:.0f}%'})", to_id=e.id)
    if hot and not healthy:
        key = ",".join(sorted(hot))
        if _all_hot_notice.get("key") != key:
            _all_hot_notice["key"] = key
            _event("all_hot", f"Every account is at ≥{thr:.0f}% — staying put; Hermes will rotate on a hard limit.")
        return actions
    _all_hot_notice["key"] = None
    for e in [x for x in available if x.id in hot]:
        wins = hot[e.id]
        reset = max((w["resets_at"] for w in wins if w.get("resets_at")), default=None) or now + 3600
        top = max(wins, key=lambda w: w["pct"])
        msg = f"{top['label']} at {top['pct']:.0f}% (threshold {thr:.0f}%)"
        nxt = pool.mark_exhausted_and_rotate(
            status_code=429,
            error_context={"reason": BENCH_REASON, "message": msg, "reset_at": _iso(reset)},
            credential_id=e.id,
        )
        ev = _event(
            "auto_switch",
            f"{_display_name(e)} hit {top['pct']:.0f}% on {top['label']} → "
            f"{_display_name(nxt) if nxt else 'no other account'}",
            from_id=e.id, to_id=getattr(nxt, "id", None), resets_at=reset, window=top["key"], pct=top["pct"],
        )
        actions.append(ev)
    return actions


@_scoped
def check(*, force: bool = False, reason: str = "poll") -> dict[str, Any]:
    """Fetch usage for every account, apply the threshold policy, migrate idle sessions."""
    if not _check_lock.acquire(timeout=30):
        return {"ok": False, "error": "busy"}
    started = time.time()
    try:
        settings = load_settings()
        pool = _load_pool()
        _load_caches()
        for e in pool.entries():
            with contextlib.suppress(Exception):
                _refresh_entry(e, force=force, poll_s=settings["poll_seconds"])
        with contextlib.suppress(Exception):
            _backfill(pool.entries())
        _save_caches()
        blind = [e for e in pool.entries() if _is_oauth_token(_token(e)) and not (_usage_cache.get(e.id) or {}).get("data")]
        if blind and settings["auto_switch"] and time.time() - _blind_notice.get("at", 0) > 1800:
            _blind_notice["at"] = time.time()
            _event("error", f"No usage reading for {', '.join(_display_name(e) for e in blind)} — auto-switch can't judge it until one arrives.")
        actions = []
        if settings["auto_switch"]:
            try:
                actions = _apply_threshold(settings)
            except Exception:
                log.warning("claude-accounts: threshold policy failed", exc_info=True)
        moved = migrate_live_sessions()
        _last_check.update(at=time.time(), reason=reason, duration_ms=int((time.time() - started) * 1000))
        with contextlib.suppress(Exception):
            _write_json("status.json", {
                **_last_check, "pid": __import__("os").getpid(), "gateway": _server() is not None,
                "accounts": {e.id: {"usage_at": (_usage_cache.get(e.id) or {}).get("at"),
                                    "error": (_usage_cache.get(e.id) or {}).get("error"),
                                    # which real account this login belongs to, hashed: equal values = same account
                                    "identity": __import__("hashlib").sha256(str(((_profile_cache.get(e.id) or {}).get("data") or {}).get("account_uuid") or e.id).encode()).hexdigest()[:8],
                                    "source": e.source} for e in pool.entries()},
                "live_sessions": len(list(_iter_agents())), "switched": len(actions), "moved": moved,
                "diag": _diag(),
            })
        _broadcast("updated", {"reason": reason, "switched": len(actions), "moved": moved})
        return {"ok": True, "switched": actions, "moved": moved}
    finally:
        _check_lock.release()


# ─── snapshot for the UI ──────────────────────────────────────────────────────────────────────

@_scoped
def snapshot() -> dict[str, Any]:
    settings = load_settings()
    now = time.time()
    pool = _load_pool()
    entries = pool.entries()
    active_id = None
    with contextlib.suppress(Exception):
        active_id = getattr(pool.peek(), "id", None)
    sessions = live_sessions()
    per_acct: dict[str, int] = {}
    for s in sessions:
        if s.get("account_id"):
            per_acct[s["account_id"]] = per_acct.get(s["account_id"], 0) + 1
    overrides = _overrides()
    accounts = []
    for e in entries:
        tok = _token(e)
        uc = _usage_cache.get(e.id) or {}
        prof = (_profile_cache.get(e.id) or {}).get("data") or {}
        usage = uc.get("data")
        peak, peak_key = _peak(usage, settings["windows"])
        st = _entry_status(e, now)
        accounts.append({
            "id": e.id,
            "label": e.label,
            "source": e.source,
            "priority": e.priority,
            "auth_type": e.auth_type,
            "oauth": bool(tok) and _is_oauth_token(tok),
            "has_token": bool(tok),
            "request_count": getattr(e, "request_count", 0) or 0,
            "active": e.id == active_id,
            "profile": prof,
            "usage": usage,
            "usage_at": uc.get("at"),
            "usage_error": uc.get("error"),
            "peak_pct": peak,
            "peak_window": peak_key,
            "live_sessions": per_acct.get(e.id, 0),
            "override_until": overrides.get(e.id),
            **st,
        })
    # two logins of one account share one quota: say so instead of showing them as separate accounts
    by_uuid: dict[str, list[dict[str, Any]]] = {}
    for a in accounts:
        key = (a["profile"] or {}).get("account_uuid")
        if key:
            by_uuid.setdefault(f"{key}|{(a['profile'] or {}).get('org') or ''}", []).append(a)
    for group in by_uuid.values():
        if len(group) > 1:
            main = next((a for a in group if a["active"]), None) or next((a for a in group if a["source"] != "claude_code"), group[0])
            for a in group:
                if a is not main:
                    a["same_as"] = main["id"]
    for a in accounts:
        a["follows_claude_code"] = a["source"] == "claude_code"
    poll = settings["poll_seconds"]
    return {
        "ok": True,
        "now": now,
        "provider": PROVIDER,
        "strategy": _strategy(),
        "settings": settings,
        "active_id": active_id,
        "pending_target_id": _force_target.get("id") if (_force_target.get("until") or 0) > now else None,
        "accounts": accounts,
        "sessions": sessions,
        "gateway_attached": _server() is not None,
        "watchdog": bool(_watchdog["thread"] and _watchdog["thread"].is_alive()),
        "last_check_at": _last_check.get("at"),
        "next_check_at": (_last_check.get("at") or now) + poll if _last_check.get("at") else None,
        "events": sorted(events(25) + _provider_events(25), key=lambda e: -float(e.get("at") or 0))[:30],
        "window_labels": WINDOW_LABELS,
        "providers": {k: v for k, v in providers_snapshot().items() if isinstance(v, dict)},
        "routing": _safe(routing_snapshot, {}),
    }


# ─── actions ──────────────────────────────────────────────────────────────────────────────────

def _split_provider(value: str) -> tuple[Optional[str], str]:
    head, sep, rest = (value or "").partition("::")
    return (head, rest) if sep and head in ("antigravity", "copilot") else (None, value)


@_scoped
def switch_to(entry_id: str) -> dict[str, Any]:
    prov, entry_id = _split_provider(entry_id)
    if prov:
        return provider_use(prov, entry_id)
    pool = _load_pool()
    idx, entry, err = pool.resolve_target(entry_id)
    if entry is None:
        return {"ok": False, "error": err or "No such account"}
    now = time.time()
    # Undo earlier manual parking, then put the target first.
    for e in pool.entries():
        if _entry_status(e, now)["bench_kind"] == "manual" or e.id == entry.id:
            with contextlib.suppress(Exception):
                pool.reset_status(e.id)
    with contextlib.suppress(Exception):
        pool.move_entry(entry.id, 0)
    # Hermes keeps manually-added logins ahead of auto-discovered ones (e.g. Claude Code's), so the
    # priority move may not stick. Park whatever still sorts ahead of the target until the user
    # switches again (auto-switch releases them if the target runs hot).
    pool = _load_pool()
    parked = []
    for e in sorted(pool.entries(), key=lambda x: x.priority):
        if e.id == entry.id:
            break
        if _entry_status(e, now)["status"] != "ok":
            continue
        pool.mark_exhausted_and_rotate(
            status_code=429, credential_id=e.id,
            error_context={"reason": MANUAL_REASON, "message": f"Standing by — you switched to {_display_name(entry)}",
                           "reset_at": _iso(now + 30 * 86400)},
        )
        parked.append(_display_name(e))
    settings = load_settings()
    usage = (_usage_cache.get(entry.id) or {}).get("data")
    peak, key = _peak(usage, settings["windows"])
    warning = None
    if peak is not None and peak >= settings["threshold"]:
        resets = (((usage or {}).get("windows") or {}).get(key) or {}).get("resets_at")
        _set_override(entry.id, resets or now + 3600)
        warning = (f"This account is already at {peak:.0f}%. Auto-switch will leave it alone until "
                   f"that window resets.")
    _force_target.update(id=entry.id, until=now + FORCE_TARGET_TTL_S)
    _event("manual_switch", f"Switched to {_display_name(entry)}" + (f" (standing by: {', '.join(parked)})" if parked else ""),
           to_id=entry.id)
    moved = migrate_live_sessions()
    strat = _strategy()
    note = None if strat == "fill_first" else (
        f"Pool strategy is '{strat}', so Hermes may still rotate between accounts. "
        "Set it to fill_first (hermes auth → strategy) for a stable active account.")
    with contextlib.suppress(Exception):
        active = _load_pool().peek()
        if active is not None and active.id != entry.id:
            note = (note or "") + f" Hermes still prefers {_display_name(active)} for new chats."
    _broadcast("updated", {"reason": "manual_switch"})
    return {"ok": True, "moved": moved, "warning": warning, "note": note, "parked": parked}


@_scoped
def clear_bench(entry_id: str) -> dict[str, Any]:
    pool = _load_pool()
    res = pool.reset_status(entry_id)
    if res is None:
        return {"ok": False, "error": "No such account"}
    _set_override(entry_id, None)
    _event("cleared", f"Cleared bench on {_display_name(res)}", to_id=entry_id)
    _broadcast("updated", {"reason": "cleared"})
    return {"ok": True}


@_scoped
def remove_account(entry_id: str) -> dict[str, Any]:
    prov, entry_id = _split_provider(entry_id)
    if prov:
        return provider_remove(prov, entry_id)
    from types import SimpleNamespace
    from hermes_cli.auth_commands import auth_remove_command
    name = entry_id
    with contextlib.suppress(Exception):
        _i, e, _err = _load_pool().resolve_target(entry_id)
        if e is not None:
            name = _display_name(e)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            auth_remove_command(SimpleNamespace(provider=PROVIDER, target=entry_id, index=None))
    except SystemExit as exc:
        return {"ok": False, "error": str(exc) or buf.getvalue().strip()}
    _usage_cache.pop(entry_id, None)
    _profile_cache.pop(entry_id, None)
    _set_override(entry_id, None)
    _event("removed", f"Removed {name}")
    _broadcast("updated", {"reason": "removed"})
    return {"ok": True, "output": buf.getvalue().strip()}


def login_start(label: str = "") -> dict[str, Any]:
    prov, rest = _split_provider(label)
    if prov:
        return provider_login_start(prov, rest)
    from urllib.parse import urlencode
    from agent import anthropic_credentials as ac
    verifier, challenge = ac._generate_pkce()
    state = secrets.token_urlsafe(32)
    params = {
        "code": "true", "client_id": ac._OAUTH_CLIENT_ID, "response_type": "code",
        "redirect_uri": ac._OAUTH_REDIRECT_URI, "scope": ac._OAUTH_SCOPES,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
    }
    now = time.time()
    with _state_lock:
        for k in [k for k, v in _pending_logins.items() if now - v["created"] > 1800]:
            _pending_logins.pop(k, None)
        _pending_logins[state] = {"verifier": verifier, "created": now, "label": (label or "").strip()}
    return {"ok": True, "url": f"https://claude.ai/oauth/authorize?{urlencode(params)}", "login_id": state}


@_scoped
def login_finish(login_id: str, code_input: str, label: str = "") -> dict[str, Any]:
    if code_input == "::status":
        return provider_login_status(login_id)
    if code_input == "::cancel":
        return provider_login_cancel(login_id)
    from agent import anthropic_credentials as ac
    from agent.credential_pool import AUTH_TYPE_OAUTH, PooledCredential, label_from_token
    with _state_lock:
        pending = _pending_logins.get(login_id)
    if not pending:
        return {"ok": False, "error": "Login expired — start again."}
    raw = (code_input or "").strip()
    if not raw:
        return {"ok": False, "error": "Paste the code shown after you authorize."}
    code, _, received_state = raw.partition("#")
    if received_state and received_state != login_id:
        return {"ok": False, "error": "That code belongs to a different login attempt. Start again."}
    try:
        body = json.dumps({
            "grant_type": "authorization_code", "client_id": ac._OAUTH_CLIENT_ID, "code": code.strip(),
            "state": login_id, "redirect_uri": ac._OAUTH_REDIRECT_URI, "code_verifier": pending["verifier"],
        }).encode()
        result = ac._post_oauth_token(body, content_type="application/json", timeout=20, what="exchange")
    except Exception as exc:
        return {"ok": False, "error": f"Token exchange failed: {exc}"}
    creds = ac._oauth_token_state(result or {})
    if not creds.get("access_token"):
        return {"ok": False, "error": "Anthropic returned no access token."}
    with _state_lock:
        _pending_logins.pop(login_id, None)
    profile = None
    with contextlib.suppress(Exception):
        code_, pbody = _http_get(PROFILE_URL, creds["access_token"])
        if code_ == 200 and isinstance(pbody, dict):
            profile = _parse_profile(pbody)
    pool = _load_pool()
    duplicate = None
    if profile and profile.get("account_uuid"):
        for e in pool.entries():
            p = (_profile_cache.get(e.id) or {}).get("data") or {}
            if p.get("account_uuid") == profile["account_uuid"]:
                duplicate = _display_name(e)
    nice = (label or pending.get("label") or (profile or {}).get("email") or (profile or {}).get("name") or "").strip()
    entry = PooledCredential(
        provider=PROVIDER, id=uuid.uuid4().hex[:6],
        label=nice or label_from_token(creds["access_token"], f"{PROVIDER}-oauth-{len(pool.entries()) + 1}"),
        auth_type=AUTH_TYPE_OAUTH, priority=0, source="manual:hermes_pkce",
        access_token=creds["access_token"], refresh_token=creds.get("refresh_token"),
        expires_at_ms=creds.get("expires_at_ms"), base_url="https://api.anthropic.com",
    )
    entry = pool.add_entry(entry)
    if profile:
        _profile_cache[entry.id] = {"at": time.time(), "data": profile}
    _event("added", f"Connected {_display_name(entry)}", to_id=entry.id)
    threading.Thread(target=lambda: check(force=True, reason="added"), daemon=True).start()
    return {"ok": True, "id": entry.id, "label": entry.label,
            "warning": f"This is the same Claude account as {duplicate} — it adds no extra quota." if duplicate else None}


# ─── Antigravity + GitHub Copilot (shared engine in ~/.claude-accounts, same as the VS Code extension) ──

_ENGINE_PATH = Path(__file__).resolve().parent / "engine" / "providers.py"
_engine_mod: dict[str, Any] = {}


def _engine():
    """providers.py from ./engine, reloaded when it changes on disk. None when missing/broken."""
    try:
        mtime = _ENGINE_PATH.stat().st_mtime
    except OSError:
        return None
    if _engine_mod.get("mtime") == mtime and _engine_mod.get("mod") is not None:
        return _engine_mod["mod"]
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("claude_accounts_providers", _ENGINE_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _engine_mod.update(mod=mod, mtime=mtime)
        return mod
    except Exception:
        log.warning("claude-accounts: provider engine failed to load", exc_info=True)
        return None


def _engine_settings_path() -> Path:
    import os
    return Path(os.environ.get("CLAUDE_ACCOUNTS_HOME", str(Path.home() / ".claude-accounts"))) / "settings.json"


def _mirror_engine_settings(s: dict[str, Any]) -> None:
    """One threshold everywhere: Hermes' auto-switch settings also drive Claude Code / VS Code / providers."""
    with contextlib.suppress(Exception):
        p = _engine_settings_path()
        cur = json.loads(p.read_text()) if p.exists() else {}
        cur.update({k: s[k] for k in ("auto_switch", "threshold", "poll_seconds", "provider_auto") if k in s})
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cur, indent=2))
        tmp.replace(p)


def _provider_settings() -> dict[str, Any]:
    s = load_settings()
    return {"auto_switch": s["auto_switch"], "threshold": s["threshold"], "poll_seconds": s["poll_seconds"],
            "provider_auto": s.get("provider_auto") or {}}


def providers_snapshot(*, force: bool = False) -> dict[str, Any]:
    P = _engine()
    if P is None:
        return {}
    try:
        return P.snapshot(_provider_settings(), force=force)
    except Exception as e:
        log.warning("claude-accounts: provider snapshot failed", exc_info=True)
        return {"_error": f"{type(e).__name__}: {e}"}


def providers_check(*, force: bool = False) -> list[dict[str, Any]]:
    P = _engine()
    if P is None:
        return []
    settings = _provider_settings()
    snap = P.snapshot(settings, force=force)
    actions = P.check(settings, snap) if settings["auto_switch"] else []
    for a in actions:
        if a.get("ok") and not a.get("unchanged"):
            name = P.META.get(a.get("provider"), {}).get("name", a.get("provider"))
            _broadcast("event", {"kind": "auto_switch", "provider": a.get("provider"),
                                 "message": f"{name} auto-switched to {a.get('label')}"})
    return actions


def _provider_events(limit: int = 25) -> list[dict[str, Any]]:
    P = _engine()
    if P is None:
        return []
    with contextlib.suppress(Exception):
        raw = P._read("events.json", [])
        return [e for e in (raw if isinstance(raw, list) else []) if e.get("provider") in ("antigravity", "copilot")][-limit:]
    return []


def provider_login_start(provider: str, label: str = "") -> dict[str, Any]:
    P = _engine()
    if P is None or provider not in ("antigravity", "copilot"):
        return {"ok": False, "error": "Provider engine is not installed (engine/providers.py)."}
    return P.login_start(provider, label)


def provider_login_status(login_id: str) -> dict[str, Any]:
    P = _engine()
    return P.login_status(login_id) if P else {"ok": False, "status": "error", "error": "engine missing"}


def provider_login_cancel(login_id: str) -> dict[str, Any]:
    P = _engine()
    return P.login_cancel(login_id) if P else {"ok": True}


def provider_use(provider: str, account_id: str) -> dict[str, Any]:
    P = _engine()
    if P is None or provider not in ("antigravity", "copilot"):
        return {"ok": False, "error": "Unknown provider."}
    res = P.use(provider, account_id, threshold=load_settings()["threshold"])
    _broadcast("updated", {"reason": "provider_use"})
    return res


def provider_remove(provider: str, account_id: str) -> dict[str, Any]:
    P = _engine()
    if P is None or provider not in ("antigravity", "copilot"):
        return {"ok": False, "error": "Unknown provider."}
    return P.remove(provider, account_id)


# ─── model routing per agent (tiers → Hermes subagent routes + Claude Code sub-agents) ─────────

_mods: dict[str, dict[str, Any]] = {}


def _load_by_path(name: str, path: Path):
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    hit = _mods.get(name)
    if hit and hit.get("mtime") == mtime:
        return hit["mod"]
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _mods[name] = {"mod": mod, "mtime": mtime}
        return mod
    except Exception:
        log.warning("claude-accounts: failed to load %s", path, exc_info=True)
        return None


def _routing():
    return _load_by_path("claude_accounts_routing", Path(__file__).resolve().parent / "engine" / "routing.py")


def _ad_store():
    """The official advanced-delegation plugin's config store (it owns delegation.backend[s])."""
    return _load_by_path("claude_accounts_ad_store", _home() / "plugins" / "advanced-delegation" / "store.py")


_HERMES_ROUTE_DESC = {
    "fast": "Small, well-defined tasks: lookups, file or web search, reading and summarizing, simple edits, running a command and reporting.",
    "balanced": "Standard work with a clear plan: multi-step implementation, writing tests, refactors, data processing.",
    "deep": "Hard thinking: architecture and design, ambiguous debugging, reviews, planning large or risky changes.",
}


def _hermes_routes(RT, cfg: dict) -> list[dict[str, Any]]:
    ids = RT._read("models-cache.json", {}).get("ids") or RT.FALLBACK_IDS
    eff = RT.effective_tiers(cfg, "hermes")
    out = []
    for t in RT.TIERS:
        r = {"name": t, "description": _HERMES_ROUTE_DESC[t], "provider": "anthropic", "model": ids.get(eff[t]) or RT.FALLBACK_IDS[eff[t]]}
        if t == "deep":
            r["reasoning_effort"] = "high"
        out.append(r)
    return out


def hermes_routing_apply() -> dict[str, Any]:
    """Write fast/balanced/deep as advanced-delegation model routes (delegation.backend = model_map).
    Never overwrites model routes the user made by hand; turning routing off restores 'default'."""
    RT, store = _routing(), _ad_store()
    if RT is None:
        return {"ok": False, "error": "engine/routing.py missing"}
    if store is None:
        return {"ok": False, "error": "Install the advanced-delegation plugin: hermes plugins install advanced-delegation"}
    cfg = RT.load()
    st = _read_json("routing.json", {})
    section = store.delegation_section()
    mode = store.current_mode(section)
    want = _hermes_routes(RT, cfg)
    norm = lambda rs: [{k: v for k, v in sorted(dict(r).items()) if v not in (None, "")} for r in rs]  # noqa: E731
    try:
        if cfg["enabled"] and cfg["hermes"]:
            theirs = mode == "model_map" and not st.get("owned") and store.routes(section) and norm(store.routes(section)) != norm(want)
            if theirs:
                return {"ok": False, "conflict": True, "error": "You already have your own model routes in Hermes — left them as they are."}
            if norm(store.routes(section)) != norm(want) or store.route_default(section) != "balanced":
                store.save_routes(want, default="balanced")
            if mode != "model_map":
                store.set_mode("model_map")
            st["owned"] = True
        elif st.get("owned"):
            if mode == "model_map":
                store.set_mode("default")
            st["owned"] = False
    except Exception as e:
        return {"ok": False, "error": f"Couldn't update Hermes delegation settings: {e}"}
    _write_json("routing.json", st)
    return {"ok": True, "mode": store.current_mode(store.delegation_section()), "routes": want if st.get("owned") else []}


def hermes_delegations(limit: int = 40, days: int = 14) -> list[dict[str, Any]]:
    """Subagent sessions from state.db: what was delegated, to which model, and how it went."""
    RT = _routing()
    rows: list[dict[str, Any]] = []
    with contextlib.suppress(Exception):
        import sqlite3
        con = sqlite3.connect(f"file:{_home() / 'state.db'}?mode=ro", uri=True, timeout=1.0)
        try:
            q = ("SELECT c.id, c.title, c.model, c.billing_provider, c.started_at, c.ended_at, c.end_reason, c.output_tokens, "
                 "c.parent_session_id, p.title FROM sessions c LEFT JOIN sessions p ON p.id = c.parent_session_id "
                 "WHERE c.parent_session_id IS NOT NULL AND c.started_at > ? ORDER BY c.started_at DESC LIMIT ?")
            for r in con.execute(q, (time.time() - days * 86400, limit)).fetchall():
                title = re.sub(r"^Subagent:\s*", "", r[1] or "") or "Subagent"
                ended = r[5]
                state = "done" if ended and (r[6] or "") in ("", "agent_close", "completed", "complete", "done") else \
                    "error" if ended else ("running" if time.time() - float(r[4] or 0) < 6 * 3600 else "unknown")
                rows.append({"id": r[0], "source": "hermes", "at": r[4], "ended_at": ended, "description": title,
                             "agent": r[3] or "subagent", "model": r[2], "model_label": RT.pretty_model(r[2]) if RT else (r[2] or ""),
                             "tier": RT.tier_of(r[2]) if RT else None, "state": state, "tokens_out": r[7],
                             "session": re.sub(r"^Subagent:\s*", "", r[9] or "") or "chat", "session_id": r[8]})
        finally:
            con.close()
    return rows


def routing_snapshot() -> dict[str, Any]:
    RT = _routing()
    if RT is None:
        return {}
    snap = RT.snapshot(delegations=False, scope="hermes")
    store = _ad_store()
    mode = None
    with contextlib.suppress(Exception):
        mode = store.current_mode(store.delegation_section()) if store else None
    snap["hermes"] = {"plugin": store is not None, "mode": mode, "owned": bool(_read_json("routing.json", {}).get("owned"))}
    snap["delegations"] = hermes_delegations()
    return snap


def routing_save(patch: dict[str, Any]) -> dict[str, Any]:
    RT = _routing()
    if RT is None:
        return {"ok": False, "error": "engine/routing.py missing"}
    RT.save(patch or {})          # also rewrites the Claude Code sub-agents
    res = hermes_routing_apply()
    return {"ok": True, "routing": routing_snapshot(), "hermes": res, "warning": res.get("error") if not res.get("ok") else None}


def _routing_tick(snap_accounts: list[dict[str, Any]], settings: dict[str, Any]) -> None:
    RT = _routing()
    if RT is None:
        return
    thr = settings["threshold"]
    active = next((a for a in snap_accounts if a.get("active")), None)
    others = any(a for a in snap_accounts if not a.get("active") and a.get("status") == "ok"
                 and a.get("peak_pct") is not None and a["peak_pct"] < thr)
    flip = RT.quota_tick(active and active.get("peak_pct"), others, thr, scope="hermes")
    if flip:
        hermes_routing_apply()
        _event("routing", "Save quota: Claude is near its limit — Hermes subagents use one model smaller." if flip == "downgraded"
               else "Save quota: usage recovered — Hermes subagents are back to their models.")


# ─── watchdog ─────────────────────────────────────────────────────────────────────────────────

def _watchdog_loop() -> None:
    stop, wake = _watchdog["stop"], _watchdog["wake"]
    time.sleep(3)
    next_full = 0.0
    failures = 0
    while not stop.is_set():
        now = time.time()
        try:
            if now >= next_full:
                next_full = now + load_settings()["poll_seconds"]
                check(reason="poll")
                try:
                    providers_check()
                except Exception:
                    log.warning("claude-accounts: provider auto-switch failed", exc_info=True)
                try:
                    _routing_tick(snapshot()["accounts"], load_settings())
                except Exception:
                    log.warning("claude-accounts: routing tick failed", exc_info=True)
            else:
                migrate_live_sessions()
            failures = 0
        except Exception:
            failures += 1
            with contextlib.suppress(Exception):
                import traceback
                _write_json("status.json", {**_last_check, "last_error": traceback.format_exc()[-1500:],
                                            "failures": failures, "error_at": time.time()})
            if failures <= 3 or failures % 20 == 0:
                log.warning("claude-accounts watchdog tick failed (%d)", failures, exc_info=True)
        delay = min(FAST_LOOP_S, max(1.0, next_full - time.time()))
        if failures:
            delay = min(300.0, FAST_LOOP_S * (2 ** min(failures, 5)))
        woke = wake.wait(timeout=delay)
        if woke:
            wake.clear()
            next_full = 0.0


def ensure_watchdog() -> None:
    t = _watchdog.get("thread")
    if t is not None and t.is_alive():
        return
    with _state_lock:
        t = _watchdog.get("thread")
        if t is not None and t.is_alive():
            return
        _watchdog["stop"].clear()
        t = threading.Thread(target=_watchdog_loop, name="claude-accounts-watchdog", daemon=True)
        _watchdog["thread"] = t
        t.start()


def poke() -> None:
    _watchdog["wake"].set()


# ─── text summary (slash command) ─────────────────────────────────────────────────────────────

@_scoped
def text_summary(refresh: bool = True) -> str:
    if refresh:
        check(force=False, reason="slash")
    snap = snapshot()
    s = snap["settings"]
    lines = [f"Claude accounts — auto-switch {'ON' if s['auto_switch'] else 'OFF'} at {s['threshold']}% "
             f"(strategy {snap['strategy']})"]
    for a in snap["accounts"]:
        name = (a["profile"] or {}).get("email") or (a["profile"] or {}).get("name") or a["label"]
        plan = (a["profile"] or {}).get("plan")
        tag = "▶ " if a["active"] else "  "
        status = a["status"]
        if a.get("benched_until"):
            status += f" until {datetime.fromtimestamp(a['benched_until']).strftime('%a %H:%M')}"
        lines.append(f"{tag}{name}{f' ({plan})' if plan else ''} — {status}")
        for k, w in ((a.get("usage") or {}).get("windows") or {}).items():
            reset = datetime.fromtimestamp(w["resets_at"]).strftime("%a %H:%M") if w.get("resets_at") else "?"
            lines.append(f"     {w['label']:<16} {w['pct']:5.1f}%   resets {reset}")
        if a.get("usage_error"):
            lines.append(f"     ! {a['usage_error']}")
    return "\n".join(lines)
