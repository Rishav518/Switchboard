"""Claude Accounts backend — mounted at /api/plugins/claude-accounts/ in the gateway process."""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter

_CORE_NAME = "claude_accounts_core"


def _core():
    mod = sys.modules.get(_CORE_NAME)
    if mod is None:
        path = Path(__file__).resolve().parent.parent / "claude_accounts_core.py"
        spec = importlib.util.spec_from_file_location(_CORE_NAME, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[_CORE_NAME] = mod
        spec.loader.exec_module(mod)
        mod._loaded_mtime = path.stat().st_mtime
    return mod


core = _core()
core.ensure_watchdog()

router = APIRouter()


def _run(fn, *a, **kw):
    return asyncio.to_thread(fn, *a, **kw)


@router.get("/state")
async def state():
    core.ensure_watchdog()
    return await _run(core.snapshot)


@router.post("/refresh")
async def refresh():
    await _run(core.check, force=True, reason="manual")
    if hasattr(core, "providers_check"):
        try:
            await _run(core.providers_check, force=True)
        except Exception:
            pass
    return await _run(core.snapshot)


@router.post("/settings")
async def settings(body: dict):
    saved = await _run(core.save_settings, body or {})
    return {"ok": True, "settings": saved}


@router.post("/switch")
async def switch(body: dict):
    return await _run(core.switch_to, str((body or {}).get("id") or ""))


@router.post("/clear")
async def clear(body: dict):
    return await _run(core.clear_bench, str((body or {}).get("id") or ""))


@router.post("/remove")
async def remove(body: dict):
    return await _run(core.remove_account, str((body or {}).get("id") or ""))


@router.post("/login/start")
async def login_start(body: dict):
    return await _run(core.login_start, str((body or {}).get("label") or ""))


@router.post("/login/finish")
async def login_finish(body: dict):
    b = body or {}
    return await _run(core.login_finish, str(b.get("login_id") or ""), str(b.get("code") or ""),
                      str(b.get("label") or ""))


# ─── Antigravity + GitHub Copilot ─────────────────────────────────────────────────────────────

@router.post("/providers/login/start")
async def provider_login_start(body: dict):
    b = body or {}
    return await _run(core.provider_login_start, str(b.get("provider") or ""), str(b.get("label") or ""))


@router.post("/providers/login/status")
async def provider_login_status(body: dict):
    return await _run(core.provider_login_status, str((body or {}).get("login_id") or ""))


@router.post("/providers/login/cancel")
async def provider_login_cancel(body: dict):
    return await _run(core.provider_login_cancel, str((body or {}).get("login_id") or ""))


@router.post("/providers/use")
async def provider_use(body: dict):
    b = body or {}
    return await _run(core.provider_use, str(b.get("provider") or ""), str(b.get("id") or ""))


@router.post("/providers/remove")
async def provider_remove(body: dict):
    b = body or {}
    return await _run(core.provider_remove, str(b.get("provider") or ""), str(b.get("id") or ""))
