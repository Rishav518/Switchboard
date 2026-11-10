/**
 * Switchboard (claude-accounts) — right-sidebar pane for Hermes desktop.
 *
 * Claude: every login in Hermes' `anthropic` credential pool with live 5h / weekly usage, the focused
 * chat's context window, live chats and auto-switch (bench an account at N% → next one).
 * Antigravity + GitHub Copilot: multiple accounts each, usage per account, one-click / automatic
 * switching (shared engine in ~/.claude-accounts, same accounts as the VS Code extension).
 *
 * Backend: ../plugins/claude-accounts/dashboard/plugin_api.py → ctx.rest('/state' | '/switch' | '/providers/…')
 * Plain ESM, loaded uncompiled — jsx() calls only. Imports limited to the SDK + react.
 * CSS + icons are injected by tools/build.py between the /*@@…*\/ markers (source: ui/).
 */
import {
  Codicon,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
  Tip,
  haptic,
  host,
  queryClient,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

/*@@ICONS*/
const ICONS = {
  claude: '<svg viewBox="0 0 24 24" fill="#D97757" aria-hidden="true"><path d="M12 2.4l1.55 6.2 5.6-3.15-3.15 5.6 6.2 1.55-6.2 1.55 3.15 5.6-5.6-3.15L12 21.6l-1.55-6.2-5.6 3.15 3.15-5.6L1.8 12l6.2-1.55-3.15-5.6 5.6 3.15z"/></svg>',
  antigravity: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.7" stroke-linecap="round" aria-hidden="true"><path d="M3 20.2c2.3-.3 3.7-2.2 4.8-5.4" stroke="#34a853"/><path d="M7.8 14.8 10 8.5C10.6 6.9 11.2 6 12 6" stroke="#4285f4"/><path d="M12 6c.8 0 1.4.9 2 2.5l2.2 6.3" stroke="#a142f4"/><path d="M16.2 14.8c1.1 3.2 2.5 5.1 4.8 5.4" stroke="#ea4335"/></svg>',
  copilot: '<svg viewBox="0 0 24 24" fill="none" stroke="#a371f7" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 13.2v-2.4C4.2 7.2 7 4.8 12 4.8s7.8 2.4 7.8 6v2.4"/><path d="M2.8 13.4c0 2.8 4 5.6 9.2 5.6s9.2-2.8 9.2-5.6"/><rect x="6.4" y="9.1" width="4.3" height="3.8" rx="1.7"/><rect x="13.3" y="9.1" width="4.3" height="3.8" rx="1.7"/><path d="M10.6 15.6h2.8"/></svg>',
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h4l2-5 2 10 2-5h4"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  sync: '<svg class="ca-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.6 15 14H1zM7.3 6v4h1.4V6zm0 5v1.4h1.4V11z"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8v.1" stroke-linecap="round"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/></svg>',
  swap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 3.5v-.2A1.3 1.3 0 0 0 9.2 2H3.3A1.3 1.3 0 0 0 2 3.3v5.9a1.3 1.3 0 0 0 1.3 1.3h.2"/></svg>',
  external: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx="1"/><rect x="9.4" y="3" width="2.6" height="10" rx="1"/></svg>',
  route: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="3.5" cy="3.5" r="1.8"/><circle cx="12.5" cy="12.5" r="1.8"/><path d="M5.3 3.5H10a2.5 2.5 0 0 1 0 5H6a2.5 2.5 0 0 0 0 5h4.7"/></svg>',
  dot: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>'
}
const PROVIDERS = [
  { id: 'claude', name: 'Claude', vendor: 'Anthropic', blurb: 'Pro, Max or Team — sign in on claude.ai' },
  { id: 'antigravity', name: 'Antigravity', vendor: 'Google', blurb: 'Google sign-in — app, agy CLI & VS Code' },
  { id: 'copilot', name: 'GitHub Copilot', vendor: 'GitHub', blurb: 'GitHub device code — premium requests' }
]
const PCOLOR = { claude: 'var(--p-claude)', antigravity: 'var(--p-antigravity)', copilot: 'var(--p-copilot)' }
const TCOLOR = { fast: 'var(--t-fast)', balanced: 'var(--t-balanced)', deep: 'var(--t-deep)' }
const MODEL_CHOICES = [['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']]
const MAIN_LABELS = { default: 'Default', opusplan: 'Opus plan', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
/*@@END_ICONS*/

const ID = 'claude-accounts'
const QK = [ID, 'state']
let CTX = null
let TAB = 'all'

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

const rest = (path, opts) => CTX.rest(path, opts)
const post = (path, body) => rest(path, { method: 'POST', body: body || {} })
const refetch = () => queryClient.invalidateQueries({ queryKey: QK })
// Provider actions: dedicated routes, falling back to the original routes ("<provider>::<id>") when the
// running gateway mounted this plugin's API before those routes existed (hot reload without restart).
const PROUTES = {
  use: [b => post('/providers/use', b), b => post('/switch', { id: `${b.provider}::${b.id}` })],
  remove: [b => post('/providers/remove', b), b => post('/remove', { id: `${b.provider}::${b.id}` })],
  start: [b => post('/providers/login/start', b), b => post('/login/start', { label: `${b.provider}::${b.label || ''}` })],
  status: [b => post('/providers/login/status', b), b => post('/login/finish', { login_id: b.login_id, code: '::status' })],
  cancel: [b => post('/providers/login/cancel', b), b => post('/login/finish', { login_id: b.login_id, code: '::cancel' })]
}
let legacyRoutes = false
async function pcall(kind, body) {
  if (!legacyRoutes) {
    try {
      return await PROUTES[kind][0](body)
    } catch (e) {
      const m = errMsg(e)
      if (!/404|not found/i.test(m)) throw e
      legacyRoutes = true
    }
  }
  return PROUTES[kind][1](body)
}
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function fmtK(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k'
  return String(Math.round(n))
}
const pct = n => (n == null ? '—' : `${Math.round(n)}%`)
function inFuture(ts) {
  if (!ts) return ''
  const s = Math.max(0, Math.round(ts - Date.now() / 1000))
  if (s < 60) return 'in <1m'
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d >= 1) return `in ${d}d ${h % 24}h`
  if (h >= 1) return `in ${h}h ${m % 60}m`
  return `in ${m}m`
}
function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
function clock(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`
}
function tone(p, threshold) {
  if (p == null) return 'muted'
  if (p >= threshold) return 'bad'
  if (p >= Math.min(70, threshold - 10)) return 'warn'
  return 'good'
}
// Claude rows carry a `profile`; Antigravity/Copilot rows are flat.
function displayName(a) {
  const p = (a && a.profile) || {}
  return p.email || p.name || (a && (a.email || a.login || a.name || a.label || a.id)) || 'Unknown'
}
function initials(a) {
  const p = (a && a.profile) || {}
  const src = (p.name || p.email || (a && (a.name || a.email || a.login || a.label)) || '?').replace(/@.*/, '')
  const parts = src.split(/[\s._-]+/).filter(Boolean)
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase()
}
const HUES = [212, 152, 28, 276, 344, 52, 188, 104]
let hueMap = {}
const acctKey = (a, p) => (p || a.provider || 'claude') + ':' + String((a && a.profile && a.profile.account_uuid) || (a && a.id) || '')
function assignHues(d) {
  const keys = [...(d.accounts || []).map(a => acctKey(a, 'claude')), ...Object.entries(d.providers || {}).flatMap(([p, i]) => (i.accounts || []).map(a => acctKey(a, p)))].sort()
  hueMap = Object.fromEntries(keys.map((k, i) => [k, HUES[i % HUES.length]]))
}
const hue = (a, p) => hueMap[acctKey(a, p)] ?? HUES[0]
const isFocused = (s, sid, stored) => {
  const ids = [s.sid, s.stored_id].filter(Boolean)
  return (sid && ids.includes(sid)) || (stored && ids.includes(stored))
}
const errMsg = e => (e && (e.message || e.detail || e.error)) || String(e)
const meta = p => PROVIDERS.find(x => x.id === p) || PROVIDERS[0]
const presentProviders = d =>
  d ? ['claude', 'antigravity', 'copilot'].filter(p => (p === 'claude' ? d.accounts || [] : ((d.providers || {})[p] || { accounts: [] }).accounts || []).length) : []
const sortActiveFirst = list => list.map((a, i) => [a, i]).sort((x, y) => (y[0].active || y[0].live ? 1 : 0) - (x[0].active || x[0].live ? 1 : 0) || x[1] - y[1]).map(x => x[0])

const Svg = ({ name, className, style }) => jsx('span', { className: 'ca-ic' + (className ? ' ' + className : ''), style, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: ICONS[name] || '' } })
const Logo = ({ p, sm }) => jsx('span', { className: 'ca-logo' + (sm ? ' sm' : ''), style: { '--pc': PCOLOR[p] }, dangerouslySetInnerHTML: { __html: ICONS[p] } })

// ─── shared switch state (optimistic update + animations) ─────────────────────────────────────

const switchStore = { value: null, subs: new Set() }
function setSwitch(v) {
  switchStore.value = v
  switchStore.subs.forEach(f => f())
}
function useSwitch() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force(x => x + 1)
    switchStore.subs.add(f)
    return () => switchStore.subs.delete(f)
  }, [])
  return switchStore.value
}

function finishSwitchLater(id, provider) {
  if (!CTX) return
  CTX.setTimeout(() => {
    const v = switchStore.value
    if (v && v.id === id && v.provider === provider && v.phase === 'done') setSwitch(null)
  }, 4500)
}

async function doSwitch(a) {
  haptic('tap')
  const prev = queryClient.getQueryData ? queryClient.getQueryData(QK) : null
  setSwitch({ provider: 'claude', id: a.id, name: displayName(a), phase: 'pending', at: Date.now() })
  // Optimistic: the card glides to the top and "This chat" updates at once; the server confirms below.
  if (queryClient.setQueryData) {
    queryClient.setQueryData(QK, d => (d && d.accounts ? { ...d, active_id: a.id, pending_target_id: a.id, accounts: d.accounts.map(x => ({ ...x, active: x.id === a.id })) } : d))
  }
  try {
    const res = await post('/switch', { id: a.id })
    if (!res || res.ok === false) throw new Error((res && res.error) || 'Switch failed')
    setSwitch({ provider: 'claude', id: a.id, name: displayName(a), phase: 'done', at: Date.now(), moved: res.moved || 0 })
    if (res.warning) host.notify({ kind: 'warning', message: res.warning })
    refetch()
    if (CTX) {
      CTX.setTimeout(refetch, 2500) // idle chats move at once; a chat mid-reply moves when it finishes
      CTX.setTimeout(refetch, 17000)
    }
    finishSwitchLater(a.id, 'claude')
  } catch (e) {
    if (prev && queryClient.setQueryData) queryClient.setQueryData(QK, prev)
    setSwitch(null)
    host.notify({ kind: 'error', message: errMsg(e) })
    refetch()
  }
}

async function doUseProvider(p, a) {
  haptic('tap')
  const prev = queryClient.getQueryData ? queryClient.getQueryData(QK) : null
  setSwitch({ provider: p, id: a.id, name: displayName(a), phase: 'pending', at: Date.now() })
  if (queryClient.setQueryData) {
    queryClient.setQueryData(QK, d => {
      if (!d || !d.providers || !d.providers[p]) return d
      const info = d.providers[p]
      return { ...d, providers: { ...d.providers, [p]: { ...info, live_id: a.id, accounts: info.accounts.map(x => ({ ...x, live: x.id === a.id, active: x.id === a.id })) } } }
    })
  }
  try {
    const res = await pcall('use', { provider: p, id: a.id })
    if (!res || res.ok === false) throw new Error((res && res.error) || 'Switch failed')
    setSwitch({ provider: p, id: a.id, name: displayName(a), phase: 'done', at: Date.now() })
    if (res.warning) host.notify({ kind: 'warning', message: res.warning })
    if (res.note && !res.unchanged) host.notify({ kind: 'info', title: meta(p).name, message: res.note })
    refetch()
    finishSwitchLater(a.id, p)
  } catch (e) {
    if (prev && queryClient.setQueryData) queryClient.setQueryData(QK, prev)
    setSwitch(null)
    host.notify({ kind: 'error', message: errMsg(e) })
    refetch()
  }
}

async function act(fn, okMsg) {
  try {
    const res = await fn()
    if (res && res.ok === false) throw new Error(res.error || 'Failed')
    if (okMsg) host.notify({ kind: 'success', message: okMsg })
    if (res && res.warning) host.notify({ kind: 'warning', message: res.warning })
    refetch()
    return res
  } catch (e) {
    host.notify({ kind: 'error', message: errMsg(e) })
    throw e
  }
}

async function openUrl(url) {
  const opened = CTX && CTX.os && CTX.os.openExternal ? await CTX.os.openExternal(url) : false
  if (!opened) window.open(url, '_blank')
}
async function copyText(t) {
  try {
    if (CTX && CTX.os && CTX.os.writeClipboard && (await CTX.os.writeClipboard(t)) !== false) return true
    await navigator.clipboard.writeText(t)
    return true
  } catch {
    return false
  }
}

// FLIP: cards glide to their new slot (e.g. the newly active account moving to the top).
function useFlip(ref) {
  const prev = useRef({})
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const scroller = box.closest('.ca') || box
    const top0 = scroller.getBoundingClientRect().top - scroller.scrollTop
    const next = {}
    box.querySelectorAll('[data-flip]').forEach(n => {
      const r = n.getBoundingClientRect()
      next[n.dataset.flip] = { x: r.left, y: r.top - top0 }
      const b = prev.current[n.dataset.flip]
      if (b && !reducedMotion() && n.animate) {
        const dx = b.x - r.left, dy = b.y - (r.top - top0)
        if (Math.abs(dy) > 2 || Math.abs(dx) > 2) n.animate([{ transform: `translate(${dx}px,${dy}px)`, zIndex: 2 }, { transform: 'none', zIndex: 2 }], { duration: 560, easing: 'cubic-bezier(.2,.85,.25,1.08)' })
      }
    })
    prev.current = next
  })
}

// ─── styles ───────────────────────────────────────────────────────────────────────────────────

/*@@CSS*/
const CSS_SHARED = `
.ca{--ca-good:var(--ui-green,#3fb950);--ca-warn:var(--ui-yellow,#d29922);--ca-bad:var(--ui-red,#f85149);
  --ca-accent:var(--ui-accent,#4c8dff);--ca-line:var(--ui-stroke-secondary,rgba(127,127,127,.25));
  --ca-line2:var(--ui-stroke-tertiary,rgba(127,127,127,.15));--ca-t1:var(--ui-text-primary,inherit);
  --ca-t2:var(--ui-text-secondary,inherit);--ca-t3:var(--ui-text-tertiary,inherit);--ca-t4:var(--ui-text-quaternary,var(--ca-t3));
  --ca-bg:var(--ui-bg-editor,var(--ui-bg-sidebar,#16161a));--ca-menu-bg:var(--ui-bg-popover,var(--ui-bg-editor,#1c1c21));
  --ca-mono:var(--font-mono,ui-monospace,monospace)}
/* ── Switchboard — shared design (Hermes pane + VS Code panel). Theme comes in through --ca-* vars. ── */
.ca{--ca-green:#22c55e;--ca-green-2:#16a34a;--ca-green-ink:#03140a;
  --p-claude:#d97757;--p-antigravity:#4c8dff;--p-copilot:#a371f7;
  --t-fast:#14b8a6;--t-balanced:#3b82f6;--t-deep:#a855f7;
  --ca-card:color-mix(in oklab,var(--ca-t1) 4%,transparent);--ca-card-2:color-mix(in oklab,var(--ca-t1) 2%,transparent);
  --ca-glass:linear-gradient(180deg,color-mix(in oklab,var(--ca-t1) 5.5%,transparent),color-mix(in oklab,var(--ca-t1) 2.2%,transparent));
  --ca-r:12px;--ca-ease:cubic-bezier(.2,.8,.2,1);--ca-spring:cubic-bezier(.2,.9,.25,1.15);
  height:100%;overflow-y:auto;overflow-x:hidden;padding:12px 12px 22px;display:flex;flex-direction:column;gap:14px;
  font-size:12px;line-height:1.4;color:var(--ca-t1);scrollbar-width:thin}
.ca *{box-sizing:border-box}
.ca>*{flex-shrink:0}  /* scroll container: never squash children (overflow-x:auto ones collapse to 0) */
.ca button{font:inherit}
.ca-root{height:100%;container-type:inline-size;container-name:ca;position:relative}

/* header */
.ca-head{display:flex;align-items:center;gap:6px;position:relative}
.ca-brand{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
.ca-brand .ca-mark{width:26px;height:26px;border-radius:8px;flex:none;display:grid;place-items:center;color:var(--ca-green);
  background:color-mix(in oklab,var(--ca-green) 12%,transparent);border:1px solid color-mix(in oklab,var(--ca-green) 28%,transparent)}
.ca-brand .ca-mark i{display:grid;place-items:center}
.ca-brand .ca-mark svg{width:14px;height:14px}
.ca-brand>div{min-width:0;display:flex;flex-direction:column}
.ca-brand b{font-size:13.5px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;color:var(--ca-t1)}
.ca-brand small{font-size:10.5px;color:var(--ca-t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-iconbtn{all:unset;cursor:pointer;width:26px;height:26px;display:grid;place-items:center;border-radius:8px;color:var(--ca-t3);flex:none;transition:background .2s,color .2s,transform .2s}
.ca-iconbtn:hover{background:var(--ca-card);color:var(--ca-t1)}
.ca-iconbtn:focus-visible,.ca-tab:focus-visible,.ca-use:focus-visible,.ca-mi:focus-visible,.ca-addbtn:focus-visible{outline:2px solid var(--ca-accent);outline-offset:1px}
.ca-iconbtn svg{width:15px;height:15px}
.ca-iconbtn.sm{width:20px;height:20px;border-radius:6px;margin-left:-4px}
.ca-iconbtn.sm svg{width:11px;height:11px}
.ca-iconbtn[disabled]{pointer-events:none;opacity:.7}
.ca-addbtn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px 0 7px;border-radius:8px;flex:none;
  font-weight:650;font-size:11.5px;color:var(--ca-t1);background:var(--ca-glass);border:1px solid var(--ca-line2);transition:border-color .2s,box-shadow .2s,transform .15s}
.ca-addbtn:hover{border-color:color-mix(in oklab,var(--ca-t1) 25%,transparent);background:var(--ca-card)}
.ca-addbtn:active{transform:scale(.97)}
.ca-addbtn svg{width:13px;height:13px}
.ca-addbtn .chev{width:10px;height:10px;opacity:.6;transition:transform .2s}
.ca-addbtn[aria-expanded=true] .chev{transform:rotate(180deg)}

/* add menu (dropdown) */
.ca-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:30;width:min(270px,calc(100cqw - 16px));padding:5px;border-radius:12px;
  background:var(--ca-menu-bg,var(--ca-bg,#1b1b1f));border:1px solid var(--ca-line);
  box-shadow:0 18px 50px -12px rgba(0,0,0,.55),0 0 0 1px color-mix(in oklab,var(--ca-t1) 4%,transparent);
  transform-origin:top right;animation:ca-pop .18s var(--ca-spring) both}
@keyframes ca-pop{from{opacity:0;transform:translateY(-4px) scale(.96)}to{opacity:1;transform:none}}
.ca-menu-h{padding:6px 8px 4px;font-size:10px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--ca-t3)}
.ca-mi{all:unset;cursor:pointer;display:grid;grid-template-columns:30px 1fr auto;gap:9px;align-items:center;width:100%;padding:7px 8px;border-radius:9px;box-sizing:border-box}
.ca-mi:hover,.ca-mi.focus{background:color-mix(in oklab,var(--pc) 13%,transparent)}
.ca-mi b{display:block;font-size:12px;font-weight:650;color:var(--ca-t1)}
.ca-mi span{display:block;font-size:10.5px;color:var(--ca-t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-mi em{font-style:normal;font-size:10px;color:var(--ca-t3);padding:1px 6px;border-radius:999px;border:1px solid var(--ca-line2)}
.ca-mi[aria-disabled=true]{opacity:.45;cursor:default}

/* provider logo tile */
.ca-logo{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:none;
  background:linear-gradient(145deg,color-mix(in oklab,var(--pc) 26%,transparent),color-mix(in oklab,var(--pc) 9%,transparent));
  border:1px solid color-mix(in oklab,var(--pc) 34%,transparent)}
.ca-logo svg{width:17px;height:17px}
.ca-logo.sm{width:20px;height:20px;border-radius:6px}.ca-logo.sm svg{width:12px;height:12px}

/* tabs */
.ca-tabs{display:flex;gap:2px;padding:3px;border-radius:11px;background:var(--ca-card);border:1px solid var(--ca-line2);overflow-x:auto;scrollbar-width:none}
.ca-tabs::-webkit-scrollbar{display:none}
.ca-tab{all:unset;cursor:pointer;flex:1 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:5px 8px;border-radius:8px;
  font-size:11px;font-weight:600;color:var(--ca-t3);white-space:nowrap;transition:background .25s var(--ca-ease),color .2s,box-shadow .25s}
.ca-tab:hover{color:var(--ca-t1)}
.ca-tab.on{color:var(--ca-t1);background:color-mix(in oklab,var(--ca-t1) 9%,transparent);box-shadow:0 1px 2px rgba(0,0,0,.15)}
.ca-tab svg{width:11px;height:11px}
.ca-tab i{font-style:normal;font-size:9.5px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;display:inline-grid;place-items:center;
  background:color-mix(in oklab,var(--ca-t1) 9%,transparent);color:var(--ca-t2)}
.ca-tab.on i{background:color-mix(in oklab,var(--pc,var(--ca-accent)) 22%,transparent);color:var(--ca-t1)}
.ca-tab .hot{width:6px;height:6px;border-radius:50%;background:var(--ca-bad);box-shadow:0 0 0 2px color-mix(in oklab,var(--ca-bad) 25%,transparent)}

/* strip + pills */
.ca-strip{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--ca-t3);font-size:11px;margin-top:-4px}
.ca-pill{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;border:1px solid var(--ca-line);color:var(--ca-t2);font-size:11px;transition:border-color .2s,background .2s}
.ca-pill:hover{border-color:var(--ca-accent)}
.ca-pill.on{border-color:color-mix(in oklab,var(--ca-green) 45%,transparent);background:color-mix(in oklab,var(--ca-green) 9%,transparent);color:var(--ca-t1)}
.ca-dot{width:7px;height:7px;border-radius:50%;background:var(--ca-t4);flex:none;display:inline-block}
.ca-dot.good{background:var(--ca-green);box-shadow:0 0 0 3px color-mix(in oklab,var(--ca-green) 20%,transparent)}
.ca-dot.warn{background:var(--ca-warn)}.ca-dot.bad{background:var(--ca-bad)}
.ca-dot.live{background:var(--ca-green);animation:ca-pulse 1.6s ease-in-out infinite}
@keyframes ca-pulse{0%{box-shadow:0 0 0 0 color-mix(in oklab,var(--ca-green) 55%,transparent)}70%{box-shadow:0 0 0 6px color-mix(in oklab,var(--ca-green) 0%,transparent)}100%{box-shadow:0 0 0 0 transparent}}

/* sections */
.ca-sec{display:flex;flex-direction:column;gap:8px}
.ca-sech{display:flex;align-items:center;gap:7px;color:var(--ca-t3);font-size:10.5px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;min-height:20px}
.ca-sech .n{font-weight:600;letter-spacing:0;color:var(--ca-t4);font-size:10.5px}
.ca-sech .sp{flex:1}
.ca-sech .ca-logo{margin-right:-1px}
.ca-sech .mini-toggle{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;text-transform:none;letter-spacing:0;font-weight:550;font-size:10.5px;color:var(--ca-t3);padding:2px 7px;border-radius:999px;border:1px solid var(--ca-line2)}
.ca-sech .mini-toggle.on{color:var(--ca-t1);border-color:color-mix(in oklab,var(--ca-green) 40%,transparent)}

/* cards */
.ca-card{position:relative;border:1px solid var(--ca-line2);background:var(--ca-card-2);border-radius:var(--ca-r);padding:12px;display:flex;flex-direction:column;gap:10px;
  transition:border-color .35s,box-shadow .35s,transform .35s var(--ca-ease),opacity .35s}
.ca-acct{--pc:var(--ca-accent);overflow:visible}
.ca-acct:hover{border-color:color-mix(in oklab,var(--ca-t1) 16%,var(--ca-line2))}
.ca-acct.active{border-color:color-mix(in oklab,var(--ca-green) 42%,var(--ca-line2));
  background:linear-gradient(180deg,color-mix(in oklab,var(--ca-green) 5%,transparent),color-mix(in oklab,var(--ca-t1) 2%,transparent));
  box-shadow:0 1px 2px rgba(0,0,0,.12)}
.ca-acct.benched,.ca-acct.expired{border-style:dashed}
.ca-top{display:flex;align-items:center;gap:10px;min-width:0;position:relative;z-index:1}
.ca-av{--h:212;position:relative;width:32px;height:32px;border-radius:10px;display:grid;place-items:center;font-weight:700;font-size:11.5px;flex:none;
  color:hsl(var(--h) 70% 70%);background:linear-gradient(145deg,hsl(var(--h) 65% 55% / .26),hsl(var(--h) 65% 45% / .12));border:1px solid hsl(var(--h) 60% 60% / .3)}
.ca-av img{width:100%;height:100%;border-radius:inherit;object-fit:cover}
.ca-av .pb{position:absolute;right:-4px;bottom:-4px;width:15px;height:15px;border-radius:5px;display:grid;place-items:center;
  background:var(--ca-bg,#111);border:1px solid color-mix(in oklab,var(--pc) 45%,transparent)}
.ca-av .pb svg{width:9px;height:9px}
.ca-av.sm{width:18px;height:18px;border-radius:6px;font-size:8.5px}.ca-av.sm .pb{display:none}
.ca-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.ca-name b{font-weight:650;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.005em}
.ca-sub{color:var(--ca-t3);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-plan{display:inline-block;font-size:9.5px;font-weight:650;padding:0 5px;border-radius:5px;margin-right:4px;vertical-align:1px;
  color:color-mix(in oklab,var(--pc) 80%,var(--ca-t1));background:color-mix(in oklab,var(--pc) 14%,transparent)}
.ca-tag{display:inline-flex;align-items:center;gap:5px;font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:3px 7px;border-radius:999px;flex:none}
.ca-tag.active{color:var(--ca-green);background:color-mix(in oklab,var(--ca-green) 13%,transparent);border:1px solid color-mix(in oklab,var(--ca-green) 30%,transparent)}
.ca-tag.active .ca-dot{width:6px;height:6px;animation:none;box-shadow:none}
.ca-tag.standby{color:var(--ca-t3);border:1px solid var(--ca-line2)}
.ca-tag.benched{color:var(--ca-warn);background:color-mix(in oklab,var(--ca-warn) 13%,transparent)}
.ca-tag.dead,.ca-tag.expired{color:var(--ca-bad);background:color-mix(in oklab,var(--ca-bad) 13%,transparent)}
.ca-tag.hermes{color:var(--ca-t2);border:1px dashed var(--ca-line)}

/* meters */
.ca-meters{display:flex;flex-direction:column;gap:8px;position:relative;z-index:1}
.ca-meter{display:flex;flex-direction:column;gap:5px}
.ca-mrow{display:flex;align-items:baseline;gap:6px;font-size:11px;min-width:0}
.ca-mrow .l{color:var(--ca-t2);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-mrow .r{color:var(--ca-t4);font-size:10.5px;white-space:nowrap}
.ca-mrow .v{font-variant-numeric:tabular-nums;font-weight:700;min-width:30px;text-align:right}
.ca-mrow .v.good{color:var(--ca-t1)}.ca-mrow .v.warn{color:var(--ca-warn)}.ca-mrow .v.bad{color:var(--ca-bad)}
.ca-track{position:relative;height:6px;border-radius:999px;background:color-mix(in oklab,var(--ca-t1) 8%,transparent);
  box-shadow:inset 0 1px 1px rgba(0,0,0,.12)}
.ca-fill{position:absolute;inset:0 auto 0 0;border-radius:999px;transition:width .7s var(--ca-ease);overflow:hidden}
.ca-fill.good{background:var(--ca-green)}
.ca-fill.warn{background:var(--ca-warn)}
.ca-fill.bad{background:var(--ca-bad)}
.ca-fill.muted{background:var(--ca-t4)}
.ca-tick{position:absolute;top:-3px;bottom:-3px;width:2px;border-radius:2px;background:var(--ca-t2);opacity:.5}
.ca-models{font-size:10px;color:var(--ca-t4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:-2px}

/* foot + buttons */
.ca-foot{display:flex;align-items:center;gap:8px;color:var(--ca-t4);font-size:10.5px;position:relative;z-index:1;min-height:24px}
.ca-foot .sp{flex:1}
.ca-use{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 11px 0 12px;border-radius:999px;
  font-size:11.5px;font-weight:650;letter-spacing:.01em;color:#fff;background:var(--ca-green-2);
  box-shadow:0 1px 2px rgba(0,0,0,.2);transition:background .15s,transform .15s var(--ca-ease)}
.ca-use svg{width:12px;height:12px;transition:transform .2s var(--ca-ease)}
.ca-use:hover{background:#15803d}
.ca-use:hover svg{transform:translateX(2px)}
.ca-use:active{transform:translateY(0) scale(.97)}
.ca-use[disabled]{opacity:.55;pointer-events:none}
.ca-ghost{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border-radius:999px;font-size:11px;font-weight:600;color:var(--ca-t2);border:1px solid var(--ca-line)}
.ca-ghost:hover{color:var(--ca-t1);border-color:var(--ca-accent)}
.ca-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 13px;border-radius:9px;font-size:11.5px;font-weight:650;
  color:var(--ca-btn-fg,#fff);background:var(--ca-btn-bg,var(--ca-accent))}
.ca-btn:hover{filter:brightness(1.08)}
.ca-link{all:unset;cursor:pointer;color:var(--ca-accent);font-size:11px;font-weight:600}
.ca-link:hover{text-decoration:underline}
.ca-link.danger{color:var(--ca-t4)}.ca-link.danger:hover{color:var(--ca-bad)}

/* notes */
.ca-note{position:relative;z-index:1;font-size:11px;border-radius:9px;padding:7px 9px;display:flex;gap:7px;align-items:flex-start;line-height:1.35;
  background:var(--ca-card);color:var(--ca-t3);border:1px solid var(--ca-line2)}
.ca-note.warn{background:color-mix(in oklab,var(--ca-warn) 9%,transparent);color:var(--ca-t2);border-color:color-mix(in oklab,var(--ca-warn) 22%,transparent)}
.ca-note.bad{background:color-mix(in oklab,var(--ca-bad) 9%,transparent);color:var(--ca-t2);border-color:color-mix(in oklab,var(--ca-bad) 22%,transparent)}
.ca-note svg,.ca-note .codicon{flex:none;width:13px;height:13px;margin-top:1px}

/* this chat / session */
.ca-ctx{display:flex;gap:13px;align-items:center}
.ca-ring{position:relative;width:68px;height:68px;flex:none}
.ca-ring svg{width:100%;height:100%;transform:rotate(-90deg);overflow:visible}
.ca-ring .bg{stroke:color-mix(in oklab,var(--ca-t1) 8%,transparent)}
.ca-ring .fg{transition:stroke-dashoffset .9s var(--ca-ease)}
.ca-ring .fg.good{stroke:var(--ca-green);color:var(--ca-green)}.ca-ring .fg.warn{stroke:var(--ca-warn);color:var(--ca-warn)}.ca-ring .fg.bad{stroke:var(--ca-bad);color:var(--ca-bad)}.ca-ring .fg.muted{stroke:var(--ca-t4)}
.ca-ring .c{position:absolute;inset:0;display:grid;place-items:center;text-align:center;line-height:1}
.ca-ring .c b{font-size:16px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.ca-ring .c span{display:block;font-size:8px;color:var(--ca-t3);letter-spacing:.08em;text-transform:uppercase;margin-top:3px}
.ca-kv{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.ca-kv .big{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.ca-kv .big small{font-weight:450;color:var(--ca-t3);font-size:11px}
.ca-chip{display:inline-flex;align-self:flex-start;align-items:center;gap:6px;max-width:100%;padding:2px 9px 2px 3px;border-radius:999px;
  border:1px solid color-mix(in oklab,var(--ca-green) 28%,var(--ca-line2));background:color-mix(in oklab,var(--ca-green) 6%,transparent);font-size:11px;color:var(--ca-t2)}
.ca-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ca-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;border-top:1px solid var(--ca-line2);padding-top:9px}
.ca-stats.three{grid-template-columns:repeat(3,1fr)}
.ca-stat{display:flex;flex-direction:column;gap:1px;min-width:0}
.ca-stat b{font-size:12px;font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-stat span{font-size:9.5px;color:var(--ca-t3);text-transform:uppercase;letter-spacing:.06em}

/* sessions */
.ca-sess{display:flex;flex-direction:column;gap:1px}
.ca-srow{display:grid;grid-template-columns:8px 1fr auto;align-items:center;gap:9px;padding:6px 6px;border-radius:8px;cursor:default}
.ca-srow[data-act]{cursor:pointer}
.ca-srow:hover{background:var(--ca-card)}
.ca-srow.cur,.ca-srow.focused{background:color-mix(in oklab,var(--ca-accent) 9%,transparent)}
.ca-srow .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px;font-weight:550}
.ca-srow .m{display:flex;align-items:center;gap:6px;color:var(--ca-t3);font-size:10.5px;font-variant-numeric:tabular-nums}
.ca-mini{width:42px;height:4px;border-radius:999px;background:color-mix(in oklab,var(--ca-t1) 9%,transparent);position:relative;overflow:hidden}
.ca-mini i{position:absolute;inset:0 auto 0 0;border-radius:999px}
.ca-mini i.good{background:var(--ca-green)}.ca-mini i.warn{background:var(--ca-warn)}.ca-mini i.bad{background:var(--ca-bad)}.ca-mini i.muted{background:var(--ca-t4)}

/* settings */
.ca-set{gap:12px}
.ca-setrow{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap}
.ca-setrow .lbl{flex:1 1 120px;display:flex;flex-direction:column;min-width:0}
.ca-setrow .lbl b{font-weight:600}
.ca-setrow .lbl span{color:var(--ca-t3);font-size:10.5px}
.ca-setrow>.ca-seg,.ca-setrow>.ca-checks{margin-left:auto}
.ca-seg{display:flex;flex-wrap:wrap;padding:2px;gap:2px;border-radius:9px;background:var(--ca-card);border:1px solid var(--ca-line2)}
.ca-seg button{all:unset;cursor:pointer;padding:3px 8px;border-radius:7px;font-size:11px;color:var(--ca-t2);font-variant-numeric:tabular-nums;transition:background .2s,color .2s}
.ca-seg button:hover{color:var(--ca-t1)}
.ca-seg button.on{background:color-mix(in oklab,var(--ca-green) 18%,transparent);color:var(--ca-t1);font-weight:700;box-shadow:0 0 0 1px color-mix(in oklab,var(--ca-green) 35%,transparent) inset}
.ca-checks{display:flex;gap:5px;flex-wrap:wrap}
.ca-check{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;border:1px solid var(--ca-line);font-size:11px;color:var(--ca-t2)}
.ca-check.on{border-color:color-mix(in oklab,var(--pc,var(--ca-green)) 50%,transparent);color:var(--ca-t1);background:color-mix(in oklab,var(--pc,var(--ca-green)) 10%,transparent)}
.ca-check .ca-logo.sm{width:14px;height:14px;border-radius:4px}.ca-check .ca-logo.sm svg{width:9px;height:9px}
.ca-switch{all:unset;cursor:pointer;flex:none;width:32px;height:18px;border-radius:999px;background:color-mix(in oklab,var(--ca-t1) 18%,transparent);position:relative;transition:background .25s}
.ca-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .25s var(--ca-spring)}
.ca-switch.on{background:var(--ca-green)}
.ca-switch.on::after{transform:translateX(14px)}

/* activity */
.ca-log{display:flex;flex-direction:column;gap:1px;position:relative}
.ca-ev{display:grid;grid-template-columns:18px 1fr;gap:8px;padding:5px 2px;font-size:11px;color:var(--ca-t2)}
.ca-ev .k{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;background:var(--ca-card);border:1px solid var(--ca-line2)}
.ca-ev .k svg{width:10px;height:10px}
.ca-ev.auto_switch .k{color:var(--ca-warn)}.ca-ev.manual_switch .k,.ca-ev.added .k,.ca-ev.imported .k{color:var(--ca-green)}
.ca-ev.all_hot .k,.ca-ev.removed .k,.ca-ev.error .k{color:var(--ca-bad)}
.ca-ev small{display:block;color:var(--ca-t4);font-size:10px}

/* empty / skeleton */
.ca-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:22px 14px;color:var(--ca-t3);border:1px dashed var(--ca-line);border-radius:var(--ca-r)}
.ca-empty>svg{width:18px;height:18px;color:var(--ca-t3)}
.ca-empty b{color:var(--ca-t1);font-size:12.5px}
.ca-empty .ca-logo{width:38px;height:38px;border-radius:12px}.ca-empty .ca-logo svg{width:20px;height:20px}
.ca-code{font-family:var(--ca-mono,ui-monospace,monospace);font-size:10.5px;padding:1px 5px;border-radius:5px;background:var(--ca-card);border:1px solid var(--ca-line2)}
.ca-skel{height:92px;border-radius:var(--ca-r);background:linear-gradient(90deg,var(--ca-card),color-mix(in oklab,var(--ca-t1) 8%,transparent),var(--ca-card));background-size:200% 100%;animation:ca-sh 1.3s linear infinite}
@keyframes ca-sh{to{background-position:-200% 0}}
.ca-spin{animation:ca-rot .9s linear infinite;transform-origin:center}
@keyframes ca-rot{to{transform:rotate(360deg)}}

/* login sheet */
.ca-sheet{--pc:var(--ca-accent);position:relative;border-radius:14px;padding:13px;display:flex;flex-direction:column;gap:11px;overflow:hidden;
  border:1px solid color-mix(in oklab,var(--pc) 35%,var(--ca-line2));
  background:var(--ca-card-2);box-shadow:0 1px 2px rgba(0,0,0,.12);animation:ca-drop .3s var(--ca-ease) both}
.ca-sheet-h{display:flex;align-items:center;gap:9px}
.ca-sheet-h>div{flex:1;min-width:0}
.ca-sheet-h b{display:block;font-size:12.5px;font-weight:700}
.ca-sheet-h span{display:block;font-size:10.5px;color:var(--ca-t3)}
.ca-devcode{display:flex;align-items:center;justify-content:center;gap:4px;padding:10px 6px;border-radius:11px;background:color-mix(in oklab,var(--ca-t1) 4%,transparent);border:1px dashed color-mix(in oklab,var(--pc) 40%,transparent);flex-wrap:wrap}
.ca-devcode span{font-family:var(--ca-mono,ui-monospace,monospace);font-size:19px;font-weight:700;letter-spacing:.02em;min-width:19px;text-align:center;
  padding:3px 2px;border-radius:6px;background:var(--ca-card);animation:ca-in .35s var(--ca-spring) both}
.ca-devcode span.sep{background:none;min-width:8px;color:var(--ca-t4)}
.ca-sheet-a{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ca-wait{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ca-t2)}
.ca-wait .orb{width:14px;height:14px;border-radius:50%;flex:none;border:2px solid color-mix(in oklab,var(--pc) 25%,transparent);border-top-color:var(--pc);animation:ca-rot .8s linear infinite}
.ca-sheet input{all:unset;box-sizing:border-box;width:100%;height:30px;padding:0 10px;border-radius:9px;font-size:12px;background:var(--ca-input-bg,var(--ca-card));border:1px solid var(--ca-line);color:var(--ca-t1)}
.ca-sheet input:focus{border-color:var(--pc)}
.ca-err{color:var(--ca-bad);font-size:11px}
.ca-x{margin-left:auto}

/* switch feedback */
.ca-banner{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:11px;font-size:11.5px;margin-top:-4px;color:var(--ca-t1);
  background:color-mix(in oklab,var(--ca-accent) 12%,transparent);border:1px solid color-mix(in oklab,var(--ca-accent) 25%,transparent);animation:ca-drop .35s var(--ca-spring) both}
.ca-banner.done{background:color-mix(in oklab,var(--ca-green) 12%,transparent);border-color:color-mix(in oklab,var(--ca-green) 30%,transparent)}
.ca-banner.err{background:color-mix(in oklab,var(--ca-bad) 12%,transparent);border-color:color-mix(in oklab,var(--ca-bad) 30%,transparent)}
.ca-banner svg,.ca-banner .codicon{width:13px;height:13px;flex:none}
.ca-banner.done svg,.ca-banner.done .codicon{color:var(--ca-green)}
@keyframes ca-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.ca-enter{animation:ca-in .45s var(--ca-spring) both}
@keyframes ca-in{from{opacity:0;transform:translateX(10px) scale(.96)}to{opacity:1;transform:none}}
.ca-switching{opacity:.65;transition:opacity .2s}
.ca-flash{animation:ca-flash .9s ease-out 1}
@keyframes ca-flash{0%{background-color:color-mix(in oklab,var(--ca-green) 12%,transparent)}100%{background-color:transparent}}
.ca-move{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ca-t2);padding:7px 9px;border-radius:9px;background:color-mix(in oklab,var(--ca-accent) 8%,transparent);animation:ca-drop .3s ease both}
.ca-move>span:last-child{min-width:0;line-height:1.3}
.ca-dots{display:inline-flex;gap:2px;flex:none}
.ca-dots i{width:4px;height:4px;border-radius:50%;background:var(--ca-green);animation:ca-dots 1.2s ease-in-out infinite}
.ca-dots i:nth-child(2){animation-delay:.15s}.ca-dots i:nth-child(3){animation-delay:.3s}
@keyframes ca-dots{0%,100%{opacity:.2;transform:translateX(0)}50%{opacity:1;transform:translateX(2px)}}
.ca-moved{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ca-t2);animation:ca-drop .35s ease both}
.ca-moved svg,.ca-moved .codicon{color:var(--ca-green);width:13px;height:13px}
.ca-accounts{display:flex;flex-direction:column;gap:9px}
.ca-groups{display:flex;flex-direction:column;gap:16px}

/* model routing */
.ca-tier{display:flex;flex-direction:column;gap:7px;padding:11px 0 0;border-top:1px solid var(--ca-line2)}
.ca-tier.first{border-top:0;padding-top:0}
.ca-tier-h{display:flex;align-items:center;gap:8px;min-width:0}
.ca-tier-h .tdot{width:9px;height:9px;border-radius:3px;background:var(--tc);flex:none}
.ca-tier-h b{font-weight:650}
.ca-tier-h .ca-sub{flex:1;min-width:0}
.ca-tier-h .eff{margin-left:auto;font-size:10.5px;color:var(--ca-t3);white-space:nowrap}
.ca-tier .ca-seg{align-self:flex-start}
.ca-tier .ca-seg button.on{background:color-mix(in oklab,var(--tc) 18%,transparent);box-shadow:0 0 0 1px color-mix(in oklab,var(--tc) 40%,transparent) inset}
.ca-mchip{--tc:var(--ca-t3);display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:650;padding:1px 8px 1px 6px;border-radius:999px;white-space:nowrap;flex:none;
  color:color-mix(in oklab,var(--tc) 85%,var(--ca-t1));background:color-mix(in oklab,var(--tc) 12%,transparent);border:1px solid color-mix(in oklab,var(--tc) 26%,transparent)}
.ca-mchip i{width:6px;height:6px;border-radius:2px;background:var(--tc)}
.ca-dist{display:flex;height:6px;border-radius:999px;overflow:hidden;background:color-mix(in oklab,var(--ca-t1) 8%,transparent);gap:2px}
.ca-dist span{background:var(--tc);min-width:3px}
.ca-legend{display:flex;gap:4px 12px;flex-wrap:wrap;font-size:10.5px;color:var(--ca-t3)}
.ca-legend span{display:inline-flex;align-items:center;gap:5px}
.ca-legend i{width:7px;height:7px;border-radius:2px;background:var(--tc)}
.ca-legend b{color:var(--ca-t1);font-weight:650}
.ca-dels{display:flex;flex-direction:column;gap:1px}
.ca-drow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;align-items:center;padding:7px 6px;border-radius:8px}
.ca-drow:hover{background:var(--ca-card)}
.ca-drow .t{font-size:11.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-drow .ca-sub{grid-column:1/-1;display:flex;align-items:center;gap:6px}
.ca-drow .ca-sub span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ca-st{width:6px;height:6px;border-radius:50%;flex:none;background:var(--ca-t4)}
.ca-st.done{background:var(--ca-green)}.ca-st.error{background:var(--ca-bad)}
.ca-st.running{background:var(--ca-accent);animation:ca-pulse 1.6s ease-in-out infinite}
.ca-routeline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ca-t3)}
.ca-sessdel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ca-t3);border-top:1px solid var(--ca-line2);padding-top:9px}

/* running now + foldable sections */
.ca-runs{display:flex;flex-direction:column;gap:1px;padding:5px}
.ca-runs .ca-drow.sub{margin-left:12px;padding-left:10px;border-left:1px solid var(--ca-line2);border-radius:0 8px 8px 0}
.ca-runs .ca-drow .ctx{font-size:10.5px;color:var(--ca-t3);white-space:nowrap}
.ca-idle{font-size:11px;color:var(--ca-t3);padding:2px 2px 0}
.ca-foldbtn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border-radius:5px}
.ca-foldbtn:hover{color:var(--ca-t1)}
.ca-foldbtn:focus-visible{outline:1px solid var(--ca-accent);outline-offset:2px}
.ca-foldbtn svg{width:10px;height:10px;transition:transform .15s ease}
.ca-foldbtn[aria-expanded=false] svg{transform:rotate(-90deg)}
@media (prefers-reduced-motion:reduce){.ca-foldbtn svg{transition:none}}

/* ── responsive: container queries follow the pane width ── */
@container ca (max-width:400px){
  .ca-tab{padding:5px 7px;flex:1 1 auto}
  .ca-tab:not(.on):not(:first-child):not(:last-child) .lbl{display:none}
}
@container ca (max-width:300px){
  .ca{padding:10px 9px 16px;gap:12px}
  .ca-stats{grid-template-columns:repeat(2,1fr);row-gap:8px}
  .ca-ring{width:56px;height:56px}
  .ca-ring .c b{font-size:13.5px}
  .ca-ring .c span{font-size:7px;letter-spacing:.03em}
  .ca-mrow{flex-wrap:wrap}
  .ca-mrow .r{order:3;flex-basis:100%}
  .ca-setrow .ca-seg{width:100%}
  .ca-seg button{flex:1;text-align:center;padding:4px 2px}
  .ca-av{width:28px;height:28px;font-size:10.5px}
  .ca-top{gap:8px}
  .ca-tag{font-size:8.5px;padding:2px 6px}
  .ca-brand small{display:none}
}
@container ca (max-width:260px){
  .ca-tabs{gap:0}
  .ca-tab{padding:5px 4px;gap:3px}
  .ca-sech{flex-wrap:wrap;row-gap:4px}
  .ca-sech .mini-toggle{padding:1px 6px}
}
@container ca (max-width:240px){
  .ca-top{flex-wrap:wrap;row-gap:5px}
  .ca-top .ca-name{flex:1 1 calc(100% - 46px)}
  .ca-top .ca-tag{margin-left:38px}
  .ca-addbtn .t{display:none}
  .ca-brand .ca-mark{display:none}
  .ca-foot{flex-wrap:wrap}
}
@container ca (max-width:220px){
  .ca-ctx{flex-direction:column;align-items:stretch}
  .ca-ring{align-self:flex-start}
  .ca-srow .m .ca-mini{display:none}
  .ca-tab i{display:none}
}
@container ca (min-width:560px){
  .ca-accounts{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));align-items:start}
  .ca-sess{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));column-gap:8px}
}
@media (prefers-reduced-motion:reduce){
  .ca *,.ca{animation:none!important;transition:none!important}
}
`
/*@@END_CSS*/
const CSS_HERMES = `
.ca-ic{display:inline-grid;place-items:center;flex:none;width:13px;height:13px}
.ca-ic svg{width:100%;height:100%}
.ca-use .ca-ic,.ca-ghost .ca-ic{width:12px;height:12px}
.ca-mi-row{display:grid;grid-template-columns:30px 1fr auto;gap:9px;align-items:center;width:100%;min-width:220px;padding:2px 0}
.ca-mi-row b{display:block;font-size:12px;font-weight:650}
.ca-mi-row span.s{display:block;font-size:10.5px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.ca-mi-row em{font-style:normal;font-size:10px;opacity:.7;padding:1px 6px;border-radius:999px;border:1px solid var(--ui-stroke-tertiary,rgba(127,127,127,.2))}
.ca-chipbtn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;height:100%;padding:0 6px;font-size:11px;color:var(--ui-text-tertiary,inherit);font-variant-numeric:tabular-nums}
.ca-chipbtn:hover{color:var(--ui-text-primary,inherit);background:var(--chrome-action-hover,transparent)}
.ca-chipbtn .ca-dot{width:6px;height:6px;border-radius:50%;display:inline-block;background:var(--ui-text-quaternary,#777)}
.ca-chipbtn .ca-dot.good{background:#22c55e}.ca-chipbtn .ca-dot.warn{background:var(--ui-yellow,#d29922)}.ca-chipbtn .ca-dot.bad{background:var(--ui-red,#f85149)}
`
const Style = () => jsx('style', { children: CSS_SHARED + CSS_HERMES })

// ─── data ─────────────────────────────────────────────────────────────────────────────────────

function useAccounts() {
  return useQuery({ queryKey: QK, queryFn: () => rest('/state'), refetchInterval: 20_000, refetchOnWindowFocus: true, retry: 1 })
}

// ─── pieces ───────────────────────────────────────────────────────────────────────────────────

function Avatar({ a, p, small }) {
  const prov = p || a.provider || 'claude'
  return jsxs('div', {
    className: 'ca-av' + (small ? ' sm' : ''),
    style: { '--h': hue(a, prov), '--pc': PCOLOR[prov] },
    children: [
      a.picture ? jsx('img', { src: a.picture, alt: '', referrerPolicy: 'no-referrer' }) : initials(a),
      small ? null : jsx('span', { className: 'pb', dangerouslySetInnerHTML: { __html: ICONS[prov] } })
    ]
  })
}

const WIN_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'claude', 'gemini_pro', 'gemini_flash', 'other', 'premium_interactions', 'chat', 'completions']

function Meter({ w, threshold, showTick }) {
  const t = tone(w.pct, threshold)
  const right = [w.used != null && w.limit ? `${Math.round(w.used)}/${w.limit}` : null, w.resets_at ? `resets ${inFuture(w.resets_at)}` : null].filter(Boolean).join(' · ')
  return jsxs('div', {
    className: 'ca-meter',
    children: [
      jsxs('div', { className: 'ca-mrow', children: [jsx('span', { className: 'l', children: w.label }), right ? jsx('span', { className: 'r', children: right }) : null, jsx('span', { className: 'v ' + t, children: pct(w.pct) })] }),
      jsx(Tip, {
        label: `${Math.round(w.pct)}% used${w.resets_at ? ` · resets ${clock(w.resets_at)}` : ''}${w.models ? ` · ${w.models.join(', ')}` : ''}`,
        children: jsxs('div', {
          className: 'ca-track',
          children: [
            jsx('div', { className: 'ca-fill ' + t, style: { width: `${Math.min(100, Math.max(w.pct > 0 ? 2 : 0, w.pct))}%` } }),
            showTick ? jsx('div', { className: 'ca-tick', style: { left: `calc(${threshold}% - 1px)` } }) : null
          ]
        })
      })
    ]
  })
}

function Meters({ a, threshold, watch }) {
  const wins = Object.values((a.usage && a.usage.windows) || {}).sort((x, y) => WIN_ORDER.indexOf(x.key) - WIN_ORDER.indexOf(y.key))
  if (!wins.length) {
    const unl = (a.usage && a.usage.unlimited) || []
    if (unl.length) return jsx(Note, { icon: 'info', children: `${unl.join(' & ')} unlimited on this plan.` })
    if (a.usage_error || a.oauth === false) return null
    return jsx('div', { className: 'ca-skel', style: { height: 38 } })
  }
  return jsx('div', { className: 'ca-meters', children: wins.map(w => jsx(Meter, { w, threshold, showTick: !watch || watch.includes(w.key) }, w.key)) })
}

function Note({ kind, icon, children }) {
  return jsxs('div', { className: 'ca-note' + (kind ? ' ' + kind : ''), children: [jsx(Svg, { name: icon || 'info' }), jsx('span', { children })] })
}

function Ring({ value, label }) {
  const r = 27
  const c = 2 * Math.PI * r
  const p = value == null ? 0 : Math.max(0, Math.min(100, value))
  const t = value == null ? 'muted' : p >= 85 ? 'bad' : p >= 60 ? 'warn' : 'good'
  return jsxs('div', {
    className: 'ca-ring',
    children: [
      jsxs('svg', {
        viewBox: '0 0 64 64',
        children: [
          jsx('circle', { className: 'bg', cx: 32, cy: 32, r, fill: 'none', strokeWidth: 6 }),
          jsx('circle', { className: 'fg ' + t, cx: 32, cy: 32, r, fill: 'none', strokeWidth: 6, strokeLinecap: 'round', strokeDasharray: c, strokeDashoffset: c * (1 - p / 100) })
        ]
      }),
      jsx('div', { className: 'c', children: jsxs('div', { children: [jsx('b', { children: value == null ? '—' : `${Math.round(p)}%` }), jsx('span', { children: label })] }) })
    ]
  })
}

function SectionHead({ title, count, right, p }) {
  return jsxs('div', {
    className: 'ca-sech',
    children: [p ? jsx(Logo, { p, sm: true }) : null, jsx('span', { children: title }), count != null ? jsx('span', { className: 'n', children: count }) : null, jsx('span', { className: 'sp' }), right || null]
  })
}

function UseButton({ onClick, label }) {
  return jsxs('button', { className: 'ca-use', type: 'button', onClick, children: [label || 'Use', jsx(Svg, { name: 'arrow' })] })
}

// ─── this chat ────────────────────────────────────────────────────────────────────────────────

function CurrentChat({ data }) {
  const usage = useValue(host.state.focusedUsage)
  const sid = useValue(host.state.focusedSessionId)
  const stored = useValue(host.state.focusedStoredSessionId || host.state.focusedSessionId)
  const model = useValue(host.state.model)
  const sw = useSwitch()
  const sess = (data.sessions || []).find(s => isFocused(s, sid, stored))
  const byId = id => (data.accounts || []).find(a => a.id === id)
  const acct = sess && sess.account_id ? byId(sess.account_id) : null
  const target = data.pending_target_id || (sw && sw.provider === 'claude' && sw.id) || null
  const movingTo = sess && sess.provider === 'anthropic' && target && sess.account_id && sess.account_id !== target ? byId(target) : null
  const justMoved = sw && sw.provider === 'claude' && sw.phase === 'done' && acct && acct.id === sw.id
  const ctxUsed = (usage && usage.context_used) ?? (sess && sess.context_used)
  const ctxMax = (usage && usage.context_max) ?? (sess && sess.context_max)
  const ctxPct = (usage && usage.context_percent) ?? (sess && sess.context_percent) ?? (ctxUsed && ctxMax ? (ctxUsed / ctxMax) * 100 : null)

  if (!sid && !usage) return jsx('div', { className: 'ca-card', children: jsx('div', { className: 'ca-sub', children: 'Open a chat to see its context window.' }) })

  return jsxs('div', {
    className: 'ca-card ca-chat' + (justMoved ? ' ca-flash' : ''),
    children: [
      jsxs('div', {
        className: 'ca-ctx',
        children: [
          jsx(Ring, { value: ctxPct, label: 'context' }),
          jsxs('div', {
            className: 'ca-kv',
            children: [
              jsxs('div', { className: 'big', children: [fmtK(ctxUsed), jsxs('small', { children: [' / ', fmtK(ctxMax), ' tokens'] })] }),
              jsx('div', { className: 'ca-sub', children: (sess && sess.model) || model || '—' }),
              acct
                ? jsx(Tip, {
                    label: `This chat bills ${displayName(acct)}`,
                    // keyed by account → remounts with the enter animation on every switch
                    children: jsxs('div', { className: 'ca-chip ca-enter', children: [jsx(Avatar, { a: acct, p: 'claude', small: true }), jsx('span', { children: displayName(acct) })] }, acct.id)
                  })
                : jsx('div', { className: 'ca-sub', children: sess ? `via ${sess.provider || 'provider'}` : 'not a Claude session' })
            ]
          })
        ]
      }),
      movingTo
        ? jsxs('div', {
            className: 'ca-move',
            children: [
              jsx(Avatar, { a: acct, p: 'claude', small: true }),
              jsxs('span', { className: 'ca-dots', children: [jsx('i', {}), jsx('i', {}), jsx('i', {})] }),
              jsx(Avatar, { a: movingTo, p: 'claude', small: true }),
              jsx('span', { children: sess.running ? `Moves to ${displayName(movingTo)} after this reply` : `Moving to ${displayName(movingTo)}…` })
            ]
          })
        : null,
      justMoved ? jsxs('div', { className: 'ca-moved', children: [jsx(Svg, { name: 'check' }), jsx('span', { children: `Now billed to ${displayName(acct)} · prompt cache rebuilds on the next message` })] }) : null,
      jsx('div', {
        className: 'ca-stats',
        children: [
          ['in', usage ? usage.input : sess && sess.tokens_in],
          ['out', usage ? usage.output : sess && sess.tokens_out],
          ['calls', usage ? usage.calls : sess && sess.calls],
          ['cache', usage && usage.cache_hit_pct != null ? `${usage.cache_hit_pct}%` : '—']
        ].map(([k, v]) => jsxs('div', { className: 'ca-stat', children: [jsx('b', { children: typeof v === 'string' ? v : fmtK(v) }), jsx('span', { children: k })] }, k))
      })
    ]
  })
}

// ─── account cards ────────────────────────────────────────────────────────────────────────────

function CardShell({ p, a, active, extraClass, tag, sub, children, foot }) {
  const sw = useSwitch()
  const anim = sw && sw.provider === p && sw.id === a.id ? (sw.phase === 'pending' ? ' ca-switching' : ' ca-flash') : ''
  return jsxs('div', {
    className: 'ca-card ca-acct' + (active ? ' active' : '') + (extraClass || '') + anim,
    style: { '--pc': PCOLOR[p] },
    'data-flip': `${p}:${a.id}`,
    children: [
      jsxs('div', {
        className: 'ca-top',
        children: [
          jsx(Avatar, { a, p }),
          jsxs('div', {
            className: 'ca-name',
            children: [
              jsx(Tip, { label: `${displayName(a)} · ${a.id}`, children: jsx('b', { children: displayName(a) }) }),
              jsxs('span', { className: 'ca-sub', children: [a.plan || (a.profile && a.profile.plan) ? jsx('span', { className: 'ca-plan', children: a.plan || a.profile.plan }) : null, sub] })
            ]
          }),
          tag
        ]
      }),
      children,
      jsxs('div', { className: 'ca-foot', children: foot })
    ]
  })
}

const Tag = ({ kind, children }) => jsxs('span', { className: 'ca-tag ' + kind, children: [kind === 'active' ? jsx('span', { className: 'ca-dot live' }) : null, children] })

// re-read one account's usage on demand
function RefreshOne({ id, label }) {
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (busy) return
    setBusy(true)
    haptic('tap')
    try {
      const res = await post('/settings', { refresh_account: id })
      const r = res && res.settings && res.settings._refresh
      if (r && r.error) host.notify({ kind: 'warning', message: r.error })
      refetch()
    } catch (e) {
      host.notify({ kind: 'error', message: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  return jsx('button', {
    className: 'ca-iconbtn sm',
    type: 'button',
    disabled: busy,
    title: "Refresh this account's usage now",
    'aria-label': `Refresh ${label || 'account'}`,
    onClick: go,
    children: jsx('span', { className: busy ? 'ca-spin' : '', style: { display: 'inline-flex' }, dangerouslySetInnerHTML: { __html: ICONS.refresh } })
  })
}

function ClaudeCard({ a, data, onRemove }) {
  const s = data.settings
  const manual = a.status === 'benched' && a.bench_kind === 'manual'
  const status = a.status === 'dead' ? 'dead' : manual ? 'standby' : a.status === 'benched' ? 'benched' : a.active ? 'active' : 'standby'
  const prof = a.profile || {}
  const sub = [prof.org && !String(prof.org).includes('@') ? prof.org : null, a.live_sessions ? `${a.live_sessions} live chat${a.live_sessions > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ') || (prof.plan ? '' : a.label)
  const menu = jsxs(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, { asChild: true, children: jsx('button', { className: 'ca-iconbtn', 'aria-label': 'Account actions', children: jsx(Codicon, { name: 'ellipsis' }) }) }),
      jsxs(DropdownMenuContent, {
        align: 'end',
        children: [
          !a.active && a.status !== 'dead' ? jsx(DropdownMenuItem, { onSelect: () => doSwitch(a), children: 'Use this account' }) : null,
          a.status === 'benched' && a.bench_kind !== 'manual' ? jsx(DropdownMenuItem, { onSelect: () => act(() => post('/clear', { id: a.id }), 'Bench cleared'), children: 'Resume now (clear bench)' }) : null,
          jsx(DropdownMenuItem, { onSelect: () => act(() => post('/refresh'), null), children: 'Refresh usage' }),
          jsx(DropdownMenuSeparator, {}),
          jsx(DropdownMenuItem, { onSelect: () => onRemove({ ...a, provider: 'claude' }), children: 'Remove from Hermes…' })
        ]
      })
    ]
  })
  return jsxs(CardShell, {
    p: 'claude',
    a,
    active: a.active,
    extraClass: a.status === 'benched' ? ' benched' : a.status === 'dead' ? ' expired' : '',
    tag: jsxs(Fragment, { children: [jsx(Tag, { kind: status, children: status === 'dead' ? 'needs login' : status }), menu] }),
    sub,
    foot: [
      jsx('span', { children: a.usage_at ? `updated ${ago(a.usage_at)}` : a.oauth ? 'waiting for first reading' : '' }, 'u'),
      a.oauth !== false ? jsx(RefreshOne, { id: a.id, label: prof.email || a.label }, 'r') : null,
      a.override_until ? jsx('span', { children: `· pinned until ${clock(a.override_until)}` }, 'o') : null,
      jsx('span', { className: 'sp' }, 'sp'),
      !a.active && (a.status === 'ok' || manual) ? jsx(UseButton, { onClick: () => doSwitch(a) }, 'use') : null
    ],
    children: [
      a.oauth === false ? jsx(Note, { icon: 'info', children: 'API-key credential — usage limits are only reported for Claude subscription logins.' }, 'k') : jsx(Meters, { a, threshold: s.threshold, watch: s.windows }, 'm'),
      a.twins && a.twins.length
        ? jsx(Note, { icon: 'info', children: a.twins.some(t => t.follows_claude_code) || a.follows_claude_code ? 'Claude Code is signed into this same account, so Hermes holds it twice. It counts as one account here.' : 'Hermes holds two logins for this account. It counts as one account here.' }, 'dup')
        : a.follows_claude_code
          ? jsx(Note, { icon: 'info', children: 'Follows Claude Code: this becomes whichever account Claude Code is signed into.' }, 'fcc')
          : null,
      a.status === 'benched' && !manual
        ? jsx(
            Note,
            {
              kind: 'warn',
              icon: 'pause',
              children: jsxs(Fragment, {
                children: [
                  a.by_us ? 'Paused by auto-switch' : `Paused by Hermes${a.bench_code ? ` (HTTP ${a.bench_code})` : ''}`,
                  a.benched_until ? ` until ${clock(a.benched_until)} (${inFuture(a.benched_until)})` : '',
                  ' ',
                  jsx('button', { className: 'ca-link', onClick: () => act(() => post('/clear', { id: a.id }), 'Bench cleared'), children: 'Resume now' })
                ]
              })
            },
            'b'
          )
        : null,
      manual ? jsx(Note, { icon: 'pause', children: 'On standby because you switched accounts. Auto-switch brings it back if the active account runs hot.' }, 'mn') : null,
      a.status === 'dead' ? jsx(Note, { kind: 'bad', icon: 'warn', children: 'Login revoked or expired for good — remove it and add the account again.' }, 'd') : null,
      a.usage_error ? jsx(Note, { icon: 'warn', children: a.usage_error }, 'e') : null
    ]
  })
}

function ProviderCard({ p, a, onRemove }) {
  const thr = useThreshold()
  const tagKind = a.live ? 'active' : a.status === 'expired' ? 'expired' : 'standby'
  const tagText = a.live ? (p === 'copilot' ? 'selected' : 'active') : tagKind
  const sub = p === 'copilot' && a.login && a.login !== displayName(a) ? '@' + a.login : a.name && a.name !== displayName(a) ? a.name : ''
  return jsxs(CardShell, {
    p,
    a,
    active: a.live,
    extraClass: a.status === 'expired' ? ' expired' : '',
    tag: jsx(Tag, { kind: tagKind, children: tagText }),
    sub,
    foot: [
      jsx('span', { children: a.usage_at ? `updated ${ago(a.usage_at)}` : 'no reading yet' }, 'u'),
      jsx(RefreshOne, { id: `${p}::${a.id}`, label: a.label }, 'r'),
      jsx('span', { className: 'sp' }, 'sp'),
      !a.live ? jsx('button', { className: 'ca-link danger', onClick: () => onRemove({ ...a, provider: p }), children: 'Remove' }, 'rm') : null,
      a.switchable && !a.live ? jsx(UseButton, { onClick: () => doUseProvider(p, a) }, 'use') : null
    ],
    children: [
      jsx(Meters, { a, threshold: thr }, 'm'),
      a.usage_error ? jsx(Note, { kind: a.status === 'expired' ? 'bad' : '', icon: 'warn', children: a.usage_error }, 'e') : null,
      a.pinned_until ? jsx(Note, { kind: 'warn', icon: 'pause', children: `Pinned by you — auto-switch leaves it alone until ${clock(a.pinned_until)}.` }, 'pin') : null
    ]
  })
}

let THRESHOLD = 90
const useThreshold = () => THRESHOLD

function ProviderGroup({ p, data, onAdd, onRemove }) {
  const ref = useRef(null)
  useFlip(ref)
  const isClaude = p === 'claude'
  const info = isClaude ? { accounts: data.accounts || [], auto_switch: true, available: true } : (data.providers || {})[p] || { accounts: [], available: false }
  const accts = sortActiveFirst(info.accounts || [])
  const m = meta(p)
  const s = data.settings
  if (!accts.length) return null
  const toggle = () => act(() => post('/settings', { provider_auto: { ...(s.provider_auto || {}), [p]: !info.auto_switch } }), null)
  return jsxs('div', {
    className: 'ca-sec',
    ref,
    children: [
      jsx(SectionHead, {
        p,
        title: m.name,
        count: accts.length || null,
        right: jsxs(Fragment, {
          children: [
            !isClaude && accts.length
              ? jsx(Tip, {
                  label: `Auto-switch ${m.name} at ${s.threshold}%`,
                  children: jsxs('button', { className: 'mini-toggle' + (info.auto_switch ? ' on' : ''), onClick: toggle, children: [jsx('span', { className: 'ca-dot' + (info.auto_switch ? ' good' : '') }), 'auto'] })
                })
              : null,
          ]
        })
      }),
      jsx('div', { className: 'ca-accounts', children: accts.map(a => (isClaude ? jsx(ClaudeCard, { a, data, onRemove }, a.id) : jsx(ProviderCard, { p, a, onRemove }, a.id))) }),
      isClaude && accts.length === 1 ? jsx(Note, { icon: 'info', children: 'Add a second Claude account so there is something to switch to.' }) : null,
      isClaude && accts.length && data.strategy && data.strategy !== 'fill_first'
        ? jsx(Note, { kind: 'warn', icon: 'warn', children: `Pool strategy is “${data.strategy}”, so Hermes spreads requests across accounts. For one active account at a time run “hermes auth” → strategy → fill_first.` })
        : null,
      p === 'antigravity' && accts.length && !info.available ? jsx(Note, { kind: 'warn', icon: 'warn', children: info.note || 'Antigravity isn’t installed here — switching is off.' }) : null,
      p === 'antigravity' && accts.length > 0 ? jsx(Note, { icon: 'info', children: 'Switching rewrites Antigravity’s login (app, agy CLI and its VS Code extension). Restart Antigravity to apply.' }) : null,
      p === 'copilot' && accts.length > 0 ? jsx(Note, { icon: 'info', children: 'Use selects the account for Copilot clients that read ~/.config/github-copilot. Copilot in VS Code switches from the Switchboard extension.' }) : null
    ]
  })
}


// ─── model routing ────────────────────────────────────────────────────────────────────────────

function saveRouting(patch) {
  haptic('tap')
  if (queryClient.setQueryData) {
    queryClient.setQueryData(QK, d => {
      if (!d || !d.routing || !d.routing.config) return d
      const r = JSON.parse(JSON.stringify(d.routing))
      for (const [k, v] of Object.entries(patch)) {
        if (k.startsWith('tiers.')) {
          r.config.tiers[k.slice(6)] = v
          const t = r.tiers.find(x => x.tier === k.slice(6))
          if (t) t.model = t.effective = v
        } else if (k === 'hermes' && r.hermes) {
          r.config.hermes = v
        } else r.config[k] = v
      }
      return { ...d, routing: r }
    })
  }
  return act(async () => {
    const res = await post('/settings', { routing: patch })
    const rr = res && res.settings && res.settings._routing
    if (rr && rr.ok === false) throw new Error(rr.error || 'Could not save routing')
    if (rr && rr.warning) host.notify({ kind: 'warning', message: rr.warning })
    return { ok: true }
  }, null).catch(() => {})
}

const MChip = ({ d }) => jsxs('span', { className: 'ca-mchip', title: d.model || '', style: { '--tc': d.tier ? TCOLOR[d.tier] : 'var(--ca-t3)' }, children: [jsx('i', {}), d.model_label || '—'] })

function Distribution({ dels }) {
  if (!dels.length) return null
  const by = {}
  dels.forEach(d => {
    const k = d.model_label || '—'
    by[k] = by[k] || { n: 0, tier: d.tier }
    by[k].n++
  })
  const order = ['fast', 'balanced', 'deep']
  const rows = Object.entries(by).sort((a, b) => order.indexOf(a[1].tier) - order.indexOf(b[1].tier))
  const tc = t => (t ? TCOLOR[t] : 'var(--ca-t4)')
  return jsxs(Fragment, {
    children: [
      jsx('div', { className: 'ca-dist', children: rows.map(([k, v]) => jsx('span', { style: { flex: v.n, '--tc': tc(v.tier) } }, k)) }),
      jsx('div', { className: 'ca-legend', children: rows.map(([k, v]) => jsxs('span', { style: { '--tc': tc(v.tier) }, children: [jsx('i', {}), k, ' ', jsx('b', { children: v.n })] }, k)) })
    ]
  })
}

function DelegationRows({ dels, limit }) {
  return jsx('div', {
    className: 'ca-dels',
    children: dels.slice(0, limit).map(d =>
      jsxs(
        'div',
        {
          className: 'ca-drow',
          title: `${d.description}\n${d.model || ''} · ${d.session || ''}`,
          children: [
            jsx('div', { className: 't', children: d.description }),
            jsx(MChip, { d }),
            jsxs('div', {
              className: 'ca-sub',
              children: [
                jsx('span', { className: 'ca-st ' + d.state }),
                jsx('span', { children: [d.state === 'running' ? 'running' : d.state === 'error' ? 'failed' : ago(d.at), d.session ? d.session : null, d.tokens_out ? `${fmtK(d.tokens_out)} tok` : null].filter(Boolean).join(' · ') })
              ]
            })
          ]
        },
        d.id
      )
    )
  })
}

function RoutingCard({ r }) {
  const c = r.config
  const on = c.enabled
  const row = (children, style) => jsxs('div', { className: 'ca-setrow', style, children })
  const lbl = (b, sub) => jsxs('div', { className: 'lbl', children: [jsx('b', { children: b }), sub ? jsx('span', { children: sub }) : null] }, 'l')
  const conflict = (r.agents || []).filter(a => a.conflict).map(a => a.agent)
  const h = r.hermes || {}
  return jsxs('div', {
    className: 'ca-sec',
    children: [
      jsx(SectionHead, { title: 'Model routing' }),
      jsxs('div', {
        className: 'ca-card ca-set',
        children: [
          row([lbl('Route tasks by size', 'Small tasks go to a fast model, hard thinking to the best one'), jsx(Switch, { checked: !!on, onCheckedChange: v => saveRouting({ enabled: v }) }, 's')]),
          jsx('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 11, opacity: on ? 1 : 0.5 },
            children: r.tiers.map((t, i) =>
              jsxs(
                'div',
                {
                  className: 'ca-tier' + (i ? '' : ' first'),
                  style: { '--tc': TCOLOR[t.tier] },
                  children: [
                    jsxs('div', { className: 'ca-tier-h', children: [jsx('span', { className: 'tdot' }), jsx('b', { children: t.label }), jsx('span', { className: 'ca-sub', children: t.blurb })] }),
                    jsxs('div', {
                      style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                      children: [
                        jsx(Seg, { value: t.model, options: MODEL_CHOICES.map(x => x[0]), fmt: v => MODEL_CHOICES.find(x => x[0] === v)[1], onChange: v => saveRouting({ [`tiers.${t.tier}`]: v }) }),
                        jsx('span', { className: 'ca-sub', children: `${t.model_label}${t.effective !== t.model ? ' · saving quota' : ''}` })
                      ]
                    })
                  ]
                },
                t.tier
              )
            )
          }),
          r.downgraded ? jsx(Note, { kind: 'warn', icon: 'pause', children: 'Saving quota: Claude is over the threshold with no account to switch to, so subagents use one model smaller until it recovers.' }) : null,
          conflict.length ? jsx(Note, { kind: 'warn', icon: 'warn', children: `You already have your own ${conflict.join(', ')} agent in Claude Code — left it untouched.` }) : null,
          row([lbl('Hermes subagents', h.plugin ? 'delegate_task picks fast, balanced or deep per task' : 'Needs the advanced-delegation plugin'), jsx(Switch, { checked: !!c.hermes, disabled: !h.plugin, onCheckedChange: v => saveRouting({ hermes: v }) }, 's')], { opacity: on ? 1 : 0.5 }),
          row([lbl('Claude Code agents', 'fast-worker, builder, architect in ~/.claude/agents'), jsx(Switch, { checked: !!c.claude_code_agents, onCheckedChange: v => saveRouting({ claude_code_agents: v }) }, 's')], { opacity: on ? 1 : 0.5 }),
          row([lbl('Claude Code main model', 'Opus plan: Opus plans, Sonnet does the work'), jsx(Seg, { value: c.claude_code_main, options: ['default', 'opusplan', 'opus', 'sonnet'], fmt: v => MAIN_LABELS[v], onChange: v => saveRouting({ claude_code_main: v }) }, 's')], { opacity: on ? 1 : 0.5 }),
          row([lbl('Save quota', 'Near the limit with nowhere to switch, use one model smaller'), jsx(Switch, { checked: !!c.save_quota, onCheckedChange: v => saveRouting({ save_quota: v }) }, 's')], { opacity: on ? 1 : 0.5 }),
          on && c.hermes && h.plugin ? jsx(Note, { icon: 'info', children: 'New Hermes chats pick up routing changes; an open chat keeps the routes it started with.' }) : null
        ]
      })
    ]
  })
}

// everything that is working right now: chats mid-reply, and the subagents they handed tasks to
function RunningNow({ data, r, always }) {
  const subs = r ? (r.delegations || []).filter(d => d.state === 'running') : []
  const chats = (data.sessions || []).filter(s => s.running)
  const n = chats.length + subs.length
  if (!n && !always) return null
  const since = ts => (ts ? ago(ts).replace(' ago', '') : '')
  const subRow = (d, nested) =>
    jsxs(
      'div',
      {
        className: 'ca-drow' + (nested ? ' sub' : ''),
        title: `${d.description}\n${d.model || ''}`,
        children: [
          jsx('div', { className: 't', children: d.description }),
          jsx(MChip, { d }),
          jsxs('div', { className: 'ca-sub', children: [jsx('span', { className: 'ca-st running' }), jsx('span', { children: [d.doing || 'working', nested ? null : d.session, since(d.at)].filter(Boolean).join(' · ') })] })
        ]
      },
      'd' + d.id
    )
  const seen = new Set()
  const rows = []
  chats.forEach(s => {
    const kids = subs.filter(d => d.session_id && (d.session_id === s.sid || d.session_id === s.stored_id || d.session_id === s.session_id))
    kids.forEach(d => seen.add(d.id))
    const p = s.context_percent ?? (s.context_used && s.context_max ? (s.context_used / s.context_max) * 100 : null)
    rows.push(
      jsxs(
        'div',
        {
          className: 'ca-drow',
          children: [
            jsx('div', { className: 't', children: s.title || 'Untitled chat' }),
            jsx('span', { className: 'ctx', children: `ctx ${pct(p)}` }),
            jsxs('div', { className: 'ca-sub', children: [jsx('span', { className: 'ca-st running' }), jsx('span', { children: ['chat', kids.length ? `${kids.length} subagent${kids.length > 1 ? 's' : ''}` : 'replying'].join(' · ') })] })
          ]
        },
        's' + s.sid
      )
    )
    kids.forEach(d => rows.push(subRow(d, true)))
  })
  subs.filter(d => !seen.has(d.id)).forEach(d => rows.push(subRow(d, false)))
  return jsxs('div', {
    className: 'ca-sec',
    children: [
      jsx(SectionHead, { title: 'Running now', count: n || null }),
      n ? jsx('div', { className: 'ca-card ca-runs', children: rows }) : jsx('div', { className: 'ca-idle', children: 'Nothing is running. Chats mid-reply and their subagents show up here.' })
    ]
  })
}

function DelegationsSection({ r, limit }) {
  const dels = r.delegations || []
  return jsxs('div', {
    className: 'ca-sec',
    children: [
      jsx(SectionHead, { title: 'Delegated tasks', count: dels.length || null }),
      dels.length
        ? jsxs(Fragment, { children: [jsx('div', { className: 'ca-card', style: { gap: 8 }, children: jsx(Distribution, { dels }) }), jsx(DelegationRows, { dels, limit })] })
        : jsxs('div', { className: 'ca-empty', children: [jsx(Svg, { name: 'route', style: { width: 18, height: 18 } }), jsx('b', { children: 'Nothing delegated yet' }), jsx('div', { children: 'When Hermes hands a task to a subagent it shows up here with the model it ran on.' })] })
    ]
  })
}

function RoutingSummary({ r, setTab }) {
  const dels = r.delegations || []
  return jsxs('div', {
    className: 'ca-sec',
    children: [
      jsx(SectionHead, { title: 'Model routing', right: jsx('button', { className: 'ca-link', onClick: () => setTab('routing'), children: 'Open' }) }),
      jsxs('div', {
        className: 'ca-card',
        style: { gap: 9 },
        children: [
          jsx('div', {
            className: 'ca-routeline',
            children: r.config.enabled
              ? r.tiers.map(t => jsxs('span', { className: 'ca-mchip', style: { '--tc': TCOLOR[t.tier] }, children: [jsx('i', {}), `${t.label} → ${MAIN_LABELS[t.effective] || t.effective}`] }, t.tier))
              : jsx('span', { children: 'Off — every task uses the main model.' })
          }),
          dels.length ? jsx(Distribution, { dels: dels.slice(0, 30) }) : null
        ]
      })
    ]
  })
}

// ─── live chats ───────────────────────────────────────────────────────────────────────────────

function Sessions({ data }) {
  const focused = useValue(host.state.focusedSessionId)
  const stored = useValue(host.state.focusedStoredSessionId || host.state.focusedSessionId)
  const rows = data.sessions || []
  if (!rows.length) return null
  const byId = Object.fromEntries((data.accounts || []).map(a => [a.id, a]))
  return jsxs('div', {
    className: 'ca-sec',
    children: [
      jsx(SectionHead, { title: 'Live chats', count: rows.length }),
      jsx('div', {
        className: 'ca-sess',
        children: rows.slice(0, 12).map(s => {
          const a = s.account_id ? byId[s.account_id] : null
          const p = s.context_percent ?? (s.context_used && s.context_max ? (s.context_used / s.context_max) * 100 : null)
          const t = p == null ? 'muted' : p >= 85 ? 'bad' : p >= 60 ? 'warn' : 'good'
          return jsxs(
            'div',
            {
              className: 'ca-srow' + (isFocused(s, focused, stored) ? ' focused' : ''),
              children: [
                jsx('span', { className: 'ca-dot' + (s.running ? ' live' : '') }),
                jsxs('div', { style: { minWidth: 0 }, children: [jsx('div', { className: 't', children: s.title || 'Untitled chat' }), jsx('div', { className: 'ca-sub', children: a ? displayName(a) : `${s.provider || '—'} · ${s.model || ''}` })] }),
                jsx(Tip, {
                  label: `Context ${fmtK(s.context_used)} / ${fmtK(s.context_max)}${s.compressions ? ` · ${s.compressions} compressions` : ''}`,
                  children: jsxs('div', {
                    className: 'm',
                    children: [a ? jsx(Avatar, { a, p: 'claude', small: true }) : null, jsx('div', { className: 'ca-mini', children: jsx('i', { className: t, style: { width: `${Math.min(100, p || 0)}%` } }) }), jsx('span', { children: pct(p) })]
                  })
                })
              ]
            },
            s.sid
          )
        })
      })
    ]
  })
}

// ─── settings ─────────────────────────────────────────────────────────────────────────────────

function Seg({ value, options, onChange, fmt }) {
  return jsx('div', { className: 'ca-seg', children: options.map(o => jsx('button', { className: o === value ? 'on' : '', onClick: () => onChange(o), children: fmt ? fmt(o) : o }, String(o))) })
}

function Settings({ data }) {
  const s = data.settings
  const save = patch => act(() => post('/settings', patch), null)
  const toggleWin = k => {
    const next = s.windows.includes(k) ? s.windows.filter(x => x !== k) : [...s.windows, k]
    if (next.length) save({ windows: next })
  }
  const pa = s.provider_auto || {}
  const others = presentProviders(data).filter(p => p !== 'claude')
  const thresholds = [75, 80, 85, 90, 95]
  const row = (children, style) => jsxs('div', { className: 'ca-setrow', style, children })
  return jsxs('div', {
    className: 'ca-sec',
    children: [
      jsx(SectionHead, { title: 'Auto-switch' }),
      jsxs('div', {
        className: 'ca-card ca-set',
        children: [
          row([jsxs('div', { className: 'lbl', children: [jsx('b', { children: 'Switch before a limit' }), jsx('span', { children: 'At the threshold, move to the least-used account' })] }, 'l'), jsx(Switch, { checked: !!s.auto_switch, onCheckedChange: v => save({ auto_switch: v }) }, 's')]),
          row([jsx('div', { className: 'lbl', children: jsx('b', { children: 'Threshold' }) }, 'l'), jsx(Seg, { value: thresholds.includes(s.threshold) ? s.threshold : null, options: thresholds, onChange: v => save({ threshold: v }), fmt: v => `${v}%` }, 's')], { opacity: s.auto_switch ? 1 : 0.5 }),
          row(
            [
              jsx('div', { className: 'lbl', children: jsx('b', { children: 'Claude windows' }) }, 'l'),
              jsx(
                'div',
                {
                  className: 'ca-checks',
                  children: [
                    ['five_hour', '5-hour'],
                    ['seven_day', 'Weekly'],
                    ['seven_day_opus', 'Opus wk']
                  ].map(([k, l]) => jsxs('button', { className: 'ca-check' + (s.windows.includes(k) ? ' on' : ''), style: { '--pc': PCOLOR.claude }, onClick: () => toggleWin(k), children: [s.windows.includes(k) ? '● ' : '○ ', l] }, k))
                },
                'c'
              )
            ],
            { opacity: s.auto_switch ? 1 : 0.5, alignItems: 'flex-start' }
          ),
          !others.length ? null : row(
            [
              jsx('div', { className: 'lbl', children: jsx('b', { children: 'Also switch' }) }, 'l'),
              jsx(
                'div',
                {
                  className: 'ca-checks',
                  children: others.map(p =>
                    jsxs('button', { className: 'ca-check' + (pa[p] !== false ? ' on' : ''), style: { '--pc': PCOLOR[p] }, onClick: () => save({ provider_auto: { ...pa, [p]: pa[p] === false } }), children: [jsx(Logo, { p, sm: true }), p === 'copilot' ? 'Copilot' : 'Antigravity'] }, p)
                  )
                },
                'c'
              )
            ],
            { opacity: s.auto_switch ? 1 : 0.5, alignItems: 'flex-start' }
          ),
          row([jsxs('div', { className: 'lbl', children: [jsx('b', { children: 'Move open chats' }), jsx('span', { children: 'Idle Claude chats hop accounts between turns' })] }, 'l'), jsx(Switch, { checked: !!s.move_live_sessions, onCheckedChange: v => save({ move_live_sessions: v }) }, 's')]),
          row([jsx('div', { className: 'lbl', children: jsx('b', { children: 'Check every' }) }, 'l'), jsx(Seg, { value: s.poll_seconds, options: [60, 180, 300, 600], onChange: v => save({ poll_seconds: v }), fmt: v => `${v / 60}m` }, 's')])
        ]
      })
    ]
  })
}

// ─── activity ─────────────────────────────────────────────────────────────────────────────────

const EV_ICON = { routing: 'route', auto_switch: 'swap', manual_switch: 'arrow', session_moved: 'arrow', added: 'plus', imported: 'plus', removed: 'trash', cleared: 'check', all_hot: 'warn', released: 'check', error: 'warn' }

const FOLD_KEY = 'claude-accounts:folded'
function readFolded() {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}
  } catch {
    return {}
  }
}
function useFolded(id) {
  const [shut, setShut] = useState(() => !!readFolded()[id])
  const toggle = () => {
    const next = !shut
    setShut(next)
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify({ ...readFolded(), [id]: next }))
    } catch {
      /* stays collapsed for this window only */
    }
  }
  return [shut, toggle]
}

function Activity({ data, tab }) {
  const [open, setOpen] = useState(false)
  const [shut, toggleShut] = useFolded('activity')
  let evs = data.events || []
  if (tab === 'routing') evs = evs.filter(e => e.kind === 'routing')
  else if (tab !== 'all') evs = evs.filter(e => (e.provider || 'claude') === tab)
  if (!evs.length) return null
  const shown = open ? evs : evs.slice(0, 4)
  return jsxs('div', {
    className: 'ca-sec',
    children: [
      jsxs('div', {
        className: 'ca-sech',
        children: [
          jsxs('button', {
            className: 'ca-foldbtn',
            type: 'button',
            'aria-expanded': !shut,
            title: shut ? 'Show activity' : 'Hide activity',
            onClick: toggleShut,
            children: [jsx('span', { style: { display: 'inline-flex' }, dangerouslySetInnerHTML: { __html: ICONS.chev } }), jsx('span', { children: 'Activity' }), jsx('span', { className: 'n', children: evs.length })]
          }),
          jsx('span', { className: 'sp' }),
          !shut && evs.length > 4 ? jsx('button', { className: 'ca-link', onClick: () => setOpen(!open), children: open ? 'Less' : `All ${evs.length}` }) : null
        ]
      }),
      shut ? null : jsx('div', {
        className: 'ca-log',
        children: shown.map(e =>
          jsxs('div', { className: 'ca-ev ' + e.kind, children: [jsx('span', { className: 'k', dangerouslySetInnerHTML: { __html: ICONS[EV_ICON[e.kind] || 'dot'] } }), jsxs('div', { children: [e.message, jsx('small', { children: ago(e.at) })] })] }, (e.provider || 'c') + e.id)
        )
      })
    ]
  })
}

// ─── add: menu + login sheet ──────────────────────────────────────────────────────────────────

function AddMenu({ data, onAdd }) {
  const count = p => (p === 'claude' ? (data && data.accounts ? data.accounts.length : 0) : (((data && data.providers) || {})[p] || { accounts: [] }).accounts.length)
  return jsxs(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, {
        asChild: true,
        children: jsxs('button', { className: 'ca-addbtn', 'aria-label': 'Connect another account', children: [jsx(Svg, { name: 'plus' }), jsx('span', { className: 't', children: 'Add' }), jsx('span', { className: 'ca-ic', style: { width: 10, height: 10, opacity: 0.6 }, dangerouslySetInnerHTML: { __html: ICONS.chev } })] })
      }),
      jsxs(DropdownMenuContent, {
        align: 'end',
        children: [
          jsx('div', { className: 'ca-menu-h', style: { padding: '6px 8px 4px', fontSize: 10, fontWeight: 650, letterSpacing: '.07em', textTransform: 'uppercase', opacity: 0.6 }, children: 'Connect an account' }),
          ...PROVIDERS.map(p =>
            jsx(
              DropdownMenuItem,
              {
                onSelect: () => onAdd(p.id),
                children: jsxs('div', {
                  className: 'ca-mi-row',
                  style: { '--pc': PCOLOR[p.id] },
                  children: [jsx(Logo, { p: p.id }), jsxs('div', { style: { minWidth: 0 }, children: [jsx('b', { children: p.name }), jsx('span', { className: 's', children: p.blurb })] }), count(p.id) ? jsx('em', { children: count(p.id) }) : jsx('span', {})]
                })
              },
              p.id
            )
          )
        ]
      })
    ]
  })
}

function LoginSheet({ login, setLogin }) {
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const p = login.provider
  const m = meta(p)
  const done = login.status === 'done'
  const failed = ['error', 'expired', 'cancelled'].includes(login.status)

  // poll the background sign-in helper (Antigravity browser flow, Copilot device flow)
  useEffect(() => {
    if (p === 'claude' || !login.login_id || login.status !== 'pending') return
    let stop = false
    const t = setInterval(async () => {
      try {
        const st = await pcall('status', { login_id: login.login_id })
        if (stop || !st) return
        if (st.status !== 'pending') {
          setLogin(l => (l && l.login_id === login.login_id ? { ...l, ...st } : l))
          if (st.status === 'done') {
            haptic('success')
            host.notify({ kind: 'success', message: `Connected ${m.name} · ${st.label}` })
            if (st.warning) host.notify({ kind: 'warning', message: st.warning })
            refetch()
          }
        }
      } catch {}
    }, 2000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [login.login_id, login.status])

  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setLogin(l => (l === login ? null : l)), 6000)
    return () => clearTimeout(t)
  }, [done])

  const finishClaude = async () => {
    if (!code.trim() || busy) return
    setBusy(true)
    try {
      const res = await post('/login/finish', { login_id: login.login_id, code: code.trim(), label: '' })
      if (!res || !res.ok) throw new Error((res && res.error) || 'Login failed')
      haptic('success')
      setLogin({ ...login, status: 'done', label: res.label, warning: res.warning })
      refetch()
    } catch (e) {
      setLogin({ ...login, error: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => {
    if (!done && !failed && login.login_id && p !== 'claude') pcall('cancel', { login_id: login.login_id }).catch(() => {})
    setLogin(null)
  }

  let body
  if (done) body = jsxs('div', { className: 'ca-moved', children: [jsx(Svg, { name: 'check' }), jsxs('span', { children: ['Connected ', jsx('b', { children: login.label }), login.warning ? ` — ${login.warning}` : ''] })] })
  else if (failed) body = jsxs(Fragment, { children: [jsx('div', { className: 'ca-err', children: login.error || 'Sign-in did not finish.' }), jsx('div', { className: 'ca-sheet-a', children: jsx(UseButton, { label: 'Try again', onClick: () => startLogin(p, setLogin) }) })] })
  else if (login.status === 'starting') body = jsxs('div', { className: 'ca-wait', children: [jsx('span', { className: 'orb' }), jsx('span', { children: 'Starting sign-in…' })] })
  else if (p === 'copilot')
    body = jsxs(Fragment, {
      children: [
        jsx('div', {
          className: 'ca-devcode',
          title: 'Your one-time code',
          children: (login.user_code || '').split('').map((c, i) => (c === '-' ? jsx('span', { className: 'sep', children: '–' }, i) : jsx('span', { style: { animationDelay: `${i * 35}ms` }, children: c }, i)))
        }),
        jsxs('div', {
          className: 'ca-sheet-a',
          children: [
            jsx(UseButton, {
              label: 'Copy & open GitHub',
              onClick: async () => {
                setCopied(await copyText(login.user_code))
                openUrl(login.verification_uri)
              }
            }),
            jsxs('button', { className: 'ca-ghost', onClick: async () => setCopied(await copyText(login.user_code)), children: [jsx(Svg, { name: copied ? 'check' : 'copy' }), copied ? 'Copied' : 'Copy'] })
          ]
        }),
        jsxs('div', { className: 'ca-wait', children: [jsx('span', { className: 'orb' }), jsxs('span', { children: ['Paste the code at ', jsx('b', { children: 'github.com/login/device' }), ' and approve — this updates by itself.'] })] })
      ]
    })
  else if (p === 'antigravity')
    body = jsxs(Fragment, {
      children: [
        jsxs('div', { className: 'ca-wait', children: [jsx('span', { className: 'orb' }), jsx('span', { children: 'Finish signing in with Google in your browser and pick the account to add — this updates by itself.' })] }),
        jsx('div', { className: 'ca-sheet-a', children: jsxs('button', { className: 'ca-ghost', onClick: () => openUrl(login.url), children: [jsx(Svg, { name: 'external' }), 'Open sign-in again'] }) })
      ]
    })
  else
    body = jsxs(Fragment, {
      children: [
        jsx('div', { className: 'ca-sub', style: { whiteSpace: 'normal' }, children: 'Sign in on claude.ai (use a private window if you’re signed in to another account), click Authorize, then paste the code:' }),
        jsx('input', { placeholder: 'code#state', value: code, autoFocus: true, spellCheck: false, onChange: e => setCode(e.target.value), onKeyDown: e => (e.key === 'Enter' ? finishClaude() : null) }),
        jsxs('div', {
          className: 'ca-sheet-a',
          children: [
            jsx(UseButton, { label: busy ? 'Connecting…' : 'Connect', onClick: finishClaude }),
            jsxs('button', { className: 'ca-ghost', onClick: () => openUrl(login.url), children: [jsx(Svg, { name: 'external' }), 'Open sign-in again'] })
          ]
        }),
        login.error ? jsx('div', { className: 'ca-err', children: login.error }) : null
      ]
    })

  return jsxs('div', {
    className: 'ca-sheet',
    style: { '--pc': PCOLOR[p] },
    children: [
      jsxs('div', {
        className: 'ca-sheet-h',
        children: [
          jsx(Logo, { p }),
          jsxs('div', { children: [jsx('b', { children: done ? 'Account connected' : `Connect ${m.name}` }), jsx('span', { children: m.blurb + (!done && !failed && login.expires_at ? ` · expires ${inFuture(login.expires_at)}` : '') })] }),
          jsx('button', { className: 'ca-iconbtn ca-x', 'aria-label': done || failed ? 'Close' : 'Cancel', onClick: cancel, children: jsx(Svg, { name: 'x' }) })
        ]
      }),
      body
    ]
  })
}

async function startLogin(p, setLogin) {
  haptic('tap')
  setLogin({ provider: p, status: 'starting' })
  try {
    const res = p === 'claude' ? await post('/login/start', { label: '' }) : await pcall('start', { provider: p })
    if (!res || res.ok === false) throw new Error((res && res.error) || 'Could not start sign-in')
    setLogin({ ...res, provider: p, status: 'pending' })
    if (p === 'claude' || p === 'antigravity') openUrl(res.url)
    if (p === 'copilot') copyText(res.user_code)
  } catch (e) {
    setLogin({ provider: p, status: 'error', error: errMsg(e) })
  }
}

// ─── pane ─────────────────────────────────────────────────────────────────────────────────────

function Tabs({ data, tab, setTab }) {
  const thr = data.settings.threshold
  const accts = p => (p === 'claude' ? data.accounts || [] : ((data.providers || {})[p] || { accounts: [] }).accounts)
  const hot = p => accts(p).some(a => (a.active || a.live) && a.peak_pct != null && a.peak_pct >= thr)
  const ps = presentProviders(data)
  const hasRouting = !!(data.routing && data.routing.config)
  if (ps.length < 2 && !hasRouting) return null
  const total = ps.reduce((n, p) => n + accts(p).length, 0)
  const t = (id, label) =>
    jsxs(
      'button',
      {
        className: 'ca-tab' + (tab === id ? ' on' : ''),
        role: 'tab',
        'aria-selected': tab === id,
        style: id !== 'all' ? { '--pc': PCOLOR[id] } : undefined,
        onClick: () => setTab(id),
        children: [
          id !== 'all' ? jsx('span', { className: 'ca-ic', style: { width: 11, height: 11 }, dangerouslySetInnerHTML: { __html: ICONS[id] } }) : null,
          jsx('span', { className: 'lbl', children: label }),
          id !== 'all' && hot(id) ? jsx('span', { className: 'hot', title: 'Over the threshold' }) : (id === 'all' ? total : accts(id).length) ? jsx('i', { children: id === 'all' ? total : accts(id).length }) : null
        ]
      },
      id
    )
  const label = { claude: 'Claude', antigravity: 'Antigravity', copilot: 'Copilot' }
  const routeTab = hasRouting
    ? jsxs('button', { className: 'ca-tab' + (tab === 'routing' ? ' on' : ''), role: 'tab', 'aria-selected': tab === 'routing', onClick: () => setTab('routing'), children: [jsx('span', { className: 'ca-ic', style: { width: 11, height: 11 }, dangerouslySetInnerHTML: { __html: ICONS.route } }), jsx('span', { className: 'lbl', children: 'Routing' })] }, 'routing')
    : null
  return jsxs('div', { className: 'ca-tabs', role: 'tablist', children: [t('all', 'All'), ...(ps.length > 1 ? ps.map(p => t(p, label[p])) : []), routeTab] })
}

function Pane() {
  const sw = useSwitch()
  const q = useAccounts()
  const [refreshing, setRefreshing] = useState(false)
  const [removing, setRemoving] = useState(null)
  const [login, setLogin] = useState(null)
  const [tab, setTabState] = useState(TAB)
  const [, tick] = useState(0)
  const setTab = t => {
    TAB = t
    setTabState(t)
  }

  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 30_000) // re-render relative times
    return () => clearInterval(t)
  }, [])

  const refresh = async () => {
    setRefreshing(true)
    try {
      const snap = await rest('/refresh', { method: 'POST', body: {} })
      queryClient.setQueryData(QK, snap)
    } catch (e) {
      host.notify({ kind: 'error', message: errMsg(e) })
    } finally {
      setRefreshing(false)
    }
  }
  const onAdd = p => {
    if (tab !== 'all' && tab !== p) setTab(p)
    startLogin(p, setLogin)
  }

  const data = q.data
  if (data && data.accounts) {
    assignHues(data)
    THRESHOLD = data.settings.threshold
  }
  const total = data && data.ok ? (data.accounts || []).length + Object.values(data.providers || {}).reduce((n, i) => n + (i.accounts || []).length, 0) : 0

  const header = jsxs('div', {
    className: 'ca-head',
    children: [
      jsxs('div', {
        className: 'ca-brand',
        children: [
          jsx('span', { className: 'ca-mark', children: jsx('i', { dangerouslySetInnerHTML: { __html: ICONS.mark } }) }),
          jsxs('div', { children: [jsx('b', { children: 'Switchboard' }), jsx('small', { children: data && data.ok ? `${total} account${total === 1 ? '' : 's'} · Claude, Antigravity, Copilot` : 'loading…' })] })
        ]
      }),
      jsx(Tip, { label: 'Re-check every account now', children: jsx('button', { className: 'ca-iconbtn', onClick: refresh, 'aria-label': 'Refresh', children: jsx(Svg, { name: refreshing ? 'sync' : 'refresh', style: { width: 15, height: 15 } }) }) }),
      jsx(AddMenu, { data, onAdd })
    ]
  })

  let body
  if (q.isLoading) {
    body = jsxs(Fragment, { children: [jsx('div', { className: 'ca-skel' }), jsx('div', { className: 'ca-skel' }), jsx('div', { className: 'ca-skel' })] })
  } else if (q.isError || !data || !data.ok) {
    body = jsxs('div', {
      className: 'ca-empty',
      children: [
        jsx(Svg, { name: 'warn', style: { width: 22, height: 22 } }),
        jsx('b', { children: 'Backend not reachable' }),
        jsxs('div', { children: ['Enable the plugin’s Python half:', jsx('br', {}), jsx('span', { className: 'ca-code', children: 'hermes plugins enable claude-accounts' })] }),
        jsx('div', { className: 'ca-sub', children: q.error ? errMsg(q.error) : '' }),
        jsx(UseButton, { label: 'Try again', onClick: () => q.refetch() })
      ]
    })
  } else {
    const s = data.settings
    const ps = presentProviders(data)
    const r = data.routing && data.routing.config ? data.routing : null
    const curTab = tab === 'routing' ? (r ? 'routing' : 'all') : tab !== 'all' && (!ps.includes(tab) || ps.length < 2) ? 'all' : tab
    const showClaude = (curTab === 'all' || curTab === 'claude') && ps.includes('claude')
    const groups = curTab === 'all' ? ps : [curTab]
    body = jsxs(Fragment, {
      children: [
        jsx(Tabs, { data, tab: curTab, setTab }),
        jsxs('div', {
          className: 'ca-strip',
          children: [
            jsxs('button', { className: 'ca-pill' + (s.auto_switch ? ' on' : ''), onClick: () => act(() => post('/settings', { auto_switch: !s.auto_switch }), null), children: [jsx('span', { className: 'ca-dot ' + (s.auto_switch ? 'good' : '') }), s.auto_switch ? `Auto-switch at ${s.threshold}%` : 'Auto-switch off'] }),
            jsx('span', { children: data.last_check_at ? `checked ${ago(data.last_check_at)}` : 'first check pending…' })
          ]
        }),
        sw
          ? jsxs(
              'div',
              {
                className: 'ca-banner ' + sw.phase,
                children: [
                  jsx(Svg, { name: sw.phase === 'pending' ? 'sync' : 'check' }),
                  jsx('span', { children: sw.phase === 'pending' ? `Switching ${meta(sw.provider).name} to ${sw.name}…` : `${meta(sw.provider).name} now uses ${sw.name}${sw.moved ? ` · ${sw.moved} chat${sw.moved > 1 ? 's' : ''} moved` : ''}` })
                ]
              },
              sw.phase + sw.at
            )
          : null,
        login ? jsx(LoginSheet, { login, setLogin }, (login.login_id || login.provider) + login.status) : null,
        curTab === 'routing' ? jsx(RunningNow, { data, r, always: true }) : null,
        curTab === 'routing' ? jsx(RoutingCard, { r }) : null,
        curTab === 'routing' ? jsx(DelegationsSection, { r, limit: 40 }) : null,
        showClaude ? jsxs('div', { className: 'ca-sec', children: [jsx(SectionHead, { title: 'This chat' }), jsx(CurrentChat, { data })] }) : null,
        curTab === 'all' ? jsx(RunningNow, { data, r }) : null,
        curTab === 'routing' ? null : groups.length
          ? jsx('div', { className: 'ca-groups', children: groups.map(p => jsx(ProviderGroup, { p, data, onAdd, onRemove: setRemoving }, p)) })
          : jsxs('div', { className: 'ca-empty', children: [jsx(Svg, { name: 'plus', style: { width: 18, height: 18 } }), jsx('b', { children: 'No accounts yet' }), jsx('div', { children: 'Use Add at the top to connect Claude, Antigravity or GitHub Copilot.' })] }),
        curTab === 'all' && r ? jsx(RoutingSummary, { r, setTab }) : null,
        showClaude ? jsx(Sessions, { data }) : null,
        curTab === 'routing' ? null : jsx(Settings, { data }),
        jsx(Activity, { data, tab: curTab })
      ]
    })
  }

  const rp = removing && (removing.provider || 'claude')
  return jsx('div', {
    className: 'ca-root',
    children: jsxs('div', {
      className: 'ca',
      children: [
        jsx(Style, {}),
        header,
        body,
        jsx(ConfirmDialog, {
          open: !!removing,
          onClose: () => setRemoving(null),
          destructive: true,
          title: removing ? `Remove ${displayName(removing)}?` : 'Remove account?',
          description: rp === 'claude' ? 'Hermes stops using this login. Your Claude account itself is not affected — you can connect it again later.' : `Switchboard forgets this ${meta(rp).name} login. The account itself is not affected.`,
          confirmLabel: 'Remove',
          onConfirm: async () => {
            await act(() => (rp === 'claude' ? post('/remove', { id: removing.id }) : pcall('remove', { provider: rp, id: removing.id })), 'Account removed')
          }
        })
      ]
    })
  })
}

// ─── status bar chip ──────────────────────────────────────────────────────────────────────────

function Chip() {
  const q = useAccounts()
  const d = q.data
  if (!d || !d.ok || !(d.accounts || []).length) return null
  const active = d.accounts.find(a => a.active) || d.accounts[0]
  const p = active.peak_pct
  const t = tone(p, d.settings.threshold)
  const lines = [...d.accounts.map(a => ({ ...a, provider: 'claude' })), ...Object.entries(d.providers || {}).flatMap(([pp, i]) => (i.accounts || []).map(a => ({ ...a, provider: pp, active: a.live })))]
  const label = jsx('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2 },
    children: lines.map(a =>
      jsx(
        'div',
        { children: `${a.active ? '▶ ' : ''}${meta(a.provider).name} · ${displayName(a)} — ${Object.values((a.usage && a.usage.windows) || {}).map(w => `${w.label.split(' ·')[0]} ${Math.round(w.pct)}%`).join(' · ') || a.status}` },
        a.provider + a.id
      )
    )
  })
  return jsx(Tip, {
    label,
    children: jsxs('button', {
      className: 'ca-chipbtn',
      type: 'button',
      onClick: () => CTX.runAction && CTX.runAction('view.toggleRightSidebar'),
      children: [jsx(Style, {}), jsx('span', { className: 'ca-dot ' + t }), `Claude ${pct(p)}`, lines.length > 1 ? jsx('span', { style: { opacity: 0.6 }, children: `· ${lines.length} accts` }) : null]
    })
  })
}

// ─── registration ─────────────────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Switchboard',
  description: 'Multiple Claude, Antigravity and GitHub Copilot accounts: usage per account, context per chat, auto-switch at a threshold.',
  register(ctx) {
    CTX = ctx
    ctx.register({ id: 'pane', area: 'panes', title: 'Switchboard', data: { placement: 'right', width: '330px' }, render: () => jsx(Pane, {}) })
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 125, render: () => jsx(Chip, {}) })
    const off1 = host.onEvent(`plugin.${ID}.updated`, () => refetch())
    const off2 = host.onEvent(`plugin.${ID}.event`, ev => {
      const e = (ev && ev.payload) || ev || {}
      refetch()
      if (e.kind === 'auto_switch' || e.kind === 'all_hot') {
        host.notify({ kind: e.kind === 'all_hot' ? 'warning' : 'info', title: 'Switchboard', message: e.message })
        if (ctx.os && ctx.os.notify) ctx.os.notify({ title: 'Account switched', body: e.message })
      }
    })
    ctx.onDispose(() => {
      off1 && off1()
      off2 && off2()
      CTX = null
    })
  }
}
