#!/usr/bin/env python3
"""claude-accounts — multiple Claude logins for Claude Code (CLI + VS Code), with usage, context and
auto-switch at a usage threshold.

Stdlib only, Python 3.9+. One file, many front-ends:

    claude_accounts.py status [--json] [--auto] [--cwd DIR]   accounts + usage + Claude Code sessions
    claude_accounts.py add [--label NAME]                     connect another Claude login (browser + paste code)
    claude_accounts.py import [--label NAME]                  save the account Claude Code is logged into now
    claude_accounts.py use <account>                          switch Claude Code to that account
    claude_accounts.py remove <account>                       forget a saved account
    claude_accounts.py config [auto_switch=on] [threshold=90] [poll_seconds=180] [windows=five_hour,seven_day]
    claude_accounts.py check                                  one auto-switch pass (for cron/launchd)
    claude_accounts.py watch                                  run auto-switch forever
    claude_accounts.py statusline                             Claude Code statusLine command (reads JSON on stdin)
    claude_accounts.py mcp                                    MCP server over stdio (tools for Claude Code)

Other providers (see providers.py): add --provider antigravity|copilot, use <acct> --provider …,
remove <acct> --provider …, login-status <login_id>, login-cancel <login_id>.

How switching works
-------------------
Claude Code keeps exactly one login (macOS Keychain item "Claude Code-credentials", or
~/.claude/.credentials.json elsewhere). Saved accounts live in ~/.claude-accounts/accounts.json (0600).
`use` first saves Claude Code's current login back into the store (it may have rotated its refresh
token), backs it up, then writes the chosen account's credential into Claude Code's slot. New
Claude Code sessions (terminal and VS Code) start on the new account.

Accounts Hermes knows about (~/.hermes/auth.json) are shown read-only; their refresh tokens belong to
Hermes and are never copied (a shared single-use refresh token would log one side out).
"""
from __future__ import annotations

import base64
import contextlib
import getpass
import glob
import hashlib
import json
import os
import platform
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

VERSION = "1.1.0"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import providers as P  # Antigravity + GitHub Copilot
except Exception:  # pragma: no cover — engine still works for Claude alone
    P = None
try:
    import routing as RT  # model routing per agent (tiers → Claude Code sub-agents)
except Exception:  # pragma: no cover
    RT = None
HOME = Path(os.environ.get("CLAUDE_ACCOUNTS_HOME", str(Path.home() / ".claude-accounts")))
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
KEYCHAIN_SERVICE = os.environ.get("CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE", "Claude Code-credentials")

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
TOKEN_URLS = ["https://platform.claude.com/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"]
REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
# Same scopes Claude Code asks for, so a token we mint works inside Claude Code.
SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
API_UA = "claude-code/2.1.0"
TOKEN_UA = "axios/1.7.9"   # the token endpoint 429s claude-code/* user agents

WINDOW_LABELS = {"five_hour": "Session · 5h", "seven_day": "Weekly · 7d",
                 "seven_day_opus": "Opus · weekly", "seven_day_sonnet": "Sonnet · weekly"}
ACCOUNT_WINDOWS = ("five_hour", "seven_day")
DEFAULT_SETTINGS = {"auto_switch": True, "threshold": 90, "poll_seconds": 180,
                    "windows": list(ACCOUNT_WINDOWS), "show_hermes": False,
                    "provider_auto": {"antigravity": True, "copilot": True}}
PLANS = {"claude_max": "Max", "claude_pro": "Pro", "claude_team": "Team", "claude_enterprise": "Enterprise"}
SUB_TYPES = {"Max": "max", "Pro": "pro", "Team": "team", "Enterprise": "enterprise"}

_lock = threading.RLock()


# ─── tiny utils ───────────────────────────────────────────────────────────────────────────────

def now() -> float:
    return time.time()


def _ensure_home() -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    (HOME / "backups").mkdir(exist_ok=True)
    try:
        os.chmod(HOME, 0o700)
    except OSError:
        pass


def _read(name: str, default: Any) -> Any:
    try:
        return json.loads((HOME / name).read_text("utf-8"))
    except Exception:
        return default


def _write(name: str, data: Any, private: bool = False) -> None:
    _ensure_home()
    path = HOME / name
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if private else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, default=str)
    os.replace(str(tmp), str(path))


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _ts(v: Any) -> Optional[float]:
    if v in (None, ""):
        return None
    if _num(v):
        f = float(v)
        return f / 1000.0 if f > 1e12 else f
    try:
        from datetime import datetime, timezone
        text = str(v).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None


def _fp(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:16] if token else ""


def _http(method: str, url: str, *, token: Optional[str] = None, body: Optional[dict] = None,
          ua: str = API_UA, timeout: float = 15.0) -> Tuple[int, Any]:
    headers = {"Accept": "application/json", "User-Agent": ua}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["anthropic-beta"] = "oauth-2025-04-20"
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode() or "{}"
            return r.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, None
    except Exception as e:
        return 0, {"error": f"{type(e).__name__}: {e}"}


# ─── settings / events ────────────────────────────────────────────────────────────────────────

def load_settings() -> Dict[str, Any]:
    s = dict(DEFAULT_SETTINGS)
    raw = _read("settings.json", {})
    if isinstance(raw, dict):
        s.update({k: v for k, v in raw.items() if k in DEFAULT_SETTINGS})
    s["auto_switch"] = bool(s["auto_switch"])
    s["show_hermes"] = bool(s["show_hermes"])
    try:
        s["threshold"] = max(50, min(99, int(float(s["threshold"]))))
    except (TypeError, ValueError):
        s["threshold"] = 90
    try:
        s["poll_seconds"] = max(60, min(1800, int(s["poll_seconds"])))
    except (TypeError, ValueError):
        s["poll_seconds"] = 180
    s["windows"] = [w for w in (s.get("windows") or []) if w in WINDOW_LABELS] or list(ACCOUNT_WINDOWS)
    pa = s.get("provider_auto") if isinstance(s.get("provider_auto"), dict) else {}
    s["provider_auto"] = {k: bool(pa.get(k, True)) for k in ("antigravity", "copilot")}
    return s


def save_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        s = load_settings()
        for k, v in (patch or {}).items():
            if k.startswith("provider_auto."):          # CLI form: provider_auto.copilot=off
                k, v = "provider_auto", {k.split(".", 1)[1]: str(v).lower() in ("1", "on", "true", "yes")}
            if k not in DEFAULT_SETTINGS:
                continue
            if k == "provider_auto" and isinstance(v, dict):
                v = {**s.get("provider_auto", {}), **{kk: bool(vv) for kk, vv in v.items()}}
            if k in ("auto_switch", "show_hermes") and isinstance(v, str):
                v = v.lower() in ("1", "on", "true", "yes")
            if k == "windows" and isinstance(v, str):
                v = [x.strip() for x in v.split(",") if x.strip()]
            s[k] = v
        _write("settings.json", s)
        return load_settings()


def events(limit: int = 30) -> List[dict]:
    raw = _read("events.json", [])
    return raw[-limit:][::-1] if isinstance(raw, list) else []


def _event(kind: str, message: str, **extra: Any) -> dict:
    ev = {"id": uuid.uuid4().hex[:8], "at": now(), "kind": kind, "message": message, **extra}
    with _lock:
        raw = _read("events.json", [])
        raw = raw if isinstance(raw, list) else []
        raw.append(ev)
        _write("events.json", raw[-80:])
    return ev


# ─── Claude Code's credential slot ────────────────────────────────────────────────────────────

def _is_mac() -> bool:
    return platform.system() == "Darwin"


def _use_keychain() -> bool:
    # CLAUDE_ACCOUNTS_CC_STORE=file forces the plain-file slot (tests, sandboxes).
    return _is_mac() and os.environ.get("CLAUDE_ACCOUNTS_CC_STORE", "").lower() != "file"


def _cc_file() -> Path:
    return CLAUDE_DIR / ".credentials.json"


def cc_read() -> Tuple[Optional[dict], str]:
    """Claude Code's current credential blob and where it came from."""
    if _use_keychain():
        try:
            out = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                                 capture_output=True, text=True, timeout=10)
            if out.returncode == 0 and out.stdout.strip():
                return json.loads(out.stdout.strip()), "keychain"
        except Exception:
            pass
    try:
        return json.loads(_cc_file().read_text("utf-8")), "file"
    except Exception:
        return None, "none"


def cc_write(blob: dict) -> str:
    """Replace Claude Code's login. Keychain on macOS (the file too, if Claude Code keeps one)."""
    payload = json.dumps(blob, separators=(",", ":"))
    where = []
    if _use_keychain():
        if "'" in payload:
            raise RuntimeError("unexpected quote in credential payload")
        # Feed the command on stdin (`security -i`) so the secret never shows up in `ps`.
        cmd = f"add-generic-password -U -a '{getpass.getuser()}' -s '{KEYCHAIN_SERVICE}' -w '{payload}'\n"
        res = subprocess.run(["security", "-i"], input=cmd, capture_output=True, text=True, timeout=15)
        if res.returncode != 0 or "error" in (res.stderr or "").lower():
            raise RuntimeError(f"Keychain write failed: {(res.stderr or res.stdout).strip()[:200]}")
        where.append("keychain")
    if not _use_keychain() or _cc_file().exists():
        f = _cc_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(f) + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(payload)
        os.replace(str(f) + ".tmp", str(f))
        where.append("file")
    return "+".join(where)


def _backup_cc(blob: Optional[dict], reason: str) -> Optional[str]:
    if not blob:
        return None
    _ensure_home()
    name = f"backups/claude-code-{time.strftime('%Y%m%d-%H%M%S')}-{reason}.json"
    _write(name, blob, private=True)
    files = sorted(glob.glob(str(HOME / "backups" / "claude-code-*.json")))
    for old in files[:-20]:
        try:
            os.remove(old)
        except OSError:
            pass
    return str(HOME / name)


def _oauth(blob: Optional[dict]) -> dict:
    return (blob or {}).get("claudeAiOauth") or {}


# ─── account store ────────────────────────────────────────────────────────────────────────────

def load_store() -> Dict[str, Any]:
    raw = _read("accounts.json", {})
    if not isinstance(raw, dict):
        raw = {}
    raw.setdefault("accounts", [])
    return raw


def save_store(store: Dict[str, Any]) -> None:
    _write("accounts.json", store, private=True)


def _find(store: dict, key: str) -> Optional[dict]:
    key = (key or "").strip().lower()
    accts = store["accounts"]
    for a in accts:
        if key in (a["id"].lower(), (a.get("email") or "").lower(), (a.get("label") or "").lower()):
            return a
    if key.isdigit() and 1 <= int(key) <= len(accts):
        return accts[int(key) - 1]
    hits = [a for a in accts if key and (key in (a.get("email") or "").lower() or key in (a.get("label") or "").lower())]
    return hits[0] if len(hits) == 1 else None


def fetch_profile(token: str) -> Optional[dict]:
    code, body = _http("GET", PROFILE_URL, token=token)
    if code != 200 or not isinstance(body, dict):
        return None
    acc, org = body.get("account") or {}, body.get("organization") or {}
    otype, tier = str(org.get("organization_type") or ""), str(org.get("rate_limit_tier") or "")
    plan = PLANS.get(otype) or (otype.replace("claude_", "").title() or None)
    if acc.get("has_claude_max") and plan in (None, "Pro"):
        plan = "Max"
    if "20x" in tier:
        plan = f"{plan or 'Max'} 20x"
    elif "5x" in tier:
        plan = f"{plan or 'Max'} 5x"
    return {"account_uuid": acc.get("uuid"), "email": acc.get("email") or acc.get("email_address"),
            "name": acc.get("display_name") or acc.get("full_name"), "org": org.get("name"),
            "org_uuid": org.get("uuid"), "plan": plan, "rate_limit_tier": tier or None}


def _profile_cached(token: str) -> Optional[dict]:
    cache = _read("profiles.json", {})
    key = _fp(token)
    hit = cache.get(key) if isinstance(cache, dict) else None
    if hit and now() - hit.get("at", 0) < 6 * 3600:
        return hit["data"]
    prof = fetch_profile(token)
    if prof:
        cache = cache if isinstance(cache, dict) else {}
        cache[key] = {"at": now(), "data": prof}
        if len(cache) > 40:
            cache = dict(sorted(cache.items(), key=lambda kv: kv[1].get("at", 0))[-40:])
        _write("profiles.json", cache)
    return prof


def _refresh(oauth: dict) -> Optional[dict]:
    """Exchange a refresh token. Returns an updated claudeAiOauth dict or None."""
    rt = oauth.get("refreshToken")
    if not rt:
        return None
    body = {"grant_type": "refresh_token", "refresh_token": rt, "client_id": CLIENT_ID}
    for url in TOKEN_URLS:
        code, res = _http("POST", url, body=body, ua=TOKEN_UA, timeout=20)
        if code == 200 and isinstance(res, dict) and res.get("access_token"):
            out = dict(oauth)
            out["accessToken"] = res["access_token"]
            out["refreshToken"] = res.get("refresh_token") or rt
            out["expiresAt"] = int((now() + float(res.get("expires_in") or 3600)) * 1000)
            return out
        if code in (400, 401):
            break
    return None


def _ensure_fresh(acct: dict, store: dict) -> Optional[str]:
    """Access token for a STORED (not live) account, refreshing it if needed. We own these tokens."""
    oauth = _oauth(acct.get("credential"))
    tok, exp = oauth.get("accessToken"), _ts(oauth.get("expiresAt"))
    if tok and exp and exp > now() + 120:
        return tok
    new = _refresh(oauth)
    if new is None:
        return tok if tok and (not exp or exp > now()) else None
    acct["credential"]["claudeAiOauth"] = new
    save_store(store)
    return new["accessToken"]


def _identify(token: str) -> Optional[dict]:
    return _profile_cached(token) if token else None


def _upsert_from_blob(store: dict, blob: dict, *, label: str = "", source: str = "import") -> Tuple[dict, bool]:
    oauth = _oauth(blob)
    prof = _identify(oauth.get("accessToken", "")) or {}
    acct = None
    if prof.get("account_uuid"):
        acct = next((a for a in store["accounts"] if a.get("account_uuid") == prof["account_uuid"]), None)
    created = acct is None
    if created:
        acct = {"id": uuid.uuid4().hex[:6], "added_at": now(), "source": source}
        store["accounts"].append(acct)
    acct["credential"] = json.loads(json.dumps(blob))
    acct.update({k: v for k, v in prof.items() if v})
    acct["label"] = label or acct.get("label") or prof.get("email") or prof.get("name") or f"account-{acct['id']}"
    acct["updated_at"] = now()
    return acct, created


def sync_live(store: Optional[dict] = None) -> Tuple[dict, Optional[dict]]:
    """Copy Claude Code's current login into the store (the live account owns the newest tokens)."""
    store = store or load_store()
    blob, _src = cc_read()
    if not blob or not _oauth(blob).get("accessToken"):
        return store, None
    prof = _identify(_oauth(blob)["accessToken"])
    live = None
    if prof and prof.get("account_uuid"):
        live = next((a for a in store["accounts"] if a.get("account_uuid") == prof["account_uuid"]), None)
        if live is not None and _oauth(live.get("credential")).get("refreshToken") != _oauth(blob).get("refreshToken"):
            live["credential"] = json.loads(json.dumps(blob))
            live["updated_at"] = now()
            save_store(store)
    store["live_uuid"] = (prof or {}).get("account_uuid")
    return store, live


# ─── usage ────────────────────────────────────────────────────────────────────────────────────

def parse_usage(payload: dict) -> dict:
    wins = {}
    for k, w in (payload or {}).items():
        if isinstance(w, dict) and _num(w.get("utilization")):
            wins[k] = {"key": k, "label": WINDOW_LABELS.get(k, k.replace("_", " ").title()),
                       "pct": max(0.0, float(w["utilization"])), "resets_at": _ts(w.get("resets_at")),
                       "scope": "account" if k in ACCOUNT_WINDOWS else "model"}
    extra = (payload or {}).get("extra_usage") or {}
    return {"windows": wins,
            "extra": {"used": extra.get("used_credits"), "limit": extra.get("monthly_limit")} if extra.get("is_enabled") else None}


def fetch_usage(token: str, cache_key: str, max_age: float) -> Tuple[Optional[dict], Optional[str], Optional[float]]:
    cache = _read("usage.json", {})
    cache = cache if isinstance(cache, dict) else {}
    hit = cache.get(cache_key)
    if hit and now() - hit.get("at", 0) < max_age:
        return hit.get("data"), hit.get("error"), hit.get("at")
    code, body = _http("GET", USAGE_URL, token=token)
    if code == 200 and isinstance(body, dict):
        entry = {"at": now(), "data": parse_usage(body), "error": None}
    else:
        msg = {401: "Token expired — refreshes on next use", 403: "Usage API refused this token",
               429: "Usage API rate-limited — showing last reading", 0: "Offline — showing last reading"}.get(code, f"Usage API HTTP {code}")
        entry = {"at": (hit or {}).get("at"), "data": (hit or {}).get("data"), "error": msg}
    cache[cache_key] = entry
    _write("usage.json", cache)
    return entry["data"], entry["error"], entry["at"]


def refresh_account(key: str, provider: str = "claude") -> dict:
    """Forget one account's cached usage so the next status call reads it fresh from the API."""
    if provider and provider != "claude":
        return {"ok": bool(P and P.forget_usage(key))}
    store = load_store()
    acct = _find(store, key) or {}
    keys = {key, acct.get("id"), acct.get("account_uuid")}
    if key == "claude-code" or acct.get("account_uuid") == store.get("live_uuid"):
        keys.add(store.get("live_uuid"))
    cache = _read("usage.json", {})
    hit = [k for k in keys if k and isinstance(cache, dict) and k in cache]
    for k in hit:
        cache.pop(k, None)
    if hit:
        _write("usage.json", cache)
    return {"ok": True, "cleared": len(hit)}


def _peak(usage: Optional[dict], keys) -> Tuple[Optional[float], Optional[str]]:
    best, bk = None, None
    for k in keys:
        w = ((usage or {}).get("windows") or {}).get(k)
        if w and (best is None or w["pct"] > best):
            best, bk = w["pct"], k
    return best, bk


# ─── Hermes (read-only) ───────────────────────────────────────────────────────────────────────

def hermes_accounts() -> List[dict]:
    try:
        data = json.loads((HERMES_HOME / "auth.json").read_text("utf-8"))
    except Exception:
        return []
    out = []
    for e in ((data.get("credential_pool") or {}).get("anthropic") or []):
        tok = e.get("access_token") or ""
        if not tok.startswith("sk-ant-oat"):
            continue
        exp = _ts(e.get("expires_at_ms"))
        out.append({"id": f"hermes:{e.get('id')}", "label": e.get("label"), "token": tok,
                    "expired": bool(exp and exp < now()), "priority": e.get("priority", 0),
                    "status": e.get("last_status") or "ok"})
    return out


# ─── Claude Code sessions (context) ───────────────────────────────────────────────────────────

def _context_max(model: str, used: int) -> int:
    m = (model or "").lower()
    if "[1m]" in m or "-1m" in m or used > 200_000:
        return 1_000_000
    return 200_000


def _tail_lines(path: str, nbytes: int = 400_000) -> List[str]:
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        fh.seek(max(0, size - nbytes))
        data = fh.read().decode("utf-8", "replace")
    lines = data.splitlines()
    return lines[1:] if size > nbytes else lines


def session_info(path: str) -> Optional[dict]:
    try:
        st = os.stat(path)
        lines = _tail_lines(path)
    except OSError:
        return None
    title = cwd = model = None
    usage = None
    last_ts = None
    for line in reversed(lines):
        if not line.startswith("{"):
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        t = r.get("type")
        if title is None and t == "ai-title":
            title = r.get("aiTitle")
        if title is None and t == "summary":
            title = r.get("summary")
        if cwd is None and r.get("cwd"):
            cwd = r.get("cwd")
        if usage is None and t == "assistant":
            m = r.get("message") or {}
            if isinstance(m, dict) and isinstance(m.get("usage"), dict) and not r.get("isSidechain"):
                usage, model = m["usage"], m.get("model")
                last_ts = _ts(r.get("timestamp"))
        if title and cwd and usage:
            break
    if not usage:
        return None
    used = int((usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0)
               + (usage.get("cache_creation_input_tokens") or 0))
    cmax = _context_max(model or "", used)
    return {
        "id": Path(path).stem, "path": path, "title": title or "Untitled session", "cwd": cwd,
        "project": Path(cwd).name if cwd else Path(path).parent.name, "model": model,
        "context_used": used, "context_max": cmax, "context_percent": round(used / cmax * 100, 1),
        "output_tokens": usage.get("output_tokens"), "updated_at": st.st_mtime,
        "running": now() - st.st_mtime < 90, "last_turn_at": last_ts,
    }


def claude_sessions(limit: int = 10, cwd: Optional[str] = None, max_age_h: float = 24 * 14) -> List[dict]:
    files = glob.glob(str(CLAUDE_DIR / "projects" / "*" / "*.jsonl"))
    files = [f for f in files if now() - os.path.getmtime(f) < max_age_h * 3600]
    files.sort(key=os.path.getmtime, reverse=True)
    out = []
    for f in files[: limit * 2]:
        info = session_info(f)
        if info:
            out.append(info)
        if len(out) >= limit:
            break
    if cwd:
        cwd = os.path.realpath(cwd)
        for s in out:
            s["in_workspace"] = bool(s.get("cwd")) and os.path.realpath(s["cwd"]).startswith(cwd)
    return out


# ─── snapshot ─────────────────────────────────────────────────────────────────────────────────

def snapshot(*, force: bool = False, cwd: Optional[str] = None) -> Dict[str, Any]:
    settings = load_settings()
    max_age = 15 if force else settings["poll_seconds"] - 5
    store, live = sync_live()
    blob, src = cc_read()
    live_oauth = _oauth(blob)
    live_tok = live_oauth.get("accessToken", "")
    live_prof = _identify(live_tok) if live_tok else None
    accounts: List[dict] = []
    seen_uuids = set()

    def row(base: dict, token: Optional[str], *, live_flag: bool, kind: str, switchable: bool) -> dict:
        usage, err, at = (None, None, None)
        if token:
            usage, err, at = fetch_usage(token, base.get("account_uuid") or base["id"], max_age)
        elif kind == "saved":
            err = "Login expired — run `add` for this account again"
        peak, pk = _peak(usage, settings["windows"])
        return {**base, "kind": kind, "live": live_flag, "active": live_flag, "switchable": switchable,
                "usage": usage, "usage_error": err, "usage_at": at, "peak_pct": peak, "peak_window": pk,
                "status": "ok" if token or live_flag else "expired"}

    # 1) the account Claude Code is logged into
    if live_tok:
        lp = live_prof or {}
        base = {"id": (live or {}).get("id") or "claude-code", "label": (live or {}).get("label") or lp.get("email") or "Claude Code login",
                "email": lp.get("email"), "name": lp.get("name"), "org": lp.get("org"), "plan": lp.get("plan"),
                "account_uuid": lp.get("account_uuid"), "saved": live is not None, "credential_source": src}
        exp = _ts(live_oauth.get("expiresAt"))
        r = row(base, live_tok if not exp or exp > now() else None, live_flag=True, kind="claude-code", switchable=True)
        if exp and exp <= now():
            r["usage_error"] = "Claude Code token expired — it refreshes the next time Claude Code runs"
        accounts.append(r)
        if lp.get("account_uuid"):
            seen_uuids.add(lp["account_uuid"])
    # 2) saved accounts
    dirty = False
    for a in store["accounts"]:
        if a.get("account_uuid") and a["account_uuid"] in seen_uuids:
            continue
        tok = _ensure_fresh(a, store)
        base = {k: a.get(k) for k in ("id", "label", "email", "name", "org", "plan", "account_uuid")}
        base["saved"] = True
        accounts.append(row(base, tok, live_flag=False, kind="saved", switchable=bool(tok)))
        if a.get("account_uuid"):
            seen_uuids.add(a["account_uuid"])
    if dirty:
        save_store(store)
    # 3) Hermes accounts (read-only)
    if settings["show_hermes"]:
        for h in hermes_accounts():
            prof = _identify(h["token"]) if not h["expired"] else None
            if prof and prof.get("account_uuid") in seen_uuids:
                for r in accounts:
                    if r.get("account_uuid") == prof["account_uuid"]:
                        r["in_hermes"] = True
                continue
            base = {"id": h["id"], "label": h["label"], **(prof or {}), "saved": False}
            r = row(base, None if h["expired"] else h["token"], live_flag=False, kind="hermes", switchable=False)
            r["hint"] = "Used by Hermes. To switch Claude Code to it, connect it here too (Add account)."
            accounts.append(r)
            if prof and prof.get("account_uuid"):
                seen_uuids.add(prof["account_uuid"])
    sessions = claude_sessions(cwd=cwd)
    current = next((s for s in sessions if s.get("in_workspace")), None) if cwd else None
    current = current or (sessions[0] if sessions else None)
    st = _read("state.json", {})
    pin = st.get("pinned") or {}
    for a in accounts:
        if pin.get("id") == a["id"] and float(pin.get("until") or 0) > now():
            a["pinned_until"] = pin["until"]
    providers = {}
    if P is not None:
        try:
            providers = P.snapshot(settings, force=force)
        except Exception as e:  # never let a provider break the Claude view
            providers = {"error": f"{type(e).__name__}: {e}"}
    routing = None
    if RT is not None:
        try:
            if live_tok:
                RT.latest_ids(live_tok)  # cached 12 h; labels the tiers with real model versions
            routing = RT.snapshot()
        except Exception as e:
            routing = {"error": f"{type(e).__name__}: {e}"}
    return {"ok": True, "version": VERSION, "now": now(), "settings": settings, "accounts": accounts,
            "routing": routing,
            "providers": {k: v for k, v in providers.items() if isinstance(v, dict)}, "provider_meta": P.META if P else {},
            "live_id": accounts[0]["id"] if accounts and accounts[0]["live"] else None,
            "credential_source": src, "sessions": sessions, "current_session": current,
            "events": events(25), "last_check_at": st.get("last_check_at"), "home": str(HOME)}


# ─── actions ──────────────────────────────────────────────────────────────────────────────────

def import_current(label: str = "") -> dict:
    blob, src = cc_read()
    if not blob or not _oauth(blob).get("accessToken"):
        return {"ok": False, "error": "Claude Code is not logged in (run `claude` and /login first)."}
    store = load_store()
    acct, created = _upsert_from_blob(store, blob, label=label, source="claude-code")
    save_store(store)
    _event("imported", f"Saved Claude Code's login ({acct['label']})", to_id=acct["id"])
    return {"ok": True, "id": acct["id"], "label": acct["label"], "created": created}


def _credential_for(acct: dict) -> dict:
    blob = json.loads(json.dumps(acct["credential"]))
    o = blob.setdefault("claudeAiOauth", {})
    o.setdefault("scopes", SCOPES.split())
    if acct.get("plan"):
        o["subscriptionType"] = SUB_TYPES.get(acct["plan"].split()[0], acct["plan"].split()[0].lower())
    if acct.get("rate_limit_tier"):
        o["rateLimitTier"] = acct["rate_limit_tier"]
    if acct.get("org_uuid"):
        blob["organizationUuid"] = acct["org_uuid"]
    return blob


def _pin_if_hot(target: dict) -> Optional[float]:
    """A manual switch onto an account that is already over the threshold pins it, so auto-switch
    doesn't immediately flip back. The pin lasts until the hot window resets."""
    settings = load_settings()
    cache = _read("usage.json", {})
    usage = ((cache.get(target.get("account_uuid") or target["id"]) or {}).get("data")) if isinstance(cache, dict) else None
    peak, pk = _peak(usage, settings["windows"])
    st = _read("state.json", {})
    until = None
    if peak is not None and peak >= settings["threshold"]:
        until = (((usage or {}).get("windows") or {}).get(pk) or {}).get("resets_at") or now() + 3600
        st["pinned"] = {"id": target["id"], "until": until}
    else:
        st.pop("pinned", None)
    _write("state.json", st)
    return until


def switch_to(key: str, *, reason: str = "manual") -> dict:
    with _lock:
        store, live = sync_live()
        target = _find(store, key)
        if target is None:
            return {"ok": False, "error": f'No saved account matches "{key}". Run `status` to list them.'}
        current, _src = cc_read()
        # never lose the account we're switching away from
        if current and _oauth(current).get("accessToken"):
            prev, _created = _upsert_from_blob(store, current, source="claude-code")
            if prev["id"] == target["id"]:
                save_store(store)
                pin = _pin_if_hot(target) if reason != "auto" else None
                return {"ok": True, "id": target["id"], "label": target["label"], "unchanged": True,
                        "warning": (f"Pinned: auto-switch leaves {target['label']} alone until "
                                    f"{time.strftime('%a %H:%M', time.localtime(pin))}.") if pin else None}
        else:
            prev = None
        tok = _ensure_fresh(target, store)
        if not tok:
            save_store(store)
            return {"ok": False, "error": f"{target['label']}'s login has expired. Run `add` and sign in to it again."}
        backup = _backup_cc(current, "before-switch")
        where = cc_write(_credential_for(target))
        store["live_uuid"] = target.get("account_uuid")
        save_store(store)
        pin = _pin_if_hot(target) if reason != "auto" else None
        msg = f"Claude Code switched {prev['label'] + ' → ' if prev else 'to '}{target['label']}"
        _event("auto_switch" if reason == "auto" else "manual_switch", msg,
               from_id=(prev or {}).get("id"), to_id=target["id"])
        return {"ok": True, "id": target["id"], "label": target["label"], "from": (prev or {}).get("label"),
                "written_to": where, "backup": backup,
                "note": "New Claude Code sessions use this account. Restart an open session to move it over.",
                "warning": (f"{target['label']} is already over the auto-switch threshold — auto-switch will leave it "
                            f"alone until {time.strftime('%a %H:%M', time.localtime(pin))}.") if pin else None}


def remove(key: str) -> dict:
    store = load_store()
    a = _find(store, key)
    if a is None:
        return {"ok": False, "error": f'No saved account matches "{key}".'}
    if a.get("account_uuid") and a.get("account_uuid") == store.get("live_uuid"):
        return {"ok": False, "error": "That account is live in Claude Code. Switch to another one first."}
    store["accounts"] = [x for x in store["accounts"] if x["id"] != a["id"]]
    save_store(store)
    _event("removed", f"Removed {a['label']}")
    return {"ok": True}


_PENDING = "pending_login.json"


def login_start(label: str = "") -> dict:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    _write(_PENDING, {"verifier": verifier, "state": state, "label": label, "at": now()}, private=True)
    q = {"code": "true", "client_id": CLIENT_ID, "response_type": "code", "redirect_uri": REDIRECT_URI,
         "scope": SCOPES, "code_challenge": challenge, "code_challenge_method": "S256", "state": state}
    return {"ok": True, "url": f"{AUTHORIZE_URL}?{urllib.parse.urlencode(q)}", "login_id": state}


def login_finish(code_input: str, label: str = "") -> dict:
    p = _read(_PENDING, {})
    if not p or now() - p.get("at", 0) > 1800:
        return {"ok": False, "error": "Login expired — start again."}
    raw = (code_input or "").strip()
    code, _, st = raw.partition("#")
    if not code:
        return {"ok": False, "error": "Paste the code shown after you click Authorize."}
    if st and st != p["state"]:
        return {"ok": False, "error": "That code belongs to a different login attempt. Start again."}
    body = {"grant_type": "authorization_code", "client_id": CLIENT_ID, "code": code, "state": p["state"],
            "redirect_uri": REDIRECT_URI, "code_verifier": p["verifier"]}
    res = None
    for url in TOKEN_URLS:
        c, r = _http("POST", url, body=body, ua=TOKEN_UA, timeout=20)
        if c == 200 and isinstance(r, dict) and r.get("access_token"):
            res = r
            break
        if c in (400, 401):
            return {"ok": False, "error": f"Anthropic rejected the code ({(r or {}).get('error_description') or (r or {}).get('error') or c})."}
    if not res:
        return {"ok": False, "error": "Could not reach Anthropic's token endpoint."}
    try:
        os.remove(str(HOME / _PENDING))
    except OSError:
        pass
    blob = {"claudeAiOauth": {"accessToken": res["access_token"], "refreshToken": res.get("refresh_token"),
                              "expiresAt": int((now() + float(res.get("expires_in") or 3600)) * 1000),
                              "scopes": (res.get("scope") or SCOPES).split()}}
    store = load_store()
    existed_uuids = {a.get("account_uuid") for a in store["accounts"]}
    acct, created = _upsert_from_blob(store, blob, label=label or p.get("label") or "", source="pkce")
    save_store(store)
    _event("added", f"Connected {acct['label']}", to_id=acct["id"])
    warn = None
    if not created and acct.get("account_uuid") in existed_uuids:
        warn = "You were already signed in to this account — its saved login was refreshed instead."
    return {"ok": True, "id": acct["id"], "label": acct["label"], "warning": warn}


# ─── auto-switch ──────────────────────────────────────────────────────────────────────────────

def check(*, force: bool = False, cwd: Optional[str] = None) -> Dict[str, Any]:
    settings = load_settings()
    st = _read("state.json", {})
    snap = snapshot(force=force, cwd=cwd)
    action = None
    if settings["auto_switch"]:
        thr = settings["threshold"]
        live = next((a for a in snap["accounts"] if a["live"]), None)
        pin = st.get("pinned") or {}
        pinned = bool(live and pin.get("id") == live["id"] and float(pin.get("until") or 0) > now())
        if live and not pinned and live["peak_pct"] is not None and live["peak_pct"] >= thr:
            cands = [a for a in snap["accounts"] if a["kind"] == "saved" and a["switchable"]
                     and a["peak_pct"] is not None and a["peak_pct"] < thr]
            if cands:
                best = min(cands, key=lambda a: a["peak_pct"])
                res = switch_to(best["id"], reason="auto")
                action = res
                if res.get("ok"):
                    _notify("Claude account switched",
                            f"{live['label']} hit {live['peak_pct']:.0f}% → now using {best['label']}")
                    snap = snapshot(cwd=cwd)
            elif st.get("all_hot_for") != live["id"]:
                _event("all_hot", f"{live['label']} is at {live['peak_pct']:.0f}% and no saved account is below {thr}%.")
                st["all_hot_for"] = live["id"]
        else:
            st.pop("all_hot_for", None)
    if RT is not None:
        try:
            thr = settings["threshold"]
            live = next((a for a in snap["accounts"] if a["live"]), None)
            others = any(a for a in snap["accounts"] if not a["live"] and a["switchable"] and a["kind"] == "saved"
                         and a["peak_pct"] is not None and a["peak_pct"] < thr)
            flip = RT.quota_tick(live and live["peak_pct"], others, thr)
            if flip == "downgraded":
                _event("routing", f"Save quota: {live['label']} is at {live['peak_pct']:.0f}% — every tier now uses one model smaller.")
            elif flip == "restored":
                _event("routing", "Save quota: usage recovered — tiers are back to their models.")
            if flip:
                snap["routing"] = RT.snapshot()
        except Exception as e:
            _event("error", f"Routing check failed: {type(e).__name__}: {e}")
    _write("state.json", st)
    prov_actions = []
    if P is not None and snap.get("providers"):
        try:
            prov_actions = P.check(settings, snap["providers"])
        except Exception as e:
            _event("error", f"Provider auto-switch failed: {type(e).__name__}: {e}")
        for a in prov_actions:
            if a.get("ok") and not a.get("unchanged"):
                _notify(f"{P.META[a['provider']]['name']} account switched", f"Now using {a['label']}")
        if prov_actions:
            snap["providers"] = P.snapshot(settings)
    st = _read("state.json", {})
    st["last_check_at"] = now()
    _write("state.json", st)
    snap["provider_actions"] = prov_actions
    snap["last_check_at"] = st["last_check_at"]
    snap["action"] = action
    _write("status-cache.json", {k: snap[k] for k in ("accounts", "settings", "live_id", "last_check_at")})
    return snap


def _notify(title: str, body: str) -> None:
    if not _is_mac():
        return
    try:
        script = f'display notification {json.dumps(body)} with title {json.dumps(title)}'
        subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def maybe_check_background() -> None:
    """Statusline helper: kick a detached check when the cache is older than the poll interval."""
    st = _read("state.json", {})
    if now() - float(st.get("last_check_at") or 0) < load_settings()["poll_seconds"]:
        return
    lock = HOME / "check.lock"
    try:
        if lock.exists() and now() - lock.stat().st_mtime < 120:
            return
        _ensure_home()
        lock.write_text(str(os.getpid()))
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "check", "--quiet", "--unlock"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception:
        pass


# ─── statusline ───────────────────────────────────────────────────────────────────────────────

def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m"


def _tone(p: Optional[float], thr: int) -> str:
    if p is None:
        return "2"
    return "31" if p >= thr else "33" if p >= min(70, thr - 10) else "32"


def statusline(stdin_text: str) -> str:
    try:
        info = json.loads(stdin_text) if stdin_text.strip() else {}
    except Exception:
        info = {}
    maybe_check_background()
    cache = _read("status-cache.json", {})
    thr = int((cache.get("settings") or {}).get("threshold") or 90)
    parts = []
    live = next((a for a in (cache.get("accounts") or []) if a.get("live")), None)
    if live:
        name = (live.get("email") or live.get("label") or "?").split("@")[0]
        plan = f" {live['plan']}" if live.get("plan") else ""
        wins = (live.get("usage") or {}).get("windows") or {}
        seg = [_c("1", f"◆ {name}") + _c("2", plan)]
        for k, short in (("five_hour", "5h"), ("seven_day", "wk")):
            w = wins.get(k)
            if w:
                seg.append(_c(_tone(w["pct"], thr), f"{short} {w['pct']:.0f}%"))
        n_other = sum(1 for a in cache.get("accounts") or [] if a.get("kind") == "saved" and not a.get("live"))
        if n_other:
            seg.append(_c("2", f"+{n_other}"))
        parts.append(" ".join(seg))
    else:
        parts.append(_c("2", "◆ claude-accounts: run `import`"))
    tp = info.get("transcript_path")
    s = session_info(tp) if tp and os.path.exists(tp) else None
    cw = info.get("context_window") if isinstance(info.get("context_window"), dict) else None
    if s:
        p = s["context_percent"]
        parts.append(_c(_tone(p, 85), f"ctx {p:.0f}% {s['context_used'] / 1000:.0f}k/{s['context_max'] // 1000}k"))
    elif cw and _num(cw.get("used_percentage")):
        parts.append(_c(_tone(cw["used_percentage"], 85), f"ctx {cw['used_percentage']:.0f}%"))
    model = (info.get("model") or {}).get("display_name")
    if model:
        parts.append(_c("2", model))
    return _c("2", " │ ").join(parts)


# ─── MCP server (stdio) ───────────────────────────────────────────────────────────────────────

MCP_TOOLS = [
    {"name": "claude_accounts_status",
     "description": "List the Claude accounts available to Claude Code with 5-hour/weekly usage, which one is live, "
                    "auto-switch settings, and recent Claude Code sessions with their context-window usage.",
     "inputSchema": {"type": "object", "properties": {"refresh": {"type": "boolean", "description": "Bypass the usage cache"}}}},
    {"name": "claude_accounts_switch",
     "description": "Switch to another saved account (by id, email or label). provider: claude (default — Claude Code, "
                    "new sessions), antigravity (Antigravity app/agy/VS Code) or copilot.",
     "inputSchema": {"type": "object", "properties": {"account": {"type": "string"},
                                                      "provider": {"type": "string", "enum": ["claude", "antigravity", "copilot"]}},
                     "required": ["account"]}},
    {"name": "claude_accounts_settings",
     "description": "Change auto-switch settings: auto_switch (bool), threshold (50-99 percent), poll_seconds.",
     "inputSchema": {"type": "object", "properties": {"auto_switch": {"type": "boolean"}, "threshold": {"type": "integer"},
                                                      "poll_seconds": {"type": "integer"}}}},
]


def _summary_text(snap: dict) -> str:
    s = snap["settings"]
    lines = [f"Auto-switch {'ON' if s['auto_switch'] else 'OFF'} at {s['threshold']}% (watching {', '.join(s['windows'])})", ""]
    for a in snap["accounts"]:
        tag = "LIVE in Claude Code" if a["live"] else ("saved" if a["kind"] == "saved" else "Hermes only (read-only)")
        lines.append(f"- {a.get('email') or a.get('label')} [{a.get('plan') or '?'}] — {tag} (id {a['id']})")
        for w in ((a.get("usage") or {}).get("windows") or {}).values():
            r = time.strftime("%a %H:%M", time.localtime(w["resets_at"])) if w.get("resets_at") else "?"
            lines.append(f"    {w['label']}: {w['pct']:.0f}% used, resets {r}")
        if a.get("usage_error"):
            lines.append(f"    ! {a['usage_error']}")
    for pid, info in (snap.get("providers") or {}).items():
        if not info.get("accounts"):
            continue  # providers without accounts stay out of the way
        lines += ["", f"{info['name']} (auto-switch {'on' if info.get('auto_switch') else 'off'}):"]
        for a in info.get("accounts") or []:
            tag = "LIVE" if a["live"] else "saved"
            lines.append(f"- {a.get('email') or a.get('login') or a.get('label')} [{a.get('plan') or '?'}] — {tag} (id {a['id']})")
            for w in ((a.get("usage") or {}).get("windows") or {}).values():
                r = time.strftime("%a %H:%M", time.localtime(w["resets_at"])) if w.get("resets_at") else "?"
                lines.append(f"    {w['label']}: {w['pct']:.0f}% used, resets {r}")
            if a.get("usage_error"):
                lines.append(f"    ! {a['usage_error']}")
    if snap.get("sessions"):
        lines += ["", "Recent Claude Code sessions:"]
        for x in snap["sessions"][:6]:
            lines.append(f"- {x['title']} ({x['project']}): context {x['context_percent']:.0f}% "
                         f"({x['context_used'] // 1000}k/{x['context_max'] // 1000}k){' — active' if x['running'] else ''}")
    return "\n".join(lines)


def mcp_serve() -> None:
    def send(obj: dict) -> None:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if mid is None:
            continue  # notification
        try:
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion") or "2024-11-05",
                          "capabilities": {"tools": {}},
                          "serverInfo": {"name": "claude-accounts", "version": VERSION}}
            elif method == "tools/list":
                result = {"tools": MCP_TOOLS}
            elif method == "tools/call":
                name, args = params.get("name"), params.get("arguments") or {}
                if name == "claude_accounts_status":
                    text = _summary_text(check(force=bool(args.get("refresh"))))
                elif name == "claude_accounts_switch":
                    prov = str(args.get("provider") or "claude")
                    r = (switch_to(str(args.get("account") or "")) if prov == "claude" or P is None else
                         P.use(prov, str(args.get("account") or ""), threshold=load_settings()["threshold"]))
                    text = (f"Switched Claude Code to {r['label']}. {r.get('note', '')}" if r.get("ok") else f"Error: {r['error']}")
                elif name == "claude_accounts_settings":
                    text = "Settings now: " + json.dumps(save_settings({k: v for k, v in args.items() if v is not None}))
                else:
                    raise ValueError(f"unknown tool {name}")
                result = {"content": [{"type": "text", "text": text}]}
            elif method == "ping":
                result = {}
            else:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}})
                continue
            send({"jsonrpc": "2.0", "id": mid, "result": result})
        except Exception as e:
            send({"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}]}})


# ─── CLI ──────────────────────────────────────────────────────────────────────────────────────

def _print_status(snap: dict) -> None:
    print(_summary_text(snap))


def main(argv: List[str]) -> int:
    if not argv:
        argv = ["status"]
    cmd, rest = argv[0], argv[1:]
    flag = lambda f: f in rest  # noqa: E731

    def opt(name: str) -> Optional[str]:
        if name in rest:
            i = rest.index(name)
            return rest[i + 1] if i + 1 < len(rest) else None
        return None

    if cmd == "status":
        if opt("--refresh-account"):
            refresh_account(opt("--refresh-account"), opt("--provider") or "claude")
        snap = check(force=flag("--refresh"), cwd=opt("--cwd")) if flag("--auto") else snapshot(force=flag("--refresh"), cwd=opt("--cwd"))
        print(json.dumps(snap, default=str)) if flag("--json") else _print_status(snap)
        return 0
    if cmd == "check":
        if flag("--unlock"):
            try:
                os.remove(str(HOME / "check.lock"))
            except OSError:
                pass
        snap = check(force=flag("--refresh"), cwd=opt("--cwd"))
        if not flag("--quiet"):
            print(json.dumps({"action": snap.get("action"), "last_check_at": snap["last_check_at"]}, default=str))
        return 0
    if cmd == "watch":
        print(f"claude-accounts watch: checking every {load_settings()['poll_seconds']}s (Ctrl-C to stop)", flush=True)
        while True:
            try:
                snap = check()
                if snap.get("action"):
                    print(time.strftime("%H:%M:%S"), json.dumps(snap["action"], default=str), flush=True)
            except Exception as e:
                print("check failed:", e, file=sys.stderr, flush=True)
            time.sleep(load_settings()["poll_seconds"])
    prov = opt("--provider") or "claude"
    if prov not in ("claude", "antigravity", "copilot"):
        print(f"unknown provider {prov!r} (claude, antigravity, copilot)", file=sys.stderr)
        return 2
    other = prov != "claude" and P is not None
    pos = [x for i, x in enumerate(rest) if not x.startswith("--") and (i == 0 or rest[i - 1] not in ("--provider", "--label", "--code", "--cwd"))]
    if cmd == "routing":
        if RT is None:
            r = {"ok": False, "error": "routing.py missing"}
        else:
            patch = dict(x.split("=", 1) for x in rest if "=" in x)
            if patch:
                cfg = RT.save(patch)
            else:
                cfg = RT.load()
                RT.apply_claude_code(cfg)
            r = {"ok": True, "routing": RT.snapshot(delegations=False) if flag("--json") else cfg}
            if not flag("--json"):
                tiers = RT.effective_tiers(cfg)
                print(f"Model routing {'ON' if cfg['enabled'] else 'OFF'} — " + ", ".join(f"{t}: {tiers[t]}" for t in RT.TIERS)
                      + f"; Claude Code main: {cfg['claude_code_main']}; agents: {'on' if cfg['claude_code_agents'] else 'off'}")
                return 0
        print(json.dumps(r, default=str))
        return 0 if r.get("ok") else 1
    if cmd == "delegations":
        rows = RT.claude_code_delegations() if RT else []
        if flag("--json"):
            print(json.dumps(rows, default=str))
        else:
            for x in rows:
                when = time.strftime("%a %H:%M", time.localtime(x["at"])) if x.get("at") else "?"
                print(f"{when}  {x['model_label']:<10} {x['state']:<8} {x['description'][:60]}  [{x['agent']} · {x['session'][:30]}]")
        return 0
    if cmd == "login-status":
        r = P.login_status(pos[0] if pos else "")
    elif cmd == "login-cancel":
        r = P.login_cancel(pos[0] if pos else "")
    elif other and cmd == "use":
        r = P.use(prov, pos[0] if pos else "", threshold=load_settings()["threshold"])
    elif other and cmd == "remove":
        r = P.remove(prov, pos[0] if pos else "")
    elif other and cmd == "login-start":
        r = P.login_start(prov, opt("--label") or "")
    elif other and cmd == "add":
        s = P.login_start(prov, opt("--label") or "")
        if not s.get("ok"):
            r = s
        else:
            if s.get("user_code"):
                print(f"Open {s['verification_uri']} and enter the code:  {s['user_code']}\n")
                url = s["verification_uri"]
            else:
                print("Sign in with the Google account you want to add (a browser window is opening):\n\n  " + s["url"] + "\n")
                url = s["url"]
            with contextlib.suppress(Exception):
                import webbrowser
                webbrowser.open(url)
            print("Waiting for you to finish signing in… (Ctrl-C to cancel)", flush=True)
            try:
                while True:
                    time.sleep(2)
                    r = P.login_status(s["login_id"])
                    if r.get("status") != "pending":
                        break
            except KeyboardInterrupt:
                r = P.login_cancel(s["login_id"])
                r = {"ok": False, "error": "Cancelled."}
            if r.get("status") == "done":
                r = {"ok": True, "label": f"Added {r.get('label')}", "warning": r.get("warning")}
            elif r.get("status") in ("error", "expired", "cancelled"):
                r = {"ok": False, "error": r.get("error") or r["status"]}
    elif cmd == "import":
        r = import_current(opt("--label") or "")
    elif cmd == "use":
        if not rest:
            print("usage: use <account>", file=sys.stderr)
            return 2
        r = switch_to(pos[0] if pos else rest[0])
    elif cmd == "remove":
        r = remove(pos[0] if pos else "")
    elif cmd == "config":
        patch = dict(x.split("=", 1) for x in rest if "=" in x)
        r = {"ok": True, "settings": save_settings(patch) if patch else load_settings()}
    elif cmd == "login-start":
        r = login_start(opt("--label") or "")
    elif cmd == "login-finish":
        r = login_finish(opt("--code") or (sys.stdin.read() if flag("--stdin") else ""), opt("--label") or "")
    elif cmd == "add":
        s = login_start(opt("--label") or "")
        print("Sign in to the Claude account you want to add (use a private window if you're signed in to another):\n")
        print("  " + s["url"] + "\n")
        try:
            import webbrowser
            webbrowser.open(s["url"])
        except Exception:
            pass
        r = login_finish(input("Paste the code from the page: "), opt("--label") or "")
    elif cmd == "statusline":
        sys.stdout.write(statusline(sys.stdin.read() if not sys.stdin.isatty() else ""))
        return 0
    elif cmd == "mcp":
        mcp_serve()
        return 0
    elif cmd in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    elif cmd == "--version":
        print(VERSION)
        return 0
    else:
        print(f"unknown command {cmd!r}\n{__doc__}", file=sys.stderr)
        return 2
    if flag("--json"):
        print(json.dumps(r, default=str))
    else:
        print(("✓ " if r.get("ok") else "✗ ") + (r.get("error") or r.get("note") or r.get("label") or json.dumps(r.get("settings") or r)))
        if r.get("warning"):
            print("! " + r["warning"])
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
