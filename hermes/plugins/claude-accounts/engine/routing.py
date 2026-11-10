#!/usr/bin/env python3
"""routing.py — model routing per agent for claude-accounts (Claude Code + Hermes), stdlib only.

Three tiers, each mapped to a model:
    fast      small, well-defined tasks (find/read/grep, summaries, one-file edits, run & report)
    balanced  standard implementation (multi-file features with a plan, tests, refactors)
    deep      hard thinking (architecture, ambiguous debugging, security/perf review, big plans)

Claude Code: writes three user-level sub-agents to ~/.claude/agents/ (fast-worker, builder, architect)
with `model:` set per tier. Claude Code's main agent delegates to them by their descriptions. Only
files carrying the `managed-by: ai-accounts` marker are ever rewritten or removed. Optionally sets
Claude Code's main model (e.g. `opusplan` = Opus plans, Sonnet executes).

Hermes: applied by the Hermes plugin through the official advanced-delegation plugin
(delegation.backend = model_map, one route per tier) — see claude_accounts_core.py.

Delegation log: every Agent/Task call in recent Claude Code transcripts, with the model it actually
ran on (Claude Code records `resolvedModel`), its status and tokens.

Save quota: when the live Claude account is over the auto-switch threshold and no other account is
below it, every tier drops one step (deep→balanced model, balanced→fast) until usage recovers.
"""
from __future__ import annotations

import glob
import json
import os
import re
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HOME = Path(os.environ.get("CLAUDE_ACCOUNTS_HOME", str(Path.home() / ".claude-accounts")))
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
MARK = "managed-by: ai-accounts"

TIERS = ("fast", "balanced", "deep")
TIER_META = {
    "fast": {"label": "Fast", "agent": "fast-worker",
             "blurb": "Lookups, file search, summaries, small edits"},
    "balanced": {"label": "Balanced", "agent": "builder",
                 "blurb": "Features with a clear plan, tests, refactors"},
    "deep": {"label": "Deep", "agent": "architect",
             "blurb": "Architecture, hard debugging, reviews, planning"},
}
ALIASES = ("haiku", "sonnet", "opus")
FALLBACK_IDS = {"haiku": "claude-haiku-4-5-20251001", "sonnet": "claude-sonnet-4-6", "opus": "claude-opus-4-6"}
DEFAULTS: Dict[str, Any] = {
    "enabled": True,
    "tiers": {"fast": "haiku", "balanced": "sonnet", "deep": "opus"},
    "claude_code_agents": True,
    "claude_code_main": "default",      # default | opusplan | opus | sonnet | haiku
    "hermes": True,
    "save_quota": True,
}
MAIN_CHOICES = ("default", "opusplan", "opus", "sonnet", "haiku")

AGENT_BODIES = {
    "fast": """You are a fast, focused helper for small, well-defined tasks.

Do exactly the task you were given, nothing more:
- find files, symbols or usages; read code and answer a specific question
- summarize logs, docs, diffs or command output
- make a small, clearly specified edit (one file, a few lines)
- run a command and report the relevant part of its output

Be brief. Report concrete findings (paths, line numbers, exact values). If the task turns out to
need design decisions or broad changes, stop and say so instead of guessing.""",
    "balanced": """You are a careful implementer for standard engineering work with a clear goal.

- implement features across several files when the approach is already decided
- write and fix tests, refactor without changing behavior, fix well-understood bugs
- follow the existing code style and project conventions; run the tests/linters you touch

Finish with a short summary: what changed (files), how you verified it, anything left open.""",
    "deep": """You are a senior engineer for problems that need deep reasoning.

- architecture and system design, choosing between approaches, planning large changes
- ambiguous or hard debugging: form hypotheses, gather evidence, find the root cause
- security, correctness and performance reviews

Think before acting. Read enough of the code to be sure. State assumptions and trade-offs, then give
a clear recommendation or a step-by-step plan. Prefer correctness over speed.""",
}
AGENT_DESCRIPTIONS = {
    "fast": ("Use PROACTIVELY for small, well-defined tasks: finding files or usages, reading code to answer a "
             "specific question, summarizing logs/docs/output, one-file edits, running a command and reporting "
             "the result. Cheap and quick — prefer it over doing such chores yourself."),
    "balanced": ("Use for standard implementation work with a clear plan: multi-file features, writing or fixing "
                 "tests, refactors, fixing well-understood bugs."),
    "deep": ("Use for tasks that need deep reasoning: architecture and system design, ambiguous or hard "
             "debugging, security/performance reviews, planning large or risky changes."),
}


# ─── tiny utils ───────────────────────────────────────────────────────────────────────────────

def now() -> float:
    return time.time()


def _read(name: str, default: Any) -> Any:
    try:
        return json.loads((HOME / name).read_text("utf-8"))
    except Exception:
        return default


def _write(name: str, data: Any) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    p = HOME / name
    tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=2)
    os.replace(str(tmp), str(p))


def _ts(v: Any) -> Optional[float]:
    if not v:
        return None
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None


def family(model: Optional[str]) -> Optional[str]:
    m = (model or "").lower()
    return next((a for a in ALIASES if a in m), None)


def pretty_model(model: Optional[str]) -> str:
    """claude-haiku-5-5 → Haiku 5.5, opus → Opus."""
    m = (model or "").strip()
    if not m or m == "inherit":
        return "Main model"
    if m in ALIASES:
        return m.title()
    mm = re.match(r"claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$", m)
    if mm:
        return f"{mm.group(1).title()} {mm.group(2)}{'.' + mm.group(3) if mm.group(3) else ''}"
    return m


def tier_of(model: Optional[str], cfg: Optional[dict] = None) -> Optional[str]:
    f = family(model)
    if not f:
        return None
    tiers = (cfg or load())["tiers"]
    return next((t for t in TIERS if tiers.get(t) == f), {"haiku": "fast", "sonnet": "balanced", "opus": "deep"}[f])


# ─── config ───────────────────────────────────────────────────────────────────────────────────

def load() -> Dict[str, Any]:
    raw = _read("routing.json", {})
    cfg = json.loads(json.dumps(DEFAULTS))
    if isinstance(raw, dict):
        for k in DEFAULTS:
            if k in raw:
                cfg[k] = raw[k]
    t = cfg.get("tiers") if isinstance(cfg.get("tiers"), dict) else {}
    cfg["tiers"] = {k: (t.get(k) if t.get(k) in ALIASES else DEFAULTS["tiers"][k]) for k in TIERS}
    if cfg.get("claude_code_main") not in MAIN_CHOICES:
        cfg["claude_code_main"] = "default"
    for k in ("enabled", "claude_code_agents", "hermes", "save_quota"):
        cfg[k] = bool(cfg.get(k))
    return cfg


def save(patch: Dict[str, Any]) -> Dict[str, Any]:
    cfg = load()
    for k, v in (patch or {}).items():
        if k.startswith("tiers."):                       # CLI form: tiers.fast=haiku
            k, v = "tiers", {k.split(".", 1)[1]: v}
        if k == "tiers" and isinstance(v, dict):
            cfg["tiers"] = {**cfg["tiers"], **{kk: vv for kk, vv in v.items() if kk in TIERS and vv in ALIASES}}
        elif k in ("enabled", "claude_code_agents", "hermes", "save_quota"):
            cfg[k] = v if isinstance(v, bool) else str(v).lower() in ("1", "on", "true", "yes")
        elif k == "claude_code_main" and v in MAIN_CHOICES:
            cfg[k] = v
    _write("routing.json", {k: cfg[k] for k in DEFAULTS})
    apply_claude_code(cfg)
    return load()


# ─── live model ids (for Hermes routes and labels) ────────────────────────────────────────────

def latest_ids(token: Optional[str] = None) -> Dict[str, str]:
    """Newest model id per family the account can use (cached 12 h). Falls back to known ids."""
    c = _read("models-cache.json", {})
    if c.get("ids") and now() - float(c.get("at") or 0) < 12 * 3600:
        return c["ids"]
    ids = dict(FALLBACK_IDS)
    if token:
        try:
            req = urllib.request.Request("https://api.anthropic.com/v1/models?limit=100", headers={
                "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20",
                "anthropic-version": "2023-06-01", "User-Agent": "claude-code/2.1.0"})
            data = json.loads(urllib.request.urlopen(req, timeout=15).read()).get("data") or []
            for fam in ALIASES:   # API lists newest first
                hit = next((m["id"] for m in data if fam in m.get("id", "")), None)
                if hit:
                    ids[fam] = hit
            _write("models-cache.json", {"at": now(), "ids": ids})
        except Exception:
            pass
    return c.get("ids") or ids


# ─── Claude Code: managed sub-agents + main model ─────────────────────────────────────────────

def _agents_dir() -> Path:
    return CLAUDE_DIR / "agents"


def _agent_text(tier: str, model: str) -> str:
    meta = TIER_META[tier]
    return (f"---\nname: {meta['agent']}\ndescription: {json.dumps(AGENT_DESCRIPTIONS[tier], ensure_ascii=False)}\nmodel: {model}\n"
            f"# {MARK} (tier: {tier}) — edit tiers in the Switchboard panel; this file is rewritten\n---\n\n"
            f"{AGENT_BODIES[tier]}\n")


def _dkey(scope: str) -> str:
    return "downgraded" if scope == "claude_code" else f"downgraded_{scope}"


def effective_tiers(cfg: Dict[str, Any], scope: str = "claude_code") -> Dict[str, str]:
    """Tier → model alias after save-quota downgrades (tracked per surface: claude_code / hermes)."""
    tiers = dict(cfg["tiers"])
    if cfg.get("save_quota") and _read("routing-state.json", {}).get(_dkey(scope)):
        order = list(ALIASES)
        tiers = {t: order[max(0, order.index(m) - 1)] for t, m in tiers.items()}
    return tiers


def apply_claude_code(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or load()
    d = _agents_dir()
    want = cfg["enabled"] and cfg["claude_code_agents"]
    tiers = effective_tiers(cfg)
    written, skipped = [], []
    for tier in TIERS:
        p = d / f"{TIER_META[tier]['agent']}.md"
        ours = p.exists() and MARK in p.read_text("utf-8", errors="replace")
        if p.exists() and not ours:
            skipped.append(p.name)            # the user's own agent with the same name — never touch it
            continue
        if want:
            d.mkdir(parents=True, exist_ok=True)
            text = _agent_text(tier, tiers[tier])
            if not ours or p.read_text("utf-8") != text:
                p.write_text(text, "utf-8")
            written.append(p.name)
        elif ours:
            p.unlink()
    main = _apply_main_model(cfg)
    return {"agents": written, "skipped": skipped, "main": main}


def _apply_main_model(cfg: Dict[str, Any]) -> Optional[str]:
    """Claude Code's main model in ~/.claude/settings.json — only a value we set is ever removed."""
    p = CLAUDE_DIR / "settings.json"
    try:
        s = json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        return None
    st = _read("routing-state.json", {})
    want = cfg["claude_code_main"] if cfg["enabled"] else "default"
    cur = s.get("model")
    if want == "default":
        if cur is not None and cur == st.get("main_set"):
            s.pop("model", None)
            st.pop("main_set", None)
        else:
            return cur
    else:
        if cur not in (None, st.get("main_set")) and cur != want:
            return cur   # the user picked a model by hand — leave it
        s["model"] = want
        st["main_set"] = want
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(s, indent=2))
    tmp.replace(p)
    _write("routing-state.json", st)
    return s.get("model")


def agents_status(cfg: Dict[str, Any]) -> List[dict]:
    out, tiers = [], effective_tiers(cfg)
    for tier in TIERS:
        p = _agents_dir() / f"{TIER_META[tier]['agent']}.md"
        txt = p.read_text("utf-8", errors="replace") if p.exists() else ""
        m = re.search(r"^model:\s*(\S+)", txt, re.M)
        out.append({"tier": tier, "agent": TIER_META[tier]["agent"], "installed": MARK in txt,
                    "conflict": bool(txt) and MARK not in txt, "model": m.group(1) if m else tiers[tier]})
    return out


# ─── save quota ───────────────────────────────────────────────────────────────────────────────

def quota_tick(claude_live_peak: Optional[float], others_below: bool, threshold: int,
               scope: str = "claude_code") -> Optional[str]:
    """Called after each auto-switch pass. Returns 'downgraded' / 'restored' when the state flips.
    Each surface (Claude Code, Hermes) judges its own active account, so they never fight."""
    cfg = load()
    st = _read("routing-state.json", {})
    hot = bool(cfg["enabled"] and cfg["save_quota"] and claude_live_peak is not None
               and claude_live_peak >= threshold and not others_below)
    if hot == bool(st.get(_dkey(scope))):
        return None
    st[_dkey(scope)] = hot
    st[f"since_{scope}"] = now()
    _write("routing-state.json", st)
    if scope == "claude_code":
        apply_claude_code(cfg)
    return "downgraded" if hot else "restored"


# ─── delegation log (Claude Code transcripts) ─────────────────────────────────────────────────

def _session_title(lines: List[str]) -> Optional[str]:
    for line in reversed(lines):
        if '"ai-title"' in line or '"summary"' in line:
            try:
                d = json.loads(line)
                return d.get("aiTitle") or d.get("title") or d.get("summary")
            except Exception:
                pass
    return None


def _doing(tool: Optional[str], inp: dict) -> str:
    """Short 'what it is doing now' label from a sub-agent's latest tool call: 'Edit server.py'."""
    arg = inp.get("file_path") or inp.get("path") or inp.get("notebook_path")
    if arg:
        arg = Path(str(arg)).name
    else:
        arg = inp.get("pattern") or inp.get("command") or inp.get("query") or inp.get("url") or inp.get("description") or ""
    arg = " ".join(str(arg).split())
    return f"{tool or 'Working'} {arg[:44]}".strip()


def _agent_ids_by_tool_use(session_dir: Path) -> Dict[str, str]:
    """toolUseId → agentId from the sub-agents' meta files; finds a sub-agent that has not reported back yet."""
    out: Dict[str, str] = {}
    for m in glob.glob(str(session_dir / "subagents" / "agent-*.meta.json")):
        try:
            tid = json.loads(Path(m).read_text()).get("toolUseId")
        except Exception:
            continue
        if tid:
            out[tid] = Path(m).name[len("agent-"):-len(".meta.json")]
    return out


def _sub_info(session_dir: Path, agent_id: str) -> dict:
    """Model, tokens and finished flag from <session>/subagents/agent-<id>.{jsonl,meta.json}."""
    info: Dict[str, Any] = {}
    meta = session_dir / "subagents" / f"agent-{agent_id}.meta.json"
    try:
        m = json.loads(meta.read_text())
        info.update(finished=m.get("finished"), agent_type=m.get("agentType"), meta_model=m.get("model"))
    except Exception:
        pass
    f = session_dir / "subagents" / f"agent-{agent_id}.jsonl"
    try:
        out_tok, model, last, doing, steps = 0, None, None, None, 0
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                msg = d.get("message") or {}
                if msg.get("role") == "assistant":
                    model = msg.get("model") or model
                    out_tok += int((msg.get("usage") or {}).get("output_tokens") or 0)
                    last = _ts(d.get("timestamp")) or last
                    for b in msg.get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            steps += 1
                            doing = _doing(b.get("name"), b.get("input") or {})
        info.update(model=model, tokens_out=out_tok, last_at=last or os.path.getmtime(f), doing=doing, steps=steps)
    except Exception:
        pass
    return info


def claude_code_delegations(limit: int = 40, max_sessions: int = 20, max_age_h: float = 24 * 14) -> List[dict]:
    files = sorted(glob.glob(str(CLAUDE_DIR / "projects" / "*" / "*.jsonl")), key=os.path.getmtime, reverse=True)
    cutoff = now() - max_age_h * 3600
    out: List[dict] = []
    cfg = load()
    for f in files[:max_sessions]:
        if os.path.getmtime(f) < cutoff:
            break
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                lines = [ln for ln in fh if '"Agent"' in ln or '"Task"' in ln or "resolvedModel" in ln
                         or '"ai-title"' in ln or '"summary"' in ln]
        except OSError:
            continue
        uses: Dict[str, dict] = {}
        results: Dict[str, dict] = {}
        for line in lines:
            try:
                d = json.loads(line)
            except Exception:
                continue
            msg = d.get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                for b in content:
                    if b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task"):
                        inp = b.get("input") or {}
                        uses[b["id"]] = {"tool_use_id": b["id"], "at": _ts(d.get("timestamp")),
                                         "description": inp.get("description") or (inp.get("prompt") or "")[:80],
                                         "agent": inp.get("subagent_type") or "general-purpose",
                                         "background": bool(inp.get("run_in_background")),
                                         "parent_model": msg.get("model"), "cwd": d.get("cwd")}
                    elif b.get("type") == "tool_result" and isinstance(d.get("toolUseResult"), dict):
                        results[b.get("tool_use_id")] = d["toolUseResult"]
        if not uses:
            continue
        sess_dir = Path(f[:-6])
        title = _session_title(lines) or Path(f).stem[:8]
        project = Path(next((u["cwd"] for u in uses.values() if u.get("cwd")), "") or "").name
        by_tool = _agent_ids_by_tool_use(sess_dir)
        parent_fresh = os.path.getmtime(f) > now() - 10 * 60
        for tid, u in uses.items():
            r = results.get(tid) or {}
            agent_id = r.get("agentId") or by_tool.get(tid)
            sub = _sub_info(sess_dir, agent_id) if agent_id else {}
            model = r.get("resolvedModel") or sub.get("model") or (sub.get("meta_model") if sub.get("meta_model") not in (None, "inherit") else None) or u["parent_model"]
            status = r.get("status") or ""
            if sub.get("finished") or status in ("completed", "success") or (r and not r.get("isAsync")):
                state = "done"
            elif status in ("error", "failed", "killed", "cancelled"):
                state = "error"
            elif not r:
                # no answer yet: running while the sub-agent (or its parent session) is still writing
                fresh = (sub.get("last_at") or 0) > now() - 15 * 60 if sub.get("last_at") else parent_fresh
                state = "running" if fresh else "unknown"
            else:
                state = "running" if (sub.get("last_at") or u["at"] or 0) > now() - 15 * 60 else "done"
            out.append({"id": agent_id or tid, "source": "claude-code", "at": u["at"], "description": u["description"],
                        "agent": u["agent"], "model": model, "model_label": pretty_model(model),
                        "tier": tier_of(model, cfg), "state": state, "tokens_out": sub.get("tokens_out"),
                        "session": title, "session_id": Path(f).stem, "project": project,
                        "doing": sub.get("doing") if state == "running" else None, "steps": sub.get("steps"),
                        "last_at": sub.get("last_at"),
                        "background": u["background"]})
    out.sort(key=lambda x: -(x["at"] or 0))
    return out[:limit]


# ─── snapshot ─────────────────────────────────────────────────────────────────────────────────

def snapshot(*, delegations: bool = True, scope: str = "claude_code") -> Dict[str, Any]:
    cfg = load()
    st = _read("routing-state.json", {})
    ids = _read("models-cache.json", {}).get("ids") or FALLBACK_IDS
    eff = effective_tiers(cfg, scope)
    tiers = [{"tier": t, **TIER_META[t], "model": cfg["tiers"][t], "effective": eff[t],
              "model_id": ids.get(eff[t]), "model_label": pretty_model(ids.get(eff[t]) or eff[t])} for t in TIERS]
    cs = None
    try:
        cs = json.loads((CLAUDE_DIR / "settings.json").read_text()).get("model")
    except Exception:
        pass
    down = bool(cfg["save_quota"] and st.get(_dkey(scope)))
    return {"config": cfg, "tiers": tiers, "agents": agents_status(cfg), "downgraded": down, "scope": scope,
            "downgraded_since": st.get(f"since_{scope}") if down else None, "claude_code_model": cs,
            "main_choices": list(MAIN_CHOICES), "delegations": claude_code_delegations() if delegations else []}


if __name__ == "__main__":
    print(json.dumps(snapshot(), indent=2, default=str)[:4000])
