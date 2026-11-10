// Switchboard (claude-accounts) — VS Code webview. Vanilla JS; state comes from the extension host (extension.js).
// Built from ui/panel.src.js by tools/build.py (icons injected) — edit the source, not media/panel.js.
;(function () {
  /*@@ICONS*/
  /*@@END_ICONS*/

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: m => window.__post && window.__post(m), getState: () => null, setState: () => {} }
  const root = document.getElementById('root')
  const saved = vscode.getState() || {}
  let state = saved.state || null
  let tab = saved.tab || 'all'
  let error = null
  let sw = null // { provider, id, name, phase: 'pending'|'done'|'err', error }
  let refreshing = false
  let refreshingOne = null // 'provider:id' while a single account is being re-read
  let menu = false
  let login = null // { provider, status, login_id, url, user_code, verification_uri, expires_at, error, label }
  let lastChip = null
  let lastRing = null
  let showAllEv = false
  let folded = saved.folded || {} // section id → collapsed
  let copied = false
  let noFlip = false // tab changes re-layout everything; only real reorders should glide

  // persistent scroll container: replacing it would reset scroll on every refresh
  root.innerHTML = '<div class="ca" id="ca"></div>'
  const ca = root.firstChild

  const post = m => vscode.postMessage(m)
  const persist = () => vscode.setState({ state, tab, folded })
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const fmtK = n => (n == null || isNaN(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(Math.round(n)))
  const pct = n => (n == null ? '—' : Math.round(n) + '%')
  const tone = (p, thr) => (p == null ? 'muted' : p >= thr ? 'bad' : p >= Math.min(70, thr - 10) ? 'warn' : 'good')
  const name = a => (a && (a.email || a.login || a.name || a.label)) || 'Unknown'
  const inFuture = ts => {
    if (!ts) return ''
    const s = Math.max(0, Math.round(ts - Date.now() / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24)
    return d ? `in ${d}d ${h % 24}h` : h ? `in ${h}h ${m % 60}m` : `in ${Math.max(1, m)}m`
  }
  const ago = ts => {
    if (!ts) return 'never'
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
    return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
  }
  const clock = ts => {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`
  }
  const HUES = [212, 152, 28, 276, 344, 52, 188, 104]
  const allAccounts = () => (state ? [...(state.accounts || []).map(a => ({ ...a, provider: 'claude' })), ...Object.values(state.providers || {}).flatMap(p => p.accounts || [])] : [])
  const hue = a => {
    const keys = allAccounts().map(x => x.provider + (x.account_uuid || x.id)).sort()
    const i = keys.indexOf((a.provider || 'claude') + (a.account_uuid || a.id))
    return HUES[(i < 0 ? 0 : i) % HUES.length]
  }
  const initials = a => {
    const src = (a.name || a.email || a.login || a.label || '?').replace(/@.*/, '')
    const p = src.split(/[\s._-]+/).filter(Boolean)
    return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase()
  }
  const logo = (p, sm) => `<span class="ca-logo${sm ? ' sm' : ''}" style="--pc:${PCOLOR[p]}">${ICONS[p]}</span>`
  const av = (a, sm) => {
    const p = a.provider || 'claude'
    const face = a.picture ? `<img src="${esc(a.picture)}" alt="" referrerpolicy="no-referrer">` : esc(initials(a))
    return `<div class="ca-av${sm ? ' sm' : ''}" style="--h:${hue(a)};--pc:${PCOLOR[p]}">${face}${sm ? '' : `<span class="pb">${ICONS[p]}</span>`}</div>`
  }
  const thr = () => (state && state.settings ? state.settings.threshold : 90)
  const provInfo = p => (p === 'claude' ? { id: 'claude', name: 'Claude', accounts: state.accounts || [], auto_switch: true, available: true } : (state.providers || {})[p] || { id: p, name: p, accounts: [], available: false })
  const present = () => (state ? ['claude', 'antigravity', 'copilot'].filter(p => (provInfo(p).accounts || []).length) : [])
  const sortActiveFirst = list => list.map((a, i) => [a, i]).sort((x, y) => (y[0].live ? 1 : 0) - (x[0].live ? 1 : 0) || x[1] - y[1]).map(x => x[0])

  // ─── pieces ─────────────────────────────────────────────────────────────────────────────────

  // ─── model routing ──────────────────────────────────────────────────────────────────────────

  const rt = () => (state && state.routing && state.routing.config ? state.routing : null)
  const mchip = d => `<span class="ca-mchip" style="--tc:${d.tier ? TCOLOR[d.tier] : 'var(--ca-t3)'}" title="${esc(d.model || '')}"><i></i>${esc(d.model_label || '—')}</span>`
  const fmtTok = n => (n ? fmtK(n) + ' tok' : '')

  function distribution(dels) {
    if (!dels.length) return ''
    const by = {}
    dels.forEach(d => {
      const k = d.model_label || '—'
      by[k] = by[k] || { n: 0, tier: d.tier }
      by[k].n++
    })
    const rows = Object.entries(by).sort((a, b) => ['fast', 'balanced', 'deep'].indexOf(a[1].tier) - ['fast', 'balanced', 'deep'].indexOf(b[1].tier))
    const tc = t => (t ? TCOLOR[t] : 'var(--ca-t4)')
    return `<div class="ca-dist">${rows.map(([, v]) => `<span style="flex:${v.n};--tc:${tc(v.tier)}"></span>`).join('')}</div>
      <div class="ca-legend">${rows.map(([k, v]) => `<span style="--tc:${tc(v.tier)}"><i></i>${esc(k)} <b>${v.n}</b></span>`).join('')}</div>`
  }

  function delegationRows(dels, limit) {
    return `<div class="ca-dels">${dels
      .slice(0, limit)
      .map(
        d => `<div class="ca-drow" title="${esc(d.description)}\n${esc(d.model || '')} · ${esc(d.agent)} · ${esc(d.session)}"><div class="t">${esc(d.description)}</div>${mchip(d)}
        <div class="ca-sub"><span class="ca-st ${esc(d.state)}"></span><span>${esc(d.state === 'running' ? 'running' : d.state === 'error' ? 'failed' : ago(d.at))} · ${esc(d.agent)}${d.session ? ' · ' + esc(d.session) : ''}${d.tokens_out ? ' · ' + fmtTok(d.tokens_out) : ''}</span></div></div>`
      )
      .join('')}</div>`
  }

  function routingCard() {
    const r = rt()
    if (!r) return ''
    const c = r.config
    const on = c.enabled
    const sw = (key, val, label) => `<button class="ca-switch${val ? ' on' : ''}" data-act="rset" data-key="${key}" data-val="${!val}" role="switch" aria-checked="${!!val}" aria-label="${label}"></button>`
    const tiers = r.tiers
      .map(
        (t, i) => `<div class="ca-tier${i ? '' : ' first'}" style="--tc:${TCOLOR[t.tier]}"><div class="ca-tier-h"><span class="tdot"></span><b>${esc(t.label)}</b><span class="ca-sub">${esc(t.blurb)}</span></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><div class="ca-seg">${MODEL_CHOICES.map(([v, l]) => `<button class="${t.model === v ? 'on' : ''}" data-act="rset" data-key="tiers.${t.tier}" data-val="${v}">${l}</button>`).join('')}</div>
        <span class="ca-sub">${esc(t.model_label)}${t.effective !== t.model ? ' · saving quota' : ''} · <span class="ca-code">${esc(t.agent)}</span></span></div></div>`
      )
      .join('')
    const conflict = (r.agents || []).filter(a => a.conflict).map(a => a.agent)
    return `<div class="ca-sec"><div class="ca-sech"><span>Model routing</span></div><div class="ca-card ca-set">
      <div class="ca-setrow"><div class="lbl"><b>Route tasks by size</b><span>Small tasks go to a fast model, hard thinking to the best one</span></div>${sw('enabled', on, 'Model routing')}</div>
      <div style="display:flex;flex-direction:column;gap:11px;opacity:${on ? 1 : 0.5}">${tiers}</div>
      ${r.downgraded ? `<div class="ca-note warn">${ICONS.pause}<span>Saving quota: Claude is over the threshold with no account to switch to, so every tier uses one model smaller until it recovers.</span></div>` : ''}
      ${conflict.length ? `<div class="ca-note warn">${ICONS.warn}<span>You already have your own ${esc(conflict.join(', '))} agent — left it untouched.</span></div>` : ''}
      <div class="ca-setrow" style="opacity:${on ? 1 : 0.5}"><div class="lbl"><b>Claude Code main model</b><span>Opus plan: Opus plans, Sonnet does the work</span></div>
        <div class="ca-seg">${['default', 'opusplan', 'opus', 'sonnet'].map(v => `<button class="${c.claude_code_main === v ? 'on' : ''}" data-act="rset" data-key="claude_code_main" data-val="${v}">${MAIN_LABELS[v]}</button>`).join('')}</div></div>
      <div class="ca-setrow" style="opacity:${on ? 1 : 0.5}"><div class="lbl"><b>Claude Code agents</b><span>fast-worker, builder, architect in ~/.claude/agents</span></div>${sw('claude_code_agents', c.claude_code_agents, 'Claude Code agents')}</div>
      <div class="ca-setrow" style="opacity:${on ? 1 : 0.5}"><div class="lbl"><b>Save quota</b><span>Near the limit with nowhere to switch, use one model smaller</span></div>${sw('save_quota', c.save_quota, 'Save quota')}</div>
    </div></div>`
  }

  function delegationsSection(limit) {
    const r = rt()
    if (!r) return ''
    const dels = r.delegations || []
    const head = `<div class="ca-sech"><span>Delegated tasks</span><span class="n">${dels.length || ''}</span></div>`
    if (!dels.length) return `<div class="ca-sec">${head}<div class="ca-empty">${ICONS.route}<b>Nothing delegated yet</b><div>When Claude Code hands a task to a sub-agent it shows up here with the model it ran on.</div></div></div>`
    return `<div class="ca-sec">${head}<div class="ca-card" style="gap:8px">${distribution(dels)}</div>${delegationRows(dels, limit)}</div>`
  }


  // everything that is working right now: active sessions, and the sub-agents they handed tasks to
  function runningNow(always) {
    const r = rt()
    const subs = r ? (r.delegations || []).filter(d => d.state === 'running') : []
    const sess = (state.sessions || []).filter(s => s.running)
    const n = sess.length + subs.length
    const head = `<div class="ca-sech"><span>Running now</span><span class="n">${n || ''}</span></div>`
    if (!n) return always ? `<div class="ca-sec">${head}<div class="ca-idle">Nothing is running. Active sessions and their sub-agents show up here.</div></div>` : ''
    const forSec = ts => (ts ? ago(ts).replace(' ago', '') : '')
    const subRow = (d, nested) => `<div class="ca-drow${nested ? ' sub' : ''}" title="${esc(d.description)}\n${esc(d.model || '')}"><div class="t">${esc(d.description)}</div>${mchip(d)}
      <div class="ca-sub"><span class="ca-st running"></span><span>${esc([d.doing || 'working', d.agent, nested ? '' : d.session, forSec(d.at)].filter(Boolean).join(' · '))}</span></div></div>`
    const seen = new Set()
    const rows = sess
      .map(s => {
        const kids = subs.filter(d => d.session_id === s.id)
        kids.forEach(d => seen.add(d.id))
        return `<div class="ca-drow" data-act="open" data-path="${esc(s.path)}" style="cursor:pointer"><div class="t">${esc(s.title)}</div><span class="ctx">ctx ${pct(s.context_percent)}</span>
          <div class="ca-sub"><span class="ca-st running"></span><span>${esc(['session', s.project, kids.length ? `${kids.length} sub-agent${kids.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '))}</span></div></div>${kids.map(d => subRow(d, true)).join('')}`
      })
      .join('')
    return `<div class="ca-sec">${head}<div class="ca-card ca-runs">${rows}${subs.filter(d => !seen.has(d.id)).map(d => subRow(d, false)).join('')}</div></div>`
  }

  function routingSummary() {
    const r = rt()
    if (!r) return ''
    const dels = r.delegations || []
    const tiers = r.tiers.map(t => `<span class="ca-mchip" style="--tc:${TCOLOR[t.tier]}"><i></i>${esc(t.label)} → ${esc(MAIN_LABELS[t.effective] || t.effective)}</span>`).join('')
    return `<div class="ca-sec"><div class="ca-sech">${ICONS.route.replace('<svg', '<svg width="12" height="12"')}<span>Model routing</span><span class="sp"></span><button class="ca-link" data-act="tab" data-tab="routing">Open</button></div>
      <div class="ca-card" style="gap:9px"><div class="ca-routeline">${r.config.enabled ? tiers : '<span>Off — every task uses the main model.</span>'}</div>
      ${dels.length ? distribution(dels.slice(0, 30)) : ''}</div></div>`
  }

  function sessionDelegations(sessionId) {
    const r = rt()
    const dels = r ? (r.delegations || []).filter(d => d.session_id === sessionId) : []
    if (!dels.length) return ''
    const by = {}
    dels.forEach(d => (by[d.model_label] = by[d.model_label] || { n: 0, d }) && by[d.model_label].n++)
    return `<div class="ca-sessdel"><span>Delegated ${dels.length} task${dels.length > 1 ? 's' : ''}:</span>${Object.values(by).map(v => mchip({ ...v.d, model_label: `${v.d.model_label} ×${v.n}` })).join('')}</div>`
  }

  function ring(p) {
    const r = 27, c = 2 * Math.PI * r, v = p == null ? 0 : Math.max(0, Math.min(100, p))
    const t = p == null ? 'muted' : v >= 85 ? 'bad' : v >= 60 ? 'warn' : 'good'
    const from = lastRing == null ? v : lastRing
    return `<div class="ca-ring"><svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="${r}" fill="none" stroke-width="6"/>
      <circle class="fg ${t}" data-to="${c * (1 - v / 100)}" cx="32" cy="32" r="${r}" fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - from / 100)}"/></svg>
      <div class="c"><div><b>${p == null ? '—' : Math.round(v) + '%'}</b><span>context</span></div></div></div>`
  }

  function current() {
    const s = state.current_session
    const live = (state.accounts || []).find(a => a.live)
    if (!s) return `<div class="ca-card"><div class="ca-sub">No Claude Code session yet — start one with <span class="ca-code">claude</span> or the Claude Code panel.</div></div>`
    const la = live && { ...live, provider: 'claude' }
    const chipNew = live && lastChip !== live.id
    const flash = sw && sw.provider === 'claude' && sw.phase === 'done' && live && live.id === sw.id
    const target = sw && sw.provider === 'claude' && sw.phase !== 'err' ? (state.accounts || []).find(a => a.id === sw.id) : null
    const moving = target && live && target.id !== live.id
    return `<div class="ca-card${flash ? ' ca-flash' : ''}">
      <div class="ca-ctx">${ring(s.context_percent)}
        <div class="ca-kv">
          <div class="big">${fmtK(s.context_used)}<small> / ${fmtK(s.context_max)} tokens</small></div>
          <div class="ca-sub" title="${esc(s.title)}">${esc(s.title)}</div>
          ${la ? `<div class="ca-chip${chipNew ? ' ca-enter' : ''}" title="Claude Code bills ${esc(name(la))}">${av(la, true)}<span>${esc(name(la))}</span></div>` : ''}
        </div></div>
      ${moving ? `<div class="ca-move">${av(la, true)}<span class="ca-dots"><i></i><i></i><i></i></span>${av({ ...target, provider: 'claude' }, true)}<span>Switching Claude Code to ${esc(name(target))}…</span></div>` : ''}
      ${flash ? `<div class="ca-moved">${ICONS.check}<span>New sessions bill ${esc(name(la))}.${s.running ? ' Restart this open session to move it over.' : ''}</span></div>` : ''}
      ${sessionDelegations(s.id)}
      <div class="ca-stats three">
        <div class="ca-stat"><b>${esc(s.project || '—')}</b><span>project</span></div>
        <div class="ca-stat"><b>${esc((s.model || '—').replace('claude-', ''))}</b><span>model</span></div>
        <div class="ca-stat"><b>${s.running ? 'active' : ago(s.updated_at)}</b><span>last turn</span></div>
      </div></div>`
  }

  const WIN_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'claude', 'gemini_pro', 'gemini_flash', 'other', 'premium_interactions', 'chat', 'completions']

  function meters(a, provider) {
    const t0 = thr()
    const watch = provider === 'claude' ? state.settings.windows : null
    const wins = Object.values((a.usage && a.usage.windows) || {}).sort((x, y) => WIN_ORDER.indexOf(x.key) - WIN_ORDER.indexOf(y.key))
    if (!wins.length) {
      if (a.usage_error) return ''
      const unl = (a.usage && a.usage.unlimited) || []
      if (unl.length) return `<div class="ca-note">${ICONS.info}<span>${esc(unl.join(' & '))} unlimited on this plan.</span></div>`
      return `<div class="ca-skel" style="height:38px"></div>`
    }
    return `<div class="ca-meters">${wins
      .map(w => {
        const t = tone(w.pct, t0)
        const right = [w.used != null && w.limit ? `${Math.round(w.used)}/${w.limit}` : null, w.resets_at ? `resets ${inFuture(w.resets_at)}` : null].filter(Boolean).join(' · ')
        const tick = !watch || watch.includes(w.key)
        return `<div class="ca-meter" title="${Math.round(w.pct)}% used${w.resets_at ? ' · resets ' + clock(w.resets_at) : ''}${w.models ? '\n' + esc(w.models.join(', ')) : ''}">
          <div class="ca-mrow"><span class="l">${esc(w.label)}</span>${right ? `<span class="r">${right}</span>` : ''}<span class="v ${t}">${pct(w.pct)}</span></div>
          <div class="ca-track"><div class="ca-fill ${t}" style="width:${Math.min(100, Math.max(w.pct > 0 ? 2 : 0, w.pct))}%"></div>${tick ? `<div class="ca-tick" style="left:calc(${t0}% - 1px)"></div>` : ''}</div></div>`
      })
      .join('')}</div>`
  }

  function card(a, provider) {
    a = { ...a, provider }
    const anim = sw && sw.provider === provider && sw.id === a.id ? (sw.phase === 'pending' ? ' ca-switching' : sw.phase === 'done' ? ' ca-flash' : '') : ''
    let tag, tagText
    if (a.live) [tag, tagText] = ['active', provider === 'copilot' ? 'selected' : 'active']
    else if (a.kind === 'hermes') [tag, tagText] = ['hermes', 'hermes']
    else if (a.status === 'expired') [tag, tagText] = ['expired', 'expired']
    else [tag, tagText] = ['standby', 'standby']
    const sub =
      provider === 'claude'
        ? [a.org && !String(a.org).includes('@') ? a.org : null, a.in_hermes ? 'also in Hermes' : null].filter(Boolean).join(' · ')
        : provider === 'copilot' && a.login && a.login !== name(a)
          ? '@' + a.login
          : a.name && a.name !== name(a)
            ? a.name
            : ''
    const canUse = a.switchable && !a.live && a.kind !== 'hermes'
    const canRemove = (a.kind === 'saved' || provider !== 'claude') && !a.live
    return `<div class="ca-card ca-acct${a.live ? ' active' : ''}${a.status === 'expired' ? ' expired' : ''}${anim}" style="--pc:${PCOLOR[provider]}" data-flip="${provider}:${esc(a.id)}">
      <div class="ca-top">${av(a)}<div class="ca-name"><b title="${esc(name(a))} · ${esc(a.id)}">${esc(name(a))}</b><span class="ca-sub">${a.plan ? `<span class="ca-plan">${esc(a.plan)}</span>` : ''}${esc(sub || (a.plan ? '' : a.label || ''))}</span></div>
        <span class="ca-tag ${tag}">${tag === 'active' ? '<span class="ca-dot live"></span>' : ''}${tagText}</span></div>
      ${meters(a, provider)}
      ${a.usage_error ? `<div class="ca-note${a.status === 'expired' ? ' bad' : ''}">${ICONS.warn}<span>${esc(a.usage_error)}</span></div>` : ''}
      ${a.hint ? `<div class="ca-note">${ICONS.info}<span>${esc(a.hint)}</span></div>` : ''}
      ${a.pinned_until ? `<div class="ca-note warn">${ICONS.pause}<span>Pinned by you — auto-switch leaves it alone until ${clock(a.pinned_until)}.</span></div>` : ''}
      ${provider === 'claude' && a.live && !a.saved ? `<div class="ca-note warn">${ICONS.warn}<span>Not saved yet — <button class="ca-link" data-act="import">save this login</button> so you can switch back to it.</span></div>` : ''}
      <div class="ca-foot"><span>${a.usage_at ? 'updated ' + ago(a.usage_at) : 'no reading yet'}</span>
        <button class="ca-iconbtn sm" data-act="refreshOne" data-provider="${provider}" data-id="${esc(a.id)}" title="Refresh this account's usage now" aria-label="Refresh ${esc(name(a))}"${refreshingOne === provider + ':' + a.id ? ' disabled' : ''}>${refreshingOne === provider + ':' + a.id ? ICONS.sync : ICONS.refresh}</button><span class="sp"></span>
        ${canRemove ? `<button class="ca-link danger" data-act="remove" data-provider="${provider}" data-id="${esc(a.id)}" data-label="${esc(name(a))}" title="Forget this account">Remove</button>` : ''}
        ${provider === 'copilot' && a.live ? `<button class="ca-ghost" data-act="copilotPicker" title="Choose this GitHub account for Copilot in VS Code">${ICONS.swap}VS Code</button>` : ''}
        ${canUse ? `<button class="ca-use" data-act="use" data-provider="${provider}" data-id="${esc(a.id)}" data-name="${esc(name(a))}">Use ${ICONS.arrow}</button>` : ''}
      </div></div>`
  }

  function providerSection(p) {
    const info = provInfo(p)
    const accts = sortActiveFirst(info.accounts || [])
    const meta = PROVIDERS.find(x => x.id === p)
    const head = `<div class="ca-sech">${logo(p, true)}<span>${esc(meta.name)}</span><span class="n">${accts.length || ''}</span><span class="sp"></span>
         ${p !== 'claude' && accts.length ? `<button class="mini-toggle${info.auto_switch ? ' on' : ''}" data-act="pauto" data-provider="${p}" title="Auto-switch ${esc(meta.name)} at ${thr()}%"><span class="ca-dot${info.auto_switch ? ' good' : ''}"></span>auto</button>` : ''}
</div>`
    if (!accts.length) return ''
    const body = `<div class="ca-accounts">${accts.map(a => card(a, p)).join('')}</div>`
    const extra =
      p === 'claude' && accts.filter(a => a.switchable || a.live).length === 1
        ? `<div class="ca-note">${ICONS.info}<span>Add a second Claude account so there is something to switch to.</span></div>`
        : p === 'antigravity' && accts.length && !info.available
          ? `<div class="ca-note warn">${ICONS.warn}<span>${esc(info.note || 'Antigravity isn’t installed here — switching is off.')}</span></div>`
          : p === 'copilot' && accts.length
            ? `<div class="ca-note">${ICONS.info}<span>Copilot in VS Code follows VS Code’s account picker — <b>Use</b> selects the account and opens it.</span></div>`
            : ''
    return `<div class="ca-sec">${head}${body}${extra}</div>`
  }

  function sessions() {
    const rows = state.sessions || []
    if (!rows.length) return ''
    const cur = state.current_session && state.current_session.id
    return `<div class="ca-sec"><div class="ca-sech"><span>Claude Code sessions</span><span class="n">${rows.length}</span></div><div class="ca-sess">
      ${rows
        .map(s => {
          const t = tone(s.context_percent, 85)
          return `<div class="ca-srow${s.id === cur ? ' cur' : ''}" data-act="open" data-path="${esc(s.path)}" title="Context ${fmtK(s.context_used)} / ${fmtK(s.context_max)} · ${esc(s.cwd || '')}">
          <span class="ca-dot${s.running ? ' live' : ''}"></span>
          <div style="min-width:0"><div class="t">${esc(s.title)}</div><div class="ca-sub">${esc(s.project || '')} · ${s.running ? 'active now' : ago(s.updated_at)}</div></div>
          <div class="m"><div class="ca-mini"><i class="${t}" style="width:${Math.min(100, s.context_percent)}%"></i></div><span>${pct(s.context_percent)}</span></div></div>`
        })
        .join('')}</div></div>`
  }

  function settings() {
    const s = state.settings
    const seg = (key, opts, fmt) => `<div class="ca-seg">${opts.map(o => `<button class="${o === s[key] ? 'on' : ''}" data-act="set" data-key="${key}" data-val="${o}">${fmt ? fmt(o) : o}</button>`).join('')}</div>`
    const chk = (k, l) => `<button class="ca-check${s.windows.includes(k) ? ' on' : ''}" style="--pc:var(--p-claude)" data-act="win" data-key="${k}">${s.windows.includes(k) ? '● ' : '○ '}${l}</button>`
    const pa = s.provider_auto || {}
    const others = present().filter(p => p !== 'claude')
    const pchk = p => `<button class="ca-check${pa[p] !== false ? ' on' : ''}" style="--pc:${PCOLOR[p]}" data-act="pauto" data-provider="${p}">${logo(p, true)}${p === 'copilot' ? 'Copilot' : 'Antigravity'}</button>`
    return `<div class="ca-sec"><div class="ca-sech"><span>Auto-switch</span></div><div class="ca-card ca-set">
      <div class="ca-setrow"><div class="lbl"><b>Switch before a limit</b><span>Move to the least-used saved account at the threshold</span></div>
        <button class="ca-switch${s.auto_switch ? ' on' : ''}" data-act="toggle" role="switch" aria-checked="${!!s.auto_switch}" aria-label="Auto-switch"></button></div>
      <div class="ca-setrow" style="opacity:${s.auto_switch ? 1 : 0.5}"><div class="lbl"><b>Threshold</b></div>${seg('threshold', [75, 80, 85, 90, 95], v => v + '%')}</div>
      <div class="ca-setrow" style="opacity:${s.auto_switch ? 1 : 0.5};align-items:flex-start"><div class="lbl"><b>Claude windows</b></div><div class="ca-checks">${chk('five_hour', '5-hour')}${chk('seven_day', 'Weekly')}${chk('seven_day_opus', 'Opus wk')}</div></div>
      ${others.length ? `<div class="ca-setrow" style="opacity:${s.auto_switch ? 1 : 0.5};align-items:flex-start"><div class="lbl"><b>Also switch</b></div><div class="ca-checks">${others.map(pchk).join('')}</div></div>` : ''}
      <div class="ca-setrow"><div class="lbl"><b>Check every</b></div>${seg('poll_seconds', [60, 180, 300, 600], v => v / 60 + 'm')}</div>
      <div class="ca-setrow"><div class="lbl"><b>Claude Code CLI</b><span>Status line, /accounts command and MCP tools</span></div><button class="ca-ghost" data-act="setup">Set up</button></div>
    </div></div>`
  }

  const EV_ICON = { routing: 'route', auto_switch: 'swap', manual_switch: 'arrow', added: 'plus', imported: 'plus', removed: 'trash', all_hot: 'warn', error: 'warn' }
  function activity() {
    let ev = state.events || []
    if (tab === 'routing') ev = ev.filter(e => e.kind === 'routing')
    else if (tab !== 'all') ev = ev.filter(e => (e.provider || 'claude') === tab)
    if (!ev.length) return ''
    const shown = showAllEv ? ev : ev.slice(0, 4)
    const shut = !!folded.activity
    const head = `<div class="ca-sech"><button class="ca-foldbtn" data-act="fold" data-key="activity" aria-expanded="${!shut}" title="${shut ? 'Show' : 'Hide'} activity">${ICONS.chev}<span>Activity</span><span class="n">${ev.length}</span></button><span class="sp"></span>${!shut && ev.length > 4 ? `<button class="ca-link" data-act="moreev">${showAllEv ? 'Less' : 'All ' + ev.length}</button>` : ''}</div>`
    if (shut) return `<div class="ca-sec">${head}</div>`
    return `<div class="ca-sec">${head}
      <div class="ca-log">${shown.map(e => `<div class="ca-ev ${esc(e.kind)}"><span class="k">${ICONS[EV_ICON[e.kind] || 'dot']}</span><div>${esc(e.message)}<small>${ago(e.at)}</small></div></div>`).join('')}</div></div>`
  }

  function tabs() {
    const t = (id, label, count, hot) =>
      `<button class="ca-tab${tab === id ? ' on' : ''}" role="tab" aria-selected="${tab === id}" data-act="tab" data-tab="${id}" style="${id !== 'all' ? `--pc:${PCOLOR[id]}` : ''}">${id !== 'all' ? ICONS[id] : ''}<span class="lbl">${label}</span>${hot ? '<span class="hot" title="Over the threshold"></span>' : count ? `<i>${count}</i>` : ''}</button>`
    const hot = p => provInfo(p).accounts.some(a => a.live && a.peak_pct != null && a.peak_pct >= thr())
    const n = p => provInfo(p).accounts.length
    const ps = present()
    const label = { claude: 'Claude', antigravity: 'Antigravity', copilot: 'Copilot' }
    const route = rt() ? `<button class="ca-tab${tab === 'routing' ? ' on' : ''}" role="tab" aria-selected="${tab === 'routing'}" data-act="tab" data-tab="routing">${ICONS.route}<span class="lbl">Routing</span></button>` : ''
    return `<div class="ca-tabs" role="tablist">${t('all', 'All', ps.reduce((x, p) => x + n(p), 0))}${ps.length > 1 ? ps.map(p => t(p, label[p], n(p), hot(p))).join('') : ''}${route}</div>`
  }

  function addMenu() {
    if (!menu) return ''
    return `<div class="ca-menu" role="menu"><div class="ca-menu-h">Connect an account</div>${PROVIDERS.map(
      p =>
        `<button class="ca-mi" role="menuitem" data-act="add" data-provider="${p.id}" style="--pc:${PCOLOR[p.id]}">${logo(p.id)}<div style="min-width:0"><b>${p.name}</b><span>${p.blurb}</span></div>${state && provInfo(p.id).accounts.length ? `<em>${provInfo(p.id).accounts.length}</em>` : ''}</button>`
    ).join('')}</div>`
  }

  function loginSheet() {
    if (!login) return ''
    const p = login.provider
    const meta = PROVIDERS.find(x => x.id === p)
    const done = login.status === 'done'
    const failed = ['error', 'expired', 'cancelled'].includes(login.status)
    let body = ''
    if (done) body = `<div class="ca-moved">${ICONS.check}<span>Connected <b>${esc(login.label || '')}</b>. ${login.warning ? esc(login.warning) : ''}</span></div>`
    else if (failed) body = `<div class="ca-err">${esc(login.error || 'Sign-in did not finish.')}</div><div class="ca-sheet-a"><button class="ca-use" data-act="add" data-provider="${p}">Try again ${ICONS.arrow}</button></div>`
    else if (p === 'copilot' && login.user_code) {
      const chars = login.user_code
        .split('')
        .map((c, i) => (c === '-' ? '<span class="sep">–</span>' : `<span style="animation-delay:${i * 35}ms">${esc(c)}</span>`))
        .join('')
      body = `<div class="ca-devcode" title="Your one-time code">${chars}</div>
        <div class="ca-sheet-a"><button class="ca-use" data-act="openDevice">Copy &amp; open GitHub ${ICONS.external}</button><button class="ca-ghost" data-act="copyCode">${copied ? ICONS.check + 'Copied' : ICONS.copy + 'Copy'}</button></div>
        <div class="ca-wait"><span class="orb"></span><span>Paste the code at <b>github.com/login/device</b> and approve — this updates by itself.</span></div>`
    } else if (p === 'antigravity' && login.url) {
      body = `<div class="ca-wait"><span class="orb"></span><span>Finish signing in with Google in your browser and pick the account to add — this updates by itself.</span></div>
        <div class="ca-sheet-a"><button class="ca-ghost" data-act="openLogin">${ICONS.external}Open sign-in again</button></div>`
    } else if (p === 'claude' && login.url) {
      body = `<div class="ca-sub" style="white-space:normal">Sign in on claude.ai (use a private window if you're signed in to another account), click <b>Authorize</b>, then paste the code:</div>
        <input id="ca-code" placeholder="code#state" autocomplete="off" spellcheck="false">
        <div class="ca-sheet-a"><button class="ca-use" data-act="finishClaude">${login.status === 'finishing' ? ICONS.sync + 'Connecting' : 'Connect ' + ICONS.arrow}</button><button class="ca-ghost" data-act="openLogin">${ICONS.external}Open sign-in again</button></div>
        ${login.error ? `<div class="ca-err">${esc(login.error)}</div>` : ''}`
    } else body = `<div class="ca-wait"><span class="orb"></span><span>Starting sign-in…</span></div>`
    const exp = !done && !failed && login.expires_at ? ` · expires ${inFuture(login.expires_at)}` : ''
    return `<div class="ca-sheet" style="--pc:${PCOLOR[p]}"><div class="ca-sheet-h">${logo(p)}<div><b>${done ? 'Account connected' : 'Connect ' + esc(meta.name)}</b><span>${esc(meta.blurb)}${exp}</span></div>
      <button class="ca-iconbtn ca-x" data-act="${done || failed ? 'closeLogin' : 'cancelLogin'}" title="${done || failed ? 'Close' : 'Cancel'}" aria-label="${done || failed ? 'Close' : 'Cancel'}">${ICONS.x}</button></div>${body}</div>`
  }

  function banner() {
    if (!sw) return ''
    const meta = PROVIDERS.find(x => x.id === sw.provider) || PROVIDERS[0]
    const icon = sw.phase === 'pending' ? ICONS.sync : sw.phase === 'err' ? ICONS.warn : ICONS.check
    const txt = sw.phase === 'pending' ? `Switching ${meta.name} to ${esc(sw.name)}…` : sw.phase === 'err' ? esc(sw.error || 'Switch failed') : `${meta.name} now uses ${esc(sw.name)}`
    return `<div class="ca-banner ${sw.phase}">${icon}<span>${txt}</span></div>`
  }

  // ─── render with FLIP (cards glide to their new place, e.g. the active one to the top) ──────

  function render() {
    const before = {}
    ca.querySelectorAll('[data-flip]').forEach(el => (before[el.dataset.flip] = el.getBoundingClientRect()))
    const focusId = document.activeElement && document.activeElement.id
    const codeEl = document.getElementById('ca-code')
    const codeVal = codeEl ? codeEl.value : null

    let body
    if (error && !state) {
      body = `<div class="ca-empty">${ICONS.warn}<b>Engine not reachable</b><div>${esc(error)}</div><button class="ca-use" data-act="refresh">Try again</button></div>`
    } else if (!state) {
      body = `<div class="ca-skel"></div><div class="ca-skel"></div><div class="ca-skel"></div>`
    } else {
      const s = state.settings
      const ps = present()
      if (tab === 'routing' && !rt()) tab = 'all'
      if (tab !== 'all' && tab !== 'routing' && (!ps.includes(tab) || ps.length < 2)) tab = 'all'
      const showClaude = (tab === 'all' || tab === 'claude') && ps.includes('claude')
      const groups = tab === 'routing' ? '' : ps.length
        ? (tab === 'all' ? ps : [tab]).map(providerSection).join('')
        : `<div class="ca-empty">${ICONS.plus}<b>No accounts yet</b><div>Use <b>Add</b> at the top to connect Claude, Antigravity or GitHub Copilot.</div></div>`
      body = `${tabs()}
      <div class="ca-strip"><button class="ca-pill${s.auto_switch ? ' on' : ''}" data-act="toggle"><span class="ca-dot ${s.auto_switch ? 'good' : ''}"></span>${s.auto_switch ? 'Auto-switch at ' + s.threshold + '%' : 'Auto-switch off'}</button>
        <span>${state.last_check_at ? 'checked ' + ago(state.last_check_at) : ''}</span></div>
      ${banner()}${loginSheet()}
      ${tab === 'routing'
        ? runningNow(true) + routingCard() + delegationsSection(40) + activity()
        : `${showClaude ? `<div class="ca-sec"><div class="ca-sech"><span>This session</span></div>${current()}</div>` : ''}
      ${tab === 'all' ? runningNow(false) : ''}
      <div class="ca-groups">${groups}</div>
      ${tab === 'all' ? routingSummary() : ''}
      ${showClaude ? sessions() : ''}${settings()}${activity()}`}`
    }
    const total = state ? allAccounts().length : 0
    ca.innerHTML = `<div class="ca-head"><div class="ca-brand"><span class="ca-mark"><i>${ICONS.mark}</i></span><div><b>Switchboard</b><small>${state ? `${total} account${total === 1 ? '' : 's'} · Claude, Antigravity, Copilot` : 'loading…'}</small></div></div>
      <button class="ca-iconbtn" data-act="refresh" title="Re-check every account" aria-label="Refresh">${refreshing ? ICONS.sync : ICONS.refresh}</button>
      <button class="ca-addbtn" data-act="menu" aria-haspopup="menu" aria-expanded="${menu}" title="Connect another account">${ICONS.plus}<span class="t">Add</span>${ICONS.chev}</button>
      ${addMenu()}</div>${body}`

    const fg = ca.querySelector('.ca-ring .fg')
    if (fg) requestAnimationFrame(() => requestAnimationFrame(() => fg.setAttribute('stroke-dashoffset', fg.dataset.to)))
    if (state && state.current_session) lastRing = state.current_session.context_percent
    const live = state && (state.accounts || []).find(a => a.live)
    if (live) lastChip = live.id

    const skipFlip = noFlip
    noFlip = false
    if (!skipFlip && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      ca.querySelectorAll('[data-flip]').forEach(el => {
        const b = before[el.dataset.flip]
        if (!b) return
        const a = el.getBoundingClientRect()
        const dx = b.left - a.left, dy = b.top - a.top
        if (Math.abs(dy) > 2 || Math.abs(dx) > 2) {
          el.animate([{ transform: `translate(${dx}px,${dy}px)`, zIndex: 2 }, { transform: 'none', zIndex: 2 }], { duration: 560, easing: 'cubic-bezier(.2,.85,.25,1.08)' })
        }
      })
    }
    const ne = document.getElementById('ca-code')
    if (ne && codeVal != null) ne.value = codeVal
    if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus()
    else if (ne && !codeVal) ne.focus()
    if (menu && !ca.querySelector('.ca-mi:focus')) {
      const first = ca.querySelector('.ca-mi')
      first && first.focus({ preventScroll: true })
    }
  }

  // ─── events ─────────────────────────────────────────────────────────────────────────────────

  function startAdd(provider) {
    menu = false
    copied = false
    login = { provider, status: 'starting' }
    if (tab !== 'all' && tab !== provider) {
      tab = provider
      noFlip = true
      persist()
    }
    render()
    post({ type: 'addStart', provider })
  }

  ca.addEventListener('click', e => {
    e.stopPropagation() // the target may be re-rendered (detached) before a document listener sees it
    const el = e.target.closest('[data-act]')
    if (!el) {
      if (menu && !e.target.closest('.ca-menu')) {
        menu = false
        render()
      }
      return
    }
    const act = el.dataset.act
    if (act !== 'menu' && act !== 'add' && menu) menu = false
    switch (act) {
      case 'refresh':
        refreshing = true
        render()
        post({ type: 'refresh' })
        break
      case 'refreshOne':
        refreshingOne = el.dataset.provider + ':' + el.dataset.id
        noFlip = true
        render()
        post({ type: 'refreshOne', provider: el.dataset.provider, id: el.dataset.id })
        break
      case 'menu':
        menu = !menu
        render()
        break
      case 'add':
        startAdd(el.dataset.provider)
        break
      case 'tab':
        tab = el.dataset.tab
        noFlip = true
        showAllEv = false
        persist()
        render()
        break
      case 'import':
        post({ type: 'import' })
        break
      case 'setup':
        post({ type: 'setup' })
        break
      case 'open':
        post({ type: 'openSession', path: el.dataset.path })
        break
      case 'remove':
        post({ type: 'remove', provider: el.dataset.provider, id: el.dataset.id, label: el.dataset.label })
        break
      case 'copilotPicker':
        post({ type: 'copilotPicker' })
        break
      case 'moreev':
        showAllEv = !showAllEv
        render()
        break
      case 'fold':
        folded = { ...folded, [el.dataset.key]: !folded[el.dataset.key] }
        noFlip = true
        persist()
        render()
        break
      case 'use': {
        const provider = el.dataset.provider
        sw = { provider, id: el.dataset.id, name: el.dataset.name, phase: 'pending' }
        render()
        post({ type: 'use', provider, id: el.dataset.id })
        break
      }
      case 'rset': {
        const k = el.dataset.key
        let v = el.dataset.val
        if (v === 'true' || v === 'false') v = v === 'true'
        const r = rt()
        if (r) {
          if (k.startsWith('tiers.')) {
            const t = r.tiers.find(x => x.tier === k.slice(6))
            if (t) t.model = t.effective = v
            r.config.tiers[k.slice(6)] = v
          } else r.config[k] = v
        }
        render()
        post({ type: 'routing', patch: { [k]: v } })
        break
      }
      case 'toggle':
        state.settings.auto_switch = !state.settings.auto_switch
        render()
        post({ type: 'settings', patch: { auto_switch: state.settings.auto_switch } })
        break
      case 'pauto': {
        const p = el.dataset.provider
        const pa = (state.settings.provider_auto = { ...(state.settings.provider_auto || {}) })
        pa[p] = pa[p] === false
        if (state.providers && state.providers[p]) state.providers[p].auto_switch = pa[p]
        render()
        post({ type: 'settings', patch: { [`provider_auto.${p}`]: pa[p] } })
        break
      }
      case 'set': {
        const v = Number(el.dataset.val)
        state.settings[el.dataset.key] = v
        render()
        post({ type: 'settings', patch: { [el.dataset.key]: v } })
        break
      }
      case 'win': {
        const k = el.dataset.key, w = state.settings.windows
        const next = w.includes(k) ? w.filter(x => x !== k) : [...w, k]
        if (!next.length) return
        state.settings.windows = next
        render()
        post({ type: 'settings', patch: { windows: next } })
        break
      }
      case 'openDevice':
        post({ type: 'openUrl', url: login.verification_uri, copy: login.user_code })
        copied = true
        render()
        break
      case 'copyCode':
        post({ type: 'copy', text: login.user_code })
        copied = true
        render()
        break
      case 'openLogin':
        post({ type: 'openUrl', url: login.url })
        break
      case 'finishClaude': {
        const v = (document.getElementById('ca-code') || {}).value || ''
        if (!v.trim() || login.status === 'finishing') return
        login.status = 'finishing'
        login.error = null
        render()
        post({ type: 'loginFinish', provider: 'claude', code: v.trim() })
        break
      }
      case 'cancelLogin':
        post({ type: 'loginCancel', login_id: login && login.login_id })
        login = null
        render()
        break
      case 'closeLogin':
        login = null
        render()
        break
    }
  })

  ca.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu) {
      menu = false
      render()
      const b = ca.querySelector('.ca-addbtn')
      b && b.focus()
    } else if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const items = [...ca.querySelectorAll('.ca-mi')]
      const i = items.indexOf(document.activeElement)
      const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
      n && n.focus()
    } else if (e.key === 'Enter' && e.target.id === 'ca-code') {
      const b = ca.querySelector('[data-act=finishClaude]')
      b && b.click()
    }
  })
  document.addEventListener('click', e => {
    if (menu && !ca.contains(e.target)) {
      menu = false
      render()
    }
  })

  window.addEventListener('message', ev => {
    const m = ev.data || {}
    switch (m.type) {
      case 'state':
        state = m.state
        error = null
        refreshing = false
        refreshingOne = null
        persist()
        break
      case 'error':
        error = m.message
        refreshing = false
        break
      case 'refreshed':
        refreshing = false
        refreshingOne = null
        break
      case 'switching':
        if (!sw || sw.id !== m.id) {
          const a = allAccounts().find(x => x.id === m.id)
          sw = { provider: m.provider || 'claude', id: m.id, name: name(a), phase: 'pending' }
        }
        break
      case 'switched': {
        sw = m.ok
          ? { ...(sw || {}), provider: m.provider || 'claude', id: m.id, name: m.label || (sw && sw.name), phase: 'done' }
          : { ...(sw || {}), phase: 'err', error: m.error }
        // optimistic: flip the live flag now so the card glides to the top; the next state confirms it
        if (m.ok && state) {
          const list = (m.provider || 'claude') === 'claude' ? state.accounts : ((state.providers || {})[m.provider] || {}).accounts
          ;(list || []).forEach(a => (a.live = a.active = a.id === m.id))
          if (state.providers && state.providers[m.provider]) state.providers[m.provider].live_id = m.id
        }
        const mine = sw
        setTimeout(() => {
          if (sw === mine) {
            sw = null
            render()
          }
        }, 4500)
        break
      }
      case 'login':
        login = { ...(login || {}), ...m.login }
        if (login.status === 'done') {
          const l = login
          setTimeout(() => {
            if (login === l) {
              login = null
              render()
            }
          }, 6000)
        }
        break
      case 'loginClosed':
        login = null
        break
      case 'openAdd':
        if (m.provider) return startAdd(m.provider)
        menu = true
        break
    }
    render()
  })

  setInterval(render, 30000) // keep relative times fresh
  render()
  post({ type: 'ready' })
})()
