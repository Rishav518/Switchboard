#!/usr/bin/env python3
"""providers.py — Antigravity and GitHub Copilot accounts for claude-accounts.

Stdlib only, Python 3.9+. Shares ~/.claude-accounts (CLAUDE_ACCOUNTS_HOME) with claude_accounts.py.

Antigravity (Google)
    Antigravity (the app, the `agy` CLI and its VS Code extension) keeps one Google login in the macOS
    Keychain item service "gemini" / account "antigravity" ("go-keyring-base64:" + JSON). Switching
    writes another saved account's token into that item. Google refresh tokens are not rotated, so the
    login Antigravity uses can be saved here without logging Antigravity out. Usage = the per-model
    quota Antigravity itself shows (cloudcode-pa fetchAvailableModels → remainingFraction/resetTime).
    The OAuth client is read from the Antigravity install on this machine (never shipped here).

GitHub Copilot
    Accounts are connected with GitHub's device flow (the Copilot editor OAuth app). Usage =
    api.github.com/copilot_internal/user quota snapshots (premium requests, chat, completions).
    "Use" selects the account for Copilot clients that read ~/.config/github-copilot/apps.json
    (Neovim, JetBrains, Xcode, Zed, …). Copilot inside VS Code is switched by the VS Code extension
    through VS Code's own account picker.

All files are 0600. Tokens never leave this machine and are never printed.
"""
from __future__ import annotations

import base64
import contextlib
import glob
import hashlib
import json
import os
import platform
import re
import secrets
import socket
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

HOME = Path(os.environ.get("CLAUDE_ACCOUNTS_HOME", str(Path.home() / ".claude-accounts")))
STORE = "providers.json"
USAGE = "provider-usage.json"

AG_SERVICE = os.environ.get("CLAUDE_ACCOUNTS_AG_SERVICE", "gemini")
AG_ACCOUNT = os.environ.get("CLAUDE_ACCOUNTS_AG_ACCOUNT", "antigravity")
AG_UA = "antigravity/1.11.0 " + ("darwin/arm64" if platform.machine() == "arm64" else "darwin/amd64")
AG_HOSTS = ("https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com")
AG_SCOPES = ("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile "
             "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cclog "
             "https://www.googleapis.com/auth/experimentsandconfigs")
GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo"

GH_CLIENT_ID = "Iv1.b507a08c87ecfe98"          # GitHub Copilot editor OAuth app (copilot.vim, JetBrains, …)
GH_HEADERS = {"Editor-Version": "vscode/1.99.0", "Editor-Plugin-Version": "copilot-chat/0.26.0",
              "User-Agent": "GitHubCopilotChat/0.26.0", "X-Github-Api-Version": "2025-04-01"}
GH_APPS = Path(os.environ.get("CLAUDE_ACCOUNTS_GH_APPS", str(Path.home() / ".config" / "github-copilot" / "apps.json")))

META = {
    "claude": {"id": "claude", "name": "Claude", "vendor": "Anthropic", "add": "code",
               "blurb": "Pro, Max or Team — sign in on claude.ai"},
    "antigravity": {"id": "antigravity", "name": "Antigravity", "vendor": "Google", "add": "browser",
                    "blurb": "Google sign-in — app, agy CLI & VS Code"},
    "copilot": {"id": "copilot", "name": "GitHub Copilot", "vendor": "GitHub", "add": "device",
                "blurb": "GitHub device code — premium requests"},
}


# ─── utils ────────────────────────────────────────────────────────────────────────────────────

def now() -> float:
    return time.time()


def _ensure_home() -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    for d in (HOME, HOME / "logins", HOME / "backups"):
        d.mkdir(exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(d, 0o700)


def _read(name: str, default: Any) -> Any:
    try:
        return json.loads((HOME / name).read_text("utf-8"))
    except Exception:
        return default


def _write(name: str, data: Any) -> None:
    _ensure_home()
    path = HOME / name
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, default=str)
    os.replace(str(tmp), str(path))


_PROC_LOCK = threading.RLock()
_DEPTH = threading.local()


@contextlib.contextmanager
def _locked():
    """Cross-process lock (login helpers are separate processes writing the same store), re-entrant
    and thread-safe inside one process (flock on a second fd of the same file would deadlock)."""
    with _PROC_LOCK:
        depth = getattr(_DEPTH, "n", 0)
        if depth:
            _DEPTH.n = depth + 1
            try:
                yield
            finally:
                _DEPTH.n = depth
            return
        _ensure_home()
        fh = open(HOME / "providers.lock", "a+")
        try:
            try:
                import fcntl
                fcntl.flock(fh, fcntl.LOCK_EX)
            except ImportError:  # Windows: best effort
                pass
            _DEPTH.n = 1
            yield
        finally:
            _DEPTH.n = 0
            fh.close()


def _ts(v: Any) -> Optional[float]:
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v) / (1000.0 if v > 1e12 else 1.0)
    try:
        from datetime import datetime, timezone
        s = str(v).strip().replace("Z", "+00:00")
        s = re.sub(r"(\.\d{6})\d+", r"\1", s)  # Go/RFC3339 nanoseconds
        dt = datetime.fromisoformat(s)
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None


def _fp(s: str) -> str:
    return hashlib.sha256((s or "").encode()).hexdigest()[:16]


def _http(method: str, url: str, *, headers: Optional[dict] = None, json_body: Any = None,
          form: Optional[dict] = None, timeout: float = 15.0) -> Tuple[int, Any]:
    h = {"Accept": "application/json", **(headers or {})}
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode()
        h["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
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


def _is_mac() -> bool:
    return platform.system() == "Darwin"


def load_store() -> Dict[str, Any]:
    raw = _read(STORE, {})
    raw = raw if isinstance(raw, dict) else {}
    for p in ("antigravity", "copilot"):
        raw.setdefault(p, [])
    return raw


def save_store(store: Dict[str, Any]) -> None:
    _write(STORE, store)


def _event(kind: str, message: str, **extra: Any) -> None:
    """Shared activity log with claude_accounts.py (events.json)."""
    ev = {"id": uuid.uuid4().hex[:8], "at": now(), "kind": kind, "message": message, **extra}
    with _locked():
        raw = _read("events.json", [])
        raw = raw if isinstance(raw, list) else []
        raw.append(ev)
        _write("events.json", raw[-80:])


def _find(store: dict, provider: str, key: str) -> Optional[dict]:
    key = (key or "").strip().lower()
    for a in store.get(provider, []):
        if key in {str(a.get(k) or "").lower() for k in ("id", "email", "login", "label")}:
            return a
    return None


def _usage_cache_get(key: str, max_age: float) -> Optional[dict]:
    c = _read(USAGE, {})
    e = c.get(key) if isinstance(c, dict) else None
    if e and now() - float(e.get("at") or 0) < max_age:
        return e
    return None


def _usage_cache_put(key: str, data: Optional[dict], err: Optional[str]) -> dict:
    with _locked():
        c = _read(USAGE, {})
        c = c if isinstance(c, dict) else {}
        prev = c.get(key) or {}
        e = {"at": now(), "data": data if data is not None else prev.get("data"), "error": err}
        if data is None and prev.get("data"):
            e["at_data"] = prev.get("at_data") or prev.get("at")
        else:
            e["at_data"] = now()
        c[key] = e
        _write(USAGE, c)
    return e


def _peak(windows: Dict[str, dict], watch: Optional[List[str]] = None) -> Tuple[Optional[float], Optional[str]]:
    best, bk = None, None
    for k, w in (windows or {}).items():
        if watch and k not in watch:
            continue
        p = w.get("pct")
        if p is not None and (best is None or p > best):
            best, bk = p, k
    return best, bk


# ─── login bookkeeping (shared by Antigravity browser flow and Copilot device flow) ────────────

def _login_path(login_id: str) -> Path:
    return HOME / "logins" / f"{re.sub(r'[^a-zA-Z0-9_-]', '', login_id)}.json"


def _login_write(login_id: str, data: dict) -> None:
    _ensure_home()
    p = _login_path(login_id)
    tmp = p.with_name(p.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)
    os.replace(str(tmp), str(p))


def _login_read(login_id: str) -> dict:
    try:
        return json.loads(_login_path(login_id).read_text())
    except Exception:
        return {}


_PUBLIC_LOGIN_KEYS = ("login_id", "provider", "status", "url", "user_code", "verification_uri", "expires_at",
                      "account_id", "label", "error", "warning", "started_at")


def login_status(login_id: str) -> dict:
    d = _login_read(login_id)
    if not d:
        return {"ok": False, "status": "unknown", "error": "No such login (it may have finished long ago)."}
    if d.get("status") == "pending" and d.get("expires_at") and now() > float(d["expires_at"]):
        d["status"], d["error"] = "expired", "The sign-in window closed before it finished. Start again."
        _login_write(login_id, d)
    if d.get("status") == "pending" and d.get("pid") and not _pid_alive(int(d["pid"])):
        d["status"], d["error"] = "error", "The sign-in helper stopped unexpectedly. Start again."
        _login_write(login_id, d)
    return {"ok": True, **{k: d.get(k) for k in _PUBLIC_LOGIN_KEYS if d.get(k) is not None}}


def login_cancel(login_id: str) -> dict:
    d = _login_read(login_id)
    if d.get("status") == "pending":
        d["status"] = "cancelled"
        _login_write(login_id, d)
        if d.get("pid"):
            with contextlib.suppress(Exception):
                os.kill(int(d["pid"]), 15)
    return {"ok": True}


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except Exception:
        return True


def _spawn_helper(*args: str) -> int:
    p = subprocess.Popen([sys.executable, os.path.abspath(__file__), *args], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=open(HOME / "login-helper.log", "a"),
                         start_new_session=True, env={**os.environ, "CLAUDE_ACCOUNTS_HOME": str(HOME)})
    return p.pid


def _prune_logins() -> None:
    for f in glob.glob(str(HOME / "logins" / "*.json")):
        with contextlib.suppress(OSError):
            if now() - os.stat(f).st_mtime > 3600:
                os.remove(f)


# ─── Antigravity ──────────────────────────────────────────────────────────────────────────────

def _ag_candidates() -> List[str]:
    home = str(Path.home())
    pats = [f"{home}/.gemini/bin/agy", f"{home}/.gemini/antigravity/bin/*",
            "/Applications/Antigravity.app/Contents/Resources/app/out/main.js",
            "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/*",
            f"{home}/.vscode/extensions/google.google-antigravity-*/extension.js",
            f"{home}/.vscode/extensions/google.google-antigravity-*/bin/*"]
    out = []
    for p in pats:
        out += [x for x in sorted(glob.glob(p)) if os.path.isfile(x)]
    return out


_AG_PREFERRED = ("1071006060591-",)   # Antigravity's own client id prefix; other clients in the binary serve other products


def ag_client(*, reset: bool = False) -> Optional[Tuple[str, str]]:
    """Antigravity's OAuth client (id, secret), read from the local install and validated once.

    With a live Antigravity login, the pair that actually refreshes it wins. Otherwise a bogus refresh
    token probes each pair: Google answers invalid_client for a mismatched id/secret and invalid_grant
    for a working one."""
    st = {} if reset else _read("ag-client.json", {})
    if st.get("id") and st.get("secret"):
        return st["id"], st["secret"]
    ids, secs = [], []
    for f in _ag_candidates():
        try:
            data = open(f, "rb").read()
        except OSError:
            continue
        ids += [m.decode() for m in re.findall(rb"[0-9]{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com", data)]
        secs += [m.decode() for m in re.findall(rb"GOCSPX-[A-Za-z0-9_-]{28}", data)]
    ids = sorted(dict.fromkeys(ids), key=lambda c: 0 if c.startswith(_AG_PREFERRED) else 1)
    secs = list(dict.fromkeys(secs))
    blob, _src = ag_slot_read()
    live_rt = ((blob or {}).get("token") or {}).get("refresh_token")
    valid = []
    for cid in ids:
        for sec in secs:
            form = {"client_id": cid, "client_secret": sec, "grant_type": "refresh_token"}
            if live_rt:
                c, r = _http("POST", GOOGLE_TOKEN, form={**form, "refresh_token": live_rt})
                if c == 200:
                    _write("ag-client.json", {"id": cid, "secret": sec, "at": now(), "verified": "live"})
                    return cid, sec
            _c, r = _http("POST", GOOGLE_TOKEN, form={**form, "refresh_token": "1//claude-accounts-probe"})
            if isinstance(r, dict) and r.get("error") == "invalid_grant":
                valid.append((cid, sec))
    if valid:
        _write("ag-client.json", {"id": valid[0][0], "secret": valid[0][1], "at": now(), "verified": "probe"})
        return valid[0]
    return None


def ag_slot_read() -> Tuple[Optional[dict], str]:
    if not _is_mac():
        return None, "unsupported"
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", AG_SERVICE, "-a", AG_ACCOUNT, "-w"],
                             capture_output=True, text=True, timeout=10)
    except Exception:
        return None, "none"
    raw = (out.stdout or "").strip()
    if out.returncode != 0 or not raw:
        return None, "none"
    try:
        if raw.startswith("go-keyring-base64:"):
            b = raw.split(":", 1)[1]
            raw = base64.b64decode(b + "=" * (-len(b) % 4)).decode()
        return json.loads(raw), "keychain"
    except Exception:
        return None, "unreadable"


def ag_slot_write(blob: dict) -> None:
    payload = "go-keyring-base64:" + base64.b64encode(json.dumps(blob, separators=(",", ":")).encode()).decode()
    cmd = f"add-generic-password -U -a '{AG_ACCOUNT}' -s '{AG_SERVICE}' -w '{payload}'\n"
    res = subprocess.run(["security", "-i"], input=cmd, capture_output=True, text=True, timeout=15)
    if res.returncode != 0 or "error" in (res.stderr or "").lower():
        raise RuntimeError(f"Keychain write failed: {(res.stderr or res.stdout).strip()[:200]}")


def _ag_refresh(acct: dict) -> Optional[str]:
    """Fresh access token for a saved Antigravity account (mutates acct)."""
    if acct.get("access_token") and float(acct.get("expires_at") or 0) > now() + 120:
        return acct["access_token"]
    cl = ag_client()
    if not cl or not acct.get("refresh_token"):
        return None
    c, r = _http("POST", GOOGLE_TOKEN, form={"client_id": cl[0], "client_secret": cl[1],
                                            "refresh_token": acct["refresh_token"], "grant_type": "refresh_token"})
    if c == 200 and isinstance(r, dict) and r.get("access_token"):
        acct["access_token"] = r["access_token"]
        acct["expires_at"] = now() + float(r.get("expires_in") or 3599)
        acct.pop("auth_error", None)
        return acct["access_token"]
    err = (r or {}).get("error") if isinstance(r, dict) else None
    if err in ("unauthorized_client", "invalid_client"):
        ag_client(reset=True)
    elif err == "invalid_grant":
        acct["auth_error"] = "Google signed this account out — add it again"
    return None


def _ag_identity(token: str) -> dict:
    c, r = _http("GET", GOOGLE_USERINFO, headers={"Authorization": f"Bearer {token}"})
    if c == 200 and isinstance(r, dict):
        return {"email": r.get("email"), "name": r.get("name") or r.get("given_name"), "picture": r.get("picture")}
    return {}


_AG_GROUPS = (("claude", "Claude · GPT", ("claude", "gpt")), ("gemini_pro", "Gemini Pro", ("pro",)),
              ("gemini_flash", "Gemini Flash", ("flash",)))


def _ag_usage(token: str) -> Tuple[Optional[dict], Optional[str]]:
    hdr = {"Authorization": f"Bearer {token}", "User-Agent": AG_UA}
    tier = None
    c, r = _http("POST", f"{AG_HOSTS[0]}/v1internal:loadCodeAssist", headers=hdr,
                 json_body={"metadata": {"ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}})
    if c == 200 and isinstance(r, dict):
        t = r.get("paidTier") or r.get("currentTier") or {}
        tier = t.get("name") or (t.get("id") or "").replace("-", " ").title() or None
    models = None
    for host in AG_HOSTS:
        c, r = _http("POST", f"{host}/v1internal:fetchAvailableModels", headers=hdr, json_body={})
        if c == 200 and isinstance(r, dict):
            models = r.get("models") or {}
            break
    if models is None:
        return None, (f"Antigravity quota API returned {c}" if c else "Antigravity quota API unreachable")
    items = models.items() if isinstance(models, dict) else ((m.get("name") or m.get("model") or "", m) for m in models)
    groups: Dict[str, dict] = {}
    for mid, m in items:
        q = (m or {}).get("quotaInfo") or {}
        name = (m or {}).get("displayName")
        if not name or "remainingFraction" not in q or "image" in mid:
            continue
        low = mid.lower()
        key, label = next(((k, lbl) for k, lbl, needles in _AG_GROUPS if any(n in low for n in needles)), ("other", "Other"))
        pct = max(0.0, min(100.0, (1.0 - float(q.get("remainingFraction") or 0)) * 100.0))
        g = groups.setdefault(key, {"key": key, "label": label, "pct": pct, "resets_at": _ts(q.get("resetTime")),
                                    "models": []})
        g["models"].append(name)
        if pct > g["pct"]:
            g["pct"], g["resets_at"] = pct, _ts(q.get("resetTime"))
    order = [k for k, _l, _n in _AG_GROUPS] + ["other"]
    windows = {k: {**groups[k], "models": sorted(set(groups[k]["models"]))[:6]} for k in order if k in groups}
    return {"plan": tier, "windows": windows}, None


def _ag_upsert_from_slot(store: dict, blob: dict) -> Tuple[Optional[dict], bool]:
    tok = blob.get("token") or {}
    rt = tok.get("refresh_token")
    if not rt:
        return None, False
    email = blob.get("id_token_email")
    match = next((a for a in store["antigravity"] if email and a.get("email") == email), None) or \
        next((a for a in store["antigravity"] if a.get("refresh_fp") == _fp(rt)), None)
    for a in ([match] if match else []):
            changed = a.get("refresh_fp") != _fp(rt)
            a.update({"refresh_token": rt, "refresh_fp": _fp(rt), "auth_method": blob.get("auth_method") or a.get("auth_method"),
                      "writer_id": blob.get("writer_id") or a.get("writer_id")})
            if tok.get("access_token") and (_ts(tok.get("expiry")) or 0) > float(a.get("expires_at") or 0):
                a["access_token"], a["expires_at"] = tok["access_token"], _ts(tok.get("expiry"))
            if changed:
                a.pop("auth_error", None)
            return a, False
    a = {"id": "ag-" + uuid.uuid4().hex[:6], "email": email, "label": email or "Antigravity login",
         "refresh_token": rt, "refresh_fp": _fp(rt), "access_token": tok.get("access_token"),
         "expires_at": _ts(tok.get("expiry")), "auth_method": blob.get("auth_method") or "consumer",
         "writer_id": blob.get("writer_id"), "added_at": now(), "source": "antigravity"}
    store["antigravity"].append(a)
    return a, True


def ag_sync_live(store: dict) -> Tuple[Optional[dict], str]:
    """Save the login Antigravity is using (safe: Google refresh tokens are reusable) and return it."""
    blob, src = ag_slot_read()
    if not blob:
        return None, src
    a, created = _ag_upsert_from_slot(store, blob)
    if created and a:
        _event("imported", f"Saved Antigravity's login ({a['label']})", provider="antigravity", to_id=a["id"])
    return a, src


def ag_login_start(label: str = "") -> dict:
    if not _is_mac():
        return {"ok": False, "error": "Antigravity switching needs macOS (its login lives in the Keychain)."}
    cl = ag_client()
    if not cl:
        return {"ok": False, "error": "Couldn't find Antigravity on this Mac. Install Antigravity (or its agy CLI) first."}
    _prune_logins()
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    login_id = "ag" + uuid.uuid4().hex[:10]
    redirect = f"http://127.0.0.1:{port}/oauth-callback"
    url = GOOGLE_AUTH + "?" + urllib.parse.urlencode({
        "client_id": cl[0], "redirect_uri": redirect, "response_type": "code", "scope": AG_SCOPES,
        "access_type": "offline", "prompt": "consent select_account", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256"})
    _login_write(login_id, {"login_id": login_id, "provider": "antigravity", "status": "pending", "url": url,
                            "port": port, "redirect": redirect, "state": state, "verifier": verifier, "label": label,
                            "started_at": now(), "expires_at": now() + 600})
    pid = _spawn_helper("_ag-callback", login_id)
    d = _login_read(login_id)
    d["pid"] = pid
    _login_write(login_id, d)
    time.sleep(0.25)  # let the helper bind before the browser comes back
    return {"ok": True, "login_id": login_id, "provider": "antigravity", "url": url, "status": "pending",
            "expires_at": d["expires_at"]}


def _ag_callback_server(login_id: str) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    d = _login_read(login_id)
    done = {"v": False}

    page = ("<!doctype html><meta charset=utf-8><title>{t}</title><body style='font:15px -apple-system,system-ui;"
            "display:grid;place-items:center;height:100vh;margin:0;background:#0d0f14;color:#e7e9ee'>"
            "<div style='text-align:center'><div style='font-size:42px'>{i}</div><h2 style='margin:.4em 0'>{t}</h2>"
            "<p style='color:#9aa3b2'>{m}</p></div>")

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def do_GET(self):  # noqa: N802
            u = urllib.parse.urlparse(self.path)
            if u.path != "/oauth-callback":
                self.send_response(404)
                self.end_headers()
                return
            q = dict(urllib.parse.parse_qsl(u.query))
            ok, title, msg = False, "Sign-in failed", ""
            if q.get("state") != d["state"]:
                msg = "This sign-in link belongs to a different attempt. Start again from Claude Accounts."
            elif q.get("error"):
                msg = f"Google said: {q['error']}"
            else:
                res = _ag_finish(d, q.get("code", ""))
                ok = res.get("ok")
                title = "Antigravity account added" if ok else "Sign-in failed"
                msg = (f"{res.get('label')} is ready in Claude Accounts. You can close this tab." if ok else res.get("error", ""))
                cur = _login_read(login_id)
                cur.update({"status": "done" if ok else "error", "account_id": res.get("id"), "label": res.get("label"),
                            "error": None if ok else res.get("error"), "warning": res.get("warning")})
                _login_write(login_id, cur)
            if not ok and _login_read(login_id).get("status") == "pending":
                cur = _login_read(login_id)
                cur.update({"status": "error", "error": msg})
                _login_write(login_id, cur)
            body = page.format(t=title, i="✅" if ok else "⚠️", m=msg).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            done["v"] = True

    srv = HTTPServer(("127.0.0.1", int(d["port"])), H)
    srv.timeout = 1.0
    while not done["v"] and now() < float(d["expires_at"]) and _login_read(login_id).get("status") == "pending":
        srv.handle_request()
    srv.server_close()


def _ag_finish(d: dict, code: str) -> dict:
    cl = ag_client()
    if not cl:
        return {"ok": False, "error": "Antigravity's OAuth client disappeared."}
    c, r = _http("POST", GOOGLE_TOKEN, form={"client_id": cl[0], "client_secret": cl[1], "code": code,
                                            "code_verifier": d["verifier"], "redirect_uri": d["redirect"],
                                            "grant_type": "authorization_code"}, timeout=20)
    if c != 200 or not isinstance(r, dict) or not r.get("access_token"):
        return {"ok": False, "error": f"Google rejected the sign-in ({(r or {}).get('error_description') or (r or {}).get('error') or c})."}
    if not r.get("refresh_token"):
        return {"ok": False, "error": "Google didn't return a refresh token. Remove the app's access at myaccount.google.com/permissions and try again."}
    ident = _ag_identity(r["access_token"])
    with _locked():
        store = load_store()
        existing = next((a for a in store["antigravity"] if ident.get("email") and a.get("email") == ident.get("email")), None)
        a = existing or {"id": "ag-" + uuid.uuid4().hex[:6], "added_at": now(), "source": "oauth",
                         "auth_method": "consumer"}
        a.update({"email": ident.get("email"), "name": ident.get("name"), "picture": ident.get("picture"),
                  "label": d.get("label") or a.get("label") or ident.get("email") or "Antigravity account",
                  "refresh_token": r["refresh_token"], "refresh_fp": _fp(r["refresh_token"]),
                  "access_token": r["access_token"], "expires_at": now() + float(r.get("expires_in") or 3599)})
        a.pop("auth_error", None)
        if not existing:
            store["antigravity"].append(a)
        save_store(store)
    _event("added", f"Connected Antigravity · {a['label']}", provider="antigravity", to_id=a["id"])
    return {"ok": True, "id": a["id"], "label": a["label"],
            "warning": "You had already added this Google account — its login was refreshed." if existing else None}


def ag_use(key: str, *, reason: str = "manual") -> dict:
    if not _is_mac():
        return {"ok": False, "error": "Antigravity switching needs macOS."}
    with _locked():
        store = load_store()
        target = _find(store, "antigravity", key)
        if not target:
            return {"ok": False, "error": f'No Antigravity account matches "{key}".'}
        cur_blob, _ = ag_slot_read()
        prev, _ = _ag_upsert_from_slot(store, cur_blob) if cur_blob else (None, False)
        if prev and prev["id"] == target["id"]:
            save_store(store)
            return {"ok": True, "id": target["id"], "label": target["label"], "unchanged": True}
        tok = _ag_refresh(target)
        if not tok:
            save_store(store)
            return {"ok": False, "error": target.get("auth_error") or f"{target['label']}'s login has expired — add it again."}
        if cur_blob:
            name = f"backups/antigravity-{time.strftime('%Y%m%d-%H%M%S')}.json"
            _write(name, cur_blob)
            for old in sorted(glob.glob(str(HOME / "backups" / "antigravity-*.json")))[:-20]:
                with contextlib.suppress(OSError):
                    os.remove(old)
        from datetime import datetime, timezone
        exp = datetime.fromtimestamp(float(target["expires_at"]), tz=timezone.utc).astimezone().isoformat()
        blob = {"token": {"access_token": tok, "token_type": "Bearer", "refresh_token": target["refresh_token"],
                          "expiry": exp, "expires_in": max(1, int(float(target["expires_at"]) - now()))},
                "auth_method": target.get("auth_method") or "consumer", "id_token_email": target.get("email") or "",
                "writer_id": (cur_blob or {}).get("writer_id") or target.get("writer_id") or secrets.token_urlsafe(16)[:22]}
        ag_slot_write(blob)
        store["ag_live"] = target["id"]
        save_store(store)
    msg = f"Antigravity switched {prev['label'] + ' → ' if prev else 'to '}{target['label']}"
    _event("auto_switch" if reason == "auto" else "manual_switch", msg, provider="antigravity",
           from_id=(prev or {}).get("id"), to_id=target["id"])
    return {"ok": True, "id": target["id"], "label": target["label"], "from": (prev or {}).get("label"),
            "note": "Restart Antigravity (or reload VS Code) so its agent picks up the new account."}


# ─── GitHub Copilot ───────────────────────────────────────────────────────────────────────────

def _gh_hdr(token: str) -> dict:
    return {"Authorization": f"token {token}", **GH_HEADERS}


def gh_usage(token: str) -> Tuple[Optional[dict], Optional[str], Optional[dict]]:
    c, r = _http("GET", "https://api.github.com/copilot_internal/user", headers=_gh_hdr(token))
    if c == 401:
        return None, "GitHub signed this account out — add it again", None
    if c == 404 or (c == 403 and isinstance(r, dict) and "copilot" in json.dumps(r).lower()):
        return {"plan": "No Copilot", "windows": {}}, "This GitHub account has no Copilot access", None
    if c != 200 or not isinstance(r, dict):
        return None, f"Copilot usage API returned {c}", None
    plan = {"individual": "Pro", "individual_pro": "Pro+", "business": "Business", "enterprise": "Enterprise",
            "free": "Free", "free_limited_copilot": "Free"}.get(r.get("copilot_plan") or r.get("access_type_sku") or "",
                                                               (r.get("copilot_plan") or "").replace("_", " ").title() or None)
    reset = _ts(r.get("quota_reset_date_utc") or r.get("quota_reset_date") or r.get("limited_user_reset_date"))
    windows: Dict[str, dict] = {}
    labels = {"premium_interactions": "Premium requests", "chat": "Chat", "completions": "Completions"}
    snaps = r.get("quota_snapshots") or {}
    for key in ("premium_interactions", "chat", "completions"):
        q = snaps.get(key)
        if not isinstance(q, dict) or q.get("unlimited"):
            continue
        ent = q.get("entitlement")
        rem = q.get("remaining")
        pr = q.get("percent_remaining")
        if pr is None and ent:
            pr = (float(rem or 0) / float(ent)) * 100.0
        if pr is None:
            continue
        windows[key] = {"key": key, "label": labels[key], "pct": max(0.0, min(100.0, 100.0 - float(pr))),
                        "resets_at": reset, "used": (ent - rem) if ent is not None and rem is not None else None, "limit": ent}
    if not windows and isinstance(r.get("limited_user_quotas"), dict):   # Copilot Free
        monthly = r.get("monthly_quotas") or {}
        for key, rem in r["limited_user_quotas"].items():
            ent = monthly.get(key)
            if ent:
                windows[key] = {"key": key, "label": labels.get(key, key.title()), "pct": max(0.0, min(100.0, 100.0 * (1 - float(rem) / float(ent)))),
                                "resets_at": reset, "used": ent - rem, "limit": ent}
    unlimited = [labels.get(k, k) for k, q in snaps.items() if isinstance(q, dict) and q.get("unlimited")]
    return {"plan": plan, "windows": windows, "unlimited": unlimited}, None, r


def gh_identity(token: str) -> dict:
    c, r = _http("GET", "https://api.github.com/user", headers={"Authorization": f"token {token}", "User-Agent": "claude-accounts"})
    if c == 200 and isinstance(r, dict):
        return {"login": r.get("login"), "name": r.get("name"), "email": r.get("email"), "picture": r.get("avatar_url"),
                "gh_id": r.get("id")}
    return {}


def gh_login_start(label: str = "") -> dict:
    _prune_logins()
    c, r = _http("POST", "https://github.com/login/device/code", form={"client_id": GH_CLIENT_ID, "scope": "read:user"})
    if c != 200 or not isinstance(r, dict) or not r.get("device_code"):
        return {"ok": False, "error": f"GitHub didn't start the sign-in ({(r or {}).get('error') or c})."}
    login_id = "gh" + uuid.uuid4().hex[:10]
    d = {"login_id": login_id, "provider": "copilot", "status": "pending", "user_code": r["user_code"],
         "verification_uri": r.get("verification_uri") or "https://github.com/login/device",
         "device_code": r["device_code"], "interval": int(r.get("interval") or 5), "label": label,
         "started_at": now(), "expires_at": now() + float(r.get("expires_in") or 900)}
    _login_write(login_id, d)
    d["pid"] = _spawn_helper("_gh-poll", login_id)
    _login_write(login_id, d)
    return {"ok": True, "login_id": login_id, "provider": "copilot", "status": "pending", "user_code": d["user_code"],
            "verification_uri": d["verification_uri"], "expires_at": d["expires_at"]}


def _gh_poll(login_id: str) -> None:
    d = _login_read(login_id)
    interval = int(d.get("interval") or 5)
    while now() < float(d["expires_at"]):
        time.sleep(interval)
        if _login_read(login_id).get("status") != "pending":
            return
        c, r = _http("POST", "https://github.com/login/oauth/access_token",
                     form={"client_id": GH_CLIENT_ID, "device_code": d["device_code"],
                           "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
        err = (r or {}).get("error") if isinstance(r, dict) else None
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5
            continue
        cur = _login_read(login_id)
        if isinstance(r, dict) and r.get("access_token"):
            res = gh_save_token(r["access_token"], label=d.get("label") or "", source="device")
            cur.update({"status": "done" if res.get("ok") else "error", "account_id": res.get("id"),
                        "label": res.get("label"), "error": res.get("error"), "warning": res.get("warning")})
        else:
            cur.update({"status": "error", "error": {"expired_token": "The code expired. Start again.",
                                                     "access_denied": "You cancelled the sign-in on GitHub."}.get(err, f"GitHub said: {err or c}")})
        cur.pop("device_code", None)
        _login_write(login_id, cur)
        return


def gh_save_token(token: str, *, label: str = "", source: str = "device") -> dict:
    ident = gh_identity(token)
    if not ident.get("login"):
        return {"ok": False, "error": "That GitHub token doesn't work."}
    with _locked():
        store = load_store()
        existing = next((a for a in store["copilot"] if a.get("login") == ident["login"]), None)
        a = existing or {"id": "gh-" + uuid.uuid4().hex[:6], "added_at": now(), "source": source}
        a.update({k: v for k, v in ident.items() if v is not None})
        a.update({"token": token, "token_fp": _fp(token), "label": label or a.get("label") or ident["login"]})
        a.pop("auth_error", None)
        if not existing:
            store["copilot"].append(a)
            if not store.get("gh_selected"):
                store["gh_selected"] = a["id"]
        save_store(store)
    _event("added", f"Connected GitHub Copilot · {a['label']}", provider="copilot", to_id=a["id"])
    return {"ok": True, "id": a["id"], "label": a["label"],
            "warning": "You had already added this GitHub account — its login was refreshed." if existing else None}


def _gh_apps_write(token: str, login: str) -> Optional[str]:
    """Point Copilot clients that read apps.json (Neovim, JetBrains, Xcode, Zed…) at this account.
    Only touched when that file already exists — i.e. one of those clients is set up here."""
    if not GH_APPS.exists():
        return None
    try:
        cur = json.loads(GH_APPS.read_text() or "{}")
    except Exception:
        cur = {}
    _write(f"backups/copilot-apps-{time.strftime('%Y%m%d-%H%M%S')}.json", cur)
    key = next((k for k in cur if k.startswith("github.com")), f"github.com:{GH_CLIENT_ID}")
    cur = {k: v for k, v in cur.items() if not k.startswith("github.com")}
    cur[key] = {"user": login, "oauth_token": token, "githubAppId": GH_CLIENT_ID}
    fd = os.open(str(GH_APPS) + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(cur, fh, indent=2)
    os.replace(str(GH_APPS) + ".tmp", str(GH_APPS))
    return str(GH_APPS)


def gh_use(key: str, *, reason: str = "manual") -> dict:
    with _locked():
        store = load_store()
        t = _find(store, "copilot", key)
        if not t:
            return {"ok": False, "error": f'No Copilot account matches "{key}".'}
        prev = next((a for a in store["copilot"] if a["id"] == store.get("gh_selected")), None)
        if prev and prev["id"] == t["id"]:
            return {"ok": True, "id": t["id"], "label": t["label"], "unchanged": True}
        store["gh_selected"] = t["id"]
        save_store(store)
    wrote = _gh_apps_write(t["token"], t.get("login") or "")
    _event("auto_switch" if reason == "auto" else "manual_switch",
           f"Copilot switched {prev['label'] + ' → ' if prev else 'to '}{t['label']}", provider="copilot",
           from_id=(prev or {}).get("id"), to_id=t["id"])
    return {"ok": True, "id": t["id"], "label": t["label"], "from": (prev or {}).get("label"), "written_to": wrote,
            "note": ("Copilot clients that use ~/.config/github-copilot pick it up on restart." if wrote else
                     "Selected. In VS Code, Copilot switches through VS Code's account picker.")}


# ─── shared surface ───────────────────────────────────────────────────────────────────────────

def remove(provider: str, key: str) -> dict:
    with _locked():
        store = load_store()
        a = _find(store, provider, key)
        if not a:
            return {"ok": False, "error": f'No {META[provider]["name"]} account matches "{key}".'}
        if provider == "antigravity":
            blob, _ = ag_slot_read()
            live, _c = _ag_upsert_from_slot(json.loads(json.dumps(store)), blob) if blob else (None, False)
            if live and live["id"] == a["id"]:
                return {"ok": False, "error": "Antigravity is using that account. Switch to another one first."}
        store[provider] = [x for x in store[provider] if x["id"] != a["id"]]
        if store.get("gh_selected") == a["id"]:
            store["gh_selected"] = store["copilot"][0]["id"] if store["copilot"] else None
        save_store(store)
    _event("removed", f"Removed {META[provider]['name']} · {a['label']}", provider=provider)
    return {"ok": True}


def login_start(provider: str, label: str = "") -> dict:
    if provider == "antigravity":
        return ag_login_start(label)
    if provider == "copilot":
        return gh_login_start(label)
    return {"ok": False, "error": f"unknown provider {provider}"}


def use(provider: str, key: str, *, reason: str = "manual", threshold: Optional[int] = None) -> dict:
    res = ag_use(key, reason=reason) if provider == "antigravity" else gh_use(key, reason=reason)
    if res.get("ok") and reason != "auto" and threshold:
        # a manual switch onto an account that is already hot pins it until that window resets
        e = _usage_cache_get(res["id"], 10 ** 9) or {}
        windows = (e.get("data") or {}).get("windows") or {}
        peak, pk = _peak(windows)
        until = pin_if_hot(provider, {"id": res["id"], "peak_pct": peak, "peak_window": pk,
                                      "usage": {"windows": windows}}, threshold)
        if until:
            res["warning"] = (f"{res['label']} is already over the auto-switch threshold — auto-switch leaves it alone until "
                              f"{time.strftime('%a %H:%M', time.localtime(until))}.")
    return res


def _row(provider: str, a: dict, usage_e: Optional[dict], *, live: bool, settings: dict) -> dict:
    data = (usage_e or {}).get("data") or {}
    windows = data.get("windows") or {}
    watch = (settings.get("provider_windows") or {}).get(provider)
    peak, pk = _peak(windows, watch)
    return {"id": a["id"], "provider": provider, "label": a.get("label"), "email": a.get("email"),
            "login": a.get("login"), "name": a.get("name") or a.get("login"), "picture": a.get("picture"),
            "plan": data.get("plan") or a.get("plan"), "kind": "saved", "saved": True, "live": live, "active": live,
            "switchable": not a.get("auth_error"), "usage": {"windows": windows, "unlimited": data.get("unlimited") or []},
            "usage_error": a.get("auth_error") or (usage_e or {}).get("error"), "usage_at": (usage_e or {}).get("at_data"),
            "peak_pct": peak, "peak_window": pk, "status": "expired" if a.get("auth_error") else "ok"}


def forget_usage(account_id: str) -> bool:
    """Drop one account's cached reading so the next snapshot fetches it again (per-account refresh)."""
    with _locked():
        c = _read(USAGE, {})
        if isinstance(c, dict) and account_id in c:
            c.pop(account_id, None)
            _write(USAGE, c)
            return True
    return False


def snapshot(settings: dict, *, force: bool = False) -> Dict[str, Any]:
    max_age = 15 if force else max(30, int(settings.get("poll_seconds") or 180) - 5)
    out: Dict[str, Any] = {}
    with _locked():
        store = load_store()
        before = json.dumps(store, sort_keys=True, default=str)
        live_ag, ag_src = ag_sync_live(store) if _is_mac() else (None, "unsupported")
        dirty_store = json.dumps(store, sort_keys=True, default=str)
        if dirty_store != before:
            save_store(store)
    # Antigravity
    ag_rows = []
    for a in store["antigravity"]:
        e = _usage_cache_get(a["id"], max_age)
        if e is None:
            tok = _ag_refresh(a)
            if tok:
                if not a.get("name") or not a.get("picture"):
                    a.update({k: v for k, v in _ag_identity(tok).items() if v and not a.get(k)})
                data, err = _ag_usage(tok)
            else:
                data, err = None, a.get("auth_error") or "Couldn't refresh this login"
            e = _usage_cache_put(a["id"], data, err)
        ag_rows.append(_row("antigravity", a, e, live=bool(live_ag and live_ag["id"] == a["id"]), settings=settings))
    # Copilot
    gh_rows = []
    for a in store["copilot"]:
        e = _usage_cache_get(a["id"], max_age)
        if e is None:
            data, err, _raw = gh_usage(a.get("token") or "")
            if err and "signed this account out" in err:
                a["auth_error"] = err
            e = _usage_cache_put(a["id"], data, err)
        gh_rows.append(_row("copilot", a, e, live=store.get("gh_selected") == a["id"], settings=settings))
    if json.dumps(store, sort_keys=True, default=str) != dirty_store:
        with _locked():
            fresh = load_store()
            by_id = {a["id"]: a for p in ("antigravity", "copilot") for a in store[p]}
            for p in ("antigravity", "copilot"):
                fresh[p] = [{**a, **{k: v for k, v in by_id.get(a["id"], {}).items()
                                     if k in ("access_token", "expires_at", "name", "picture", "auth_error")}} for a in fresh[p]]
            save_store(fresh)
    pins = (_read("state.json", {}).get("provider_pins") or {})
    for r in ag_rows + gh_rows:
        pin = pins.get(r["provider"]) or {}
        if pin.get("id") == r["id"] and float(pin.get("until") or 0) > now():
            r["pinned_until"] = pin["until"]
    auto = settings.get("provider_auto") or {}
    out["antigravity"] = {**META["antigravity"], "available": _is_mac() and bool(ag_client()), "slot": ag_src,
                          "auto_switch": bool(auto.get("antigravity", True)), "accounts": ag_rows,
                          "live_id": (live_ag or {}).get("id"),
                          "note": None if _is_mac() else "Switching needs macOS"}
    out["copilot"] = {**META["copilot"], "available": True, "slot": "apps.json" if GH_APPS.exists() else "select",
                      "auto_switch": bool(auto.get("copilot", True)), "accounts": gh_rows,
                      "live_id": store.get("gh_selected")}
    return out


def check(settings: dict, snap: Dict[str, Any]) -> List[dict]:
    """Auto-switch pass for Antigravity and Copilot. Same rule as Claude: when the live account's peak
    usage reaches the threshold, move to the least-used saved account that is still below it."""
    actions = []
    if not settings.get("auto_switch"):
        return actions
    thr = settings["threshold"]
    st = _read("state.json", {})
    pins = st.get("provider_pins") or {}
    hot_for = st.get("provider_all_hot") or {}
    for p, info in snap.items():
        if not info.get("auto_switch") or not info.get("available"):
            continue
        live = next((a for a in info["accounts"] if a["live"]), None)
        pin = pins.get(p) or {}
        if not live or (pin.get("id") == live["id"] and float(pin.get("until") or 0) > now()):
            continue
        if live["peak_pct"] is None or live["peak_pct"] < thr:
            hot_for.pop(p, None)
            continue
        cands = [a for a in info["accounts"] if not a["live"] and a["switchable"] and a["peak_pct"] is not None and a["peak_pct"] < thr]
        if not cands:
            if hot_for.get(p) != live["id"]:
                _event("all_hot", f"{info['name']}: {live['label']} is at {live['peak_pct']:.0f}% and no other account is below {thr}%.", provider=p)
                hot_for[p] = live["id"]
            continue
        best = min(cands, key=lambda a: a["peak_pct"])
        res = use(p, best["id"], reason="auto")
        actions.append({"provider": p, **res})
    st = _read("state.json", {})
    st["provider_all_hot"] = hot_for
    _write("state.json", st)
    return actions


def pin_if_hot(provider: str, row: dict, thr: int) -> Optional[float]:
    st = _read("state.json", {})
    pins = st.get("provider_pins") or {}
    until = None
    if row.get("peak_pct") is not None and row["peak_pct"] >= thr:
        w = ((row.get("usage") or {}).get("windows") or {}).get(row.get("peak_window")) or {}
        until = w.get("resets_at") or now() + 3600
        pins[provider] = {"id": row["id"], "until": until}
    else:
        pins.pop(provider, None)
    st["provider_pins"] = pins
    _write("state.json", st)
    return until


if __name__ == "__main__":  # detached login helpers
    if len(sys.argv) >= 3 and sys.argv[1] == "_ag-callback":
        _ag_callback_server(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == "_gh-poll":
        _gh_poll(sys.argv[2])
    else:
        print(__doc__)
