// Switchboard (claude-accounts) — VS Code extension host side. Plain JS, no build step, no dependencies.
'use strict'

const vscode = require('vscode')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const COPILOT_EXT = 'GitHub.copilot-chat'
const PNAME = { claude: 'Claude Code', antigravity: 'Antigravity', copilot: 'GitHub Copilot' }

let output
let statusItem
let provider
let timer
let lastState = null
let loginPoll = null
let claudeLogin = null

// ─── engine ───────────────────────────────────────────────────────────────────────────────────

function corePath(context) {
  const cfg = vscode.workspace.getConfiguration('claudeAccounts').get('corePath')
  const candidates = [cfg, path.join(os.homedir(), '.claude-accounts', 'bin', 'claude_accounts.py'), path.join(context.extensionPath, 'core', 'claude_accounts.py')]
  // the installed copy must have the multi-provider module next to it, else use the bundled engine
  return candidates.find(p => p && fs.existsSync(p) && fs.existsSync(path.join(path.dirname(p), 'providers.py'))) || candidates.find(p => p && fs.existsSync(p))
}

function pythonCandidates() {
  const cfg = vscode.workspace.getConfiguration('claudeAccounts').get('pythonPath') || 'python3'
  return [...new Set([cfg, 'python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'])]
}

let workingPython = null

function run(context, args, { input, timeoutMs = 60000 } = {}) {
  const script = corePath(context)
  if (!script) return Promise.reject(new Error('claude_accounts.py not found'))
  const pythons = workingPython ? [workingPython] : pythonCandidates()
  const tryOne = i =>
    new Promise((resolve, reject) => {
      const py = pythons[i]
      const child = cp.execFile(py, [script, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return i + 1 < pythons.length ? tryOne(i + 1).then(resolve, reject) : reject(new Error('Python 3 not found — set claudeAccounts.pythonPath'))
        workingPython = py
        if (stderr && stderr.trim()) output.appendLine(`[engine] ${stderr.trim()}`)
        const text = (stdout || '').trim()
        const last = text.split('\n').filter(Boolean).pop() || ''
        try {
          resolve(JSON.parse(last))
        } catch (e) {
          reject(new Error((stderr || text || (err && err.message) || 'engine failed').slice(0, 400)))
        }
      })
      if (input != null) {
        child.stdin.write(input)
        child.stdin.end()
      }
    })
  return tryOne(0)
}

function workspaceDir() {
  const f = vscode.workspace.workspaceFolders
  return f && f.length ? f[0].uri.fsPath : undefined
}

async function refresh(context, { force = false, one = null } = {}) {
  const args = ['status', '--json', '--auto']
  if (force) args.push('--refresh')
  if (one && one.id) args.push('--refresh-account', String(one.id), '--provider', String(one.provider || 'claude'))
  const ws = workspaceDir()
  if (ws) args.push('--cwd', ws)
  try {
    const state = await run(context, args)
    lastState = state
    if (state.action && state.action.ok && !state.action.unchanged) {
      vscode.window.showInformationMessage(`Auto-switched Claude Code to ${state.action.label} (${state.action.from || 'previous'} reached ${state.settings.threshold}%).`)
    }
    for (const a of state.provider_actions || []) {
      if (!a.ok || a.unchanged) continue
      if (a.provider === 'copilot') {
        vscode.window.showInformationMessage(`Copilot: ${a.from || 'previous account'} reached ${state.settings.threshold}% — switched to ${a.label}.`, 'Use it in VS Code').then(b => b && copilotPicker(context, a.label))
      } else {
        vscode.window.showInformationMessage(`${PNAME[a.provider]}: auto-switched to ${a.label}. ${a.note || ''}`)
      }
    }
    provider && provider.post({ type: 'state', state })
    updateStatus(state)
    return { state }
  } catch (e) {
    output.appendLine(`[refresh] ${e.message}`)
    provider && provider.post({ type: 'error', message: e.message })
    if (statusItem) {
      statusItem.text = '$(warning) Accounts'
      statusItem.tooltip = `Switchboard: ${e.message}`
    }
    return {}
  }
}

// ─── status bar ───────────────────────────────────────────────────────────────────────────────

function updateStatus(state) {
  if (!statusItem) return
  if (!vscode.workspace.getConfiguration('claudeAccounts').get('statusBar')) return statusItem.hide()
  const live = (state.accounts || []).find(a => a.live)
  const s = state.current_session
  const thr = state.settings.threshold
  if (!live) {
    statusItem.text = '$(account) Claude: not logged in'
  } else {
    const name = (live.email || live.label || '').split('@')[0]
    const w = (live.usage && live.usage.windows) || {}
    const fmt = k => (w[k] ? `${Math.round(w[k].pct)}%` : '–')
    statusItem.text = `$(account) ${name} ${fmt('five_hour')}·${fmt('seven_day')}${s ? `  $(symbol-ruler) ${Math.round(s.context_percent)}%` : ''}`
    const peak = live.peak_pct
    statusItem.backgroundColor = peak != null && peak >= thr ? new vscode.ThemeColor('statusBarItem.errorBackground') : peak != null && peak >= thr - 15 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  }
  const md = new vscode.MarkdownString(undefined, true)
  md.appendMarkdown(`**Switchboard** — auto-switch ${state.settings.auto_switch ? `on at ${thr}%` : 'off'}\n\n`)
  const line = (a, label) => {
    const ww = Object.values((a.usage && a.usage.windows) || {})
    const bits = ww.map(w => `${w.label.split(' ·')[0]} ${Math.round(w.pct)}%`)
    md.appendMarkdown(`${a.live ? '$(pass-filled) ' : '$(circle-outline) '}**${a.email || a.login || a.label}** ${a.plan ? `(${a.plan})` : ''} — ${bits.join(' · ') || a.usage_error || '—'}${label ? ` _${label}_` : ''}\n\n`)
  }
  for (const a of state.accounts || []) line(a, a.kind === 'hermes' ? '(Hermes)' : '')
  for (const [p, info] of Object.entries(state.providers || {})) {
    if (!(info.accounts || []).length) continue
    md.appendMarkdown(`---\n\n**${info.name}**\n\n`)
    for (const a of info.accounts) line(a, '')
  }
  if (s) md.appendMarkdown(`---\n\nContext: **${Math.round(s.context_percent)}%** of ${Math.round(s.context_max / 1000)}k — ${s.title}`)
  statusItem.tooltip = md
  statusItem.show()
}

// ─── actions ──────────────────────────────────────────────────────────────────────────────────

async function doUse(context, prov, id) {
  prov = prov || 'claude'
  provider && provider.post({ type: 'switching', provider: prov, id })
  try {
    const args = ['use', id, '--json']
    if (prov !== 'claude') args.push('--provider', prov)
    const r = await run(context, args)
    if (!r.ok) throw new Error(r.error || 'Switch failed')
    provider && provider.post({ type: 'switched', ok: true, provider: prov, id, label: r.label, unchanged: !!r.unchanged })
    if (r.warning) vscode.window.showWarningMessage(r.warning)
    if (!r.unchanged) {
      if (prov === 'claude') vscode.window.showInformationMessage(`Claude Code now uses ${r.label}. New sessions start on it; restart an open Claude Code session to move it over.`)
      else if (prov === 'antigravity')
        vscode.window.showInformationMessage(`Antigravity now uses ${r.label}. Reload the window so the Antigravity agent picks it up.`, 'Reload window').then(b => b && vscode.commands.executeCommand('workbench.action.reloadWindow'))
    }
    if (prov === 'copilot') await copilotPicker(context, r.label)
  } catch (e) {
    provider && provider.post({ type: 'switched', ok: false, provider: prov, id, error: e.message })
    vscode.window.showErrorMessage(`Switchboard: ${e.message}`)
  }
  await refresh(context)
}

// Copilot in VS Code uses VS Code's own GitHub sign-in; which account it uses is a per-extension
// preference that only VS Code's account picker can change, so we open that picker.
async function copilotPicker(context, wanted) {
  const login = String(wanted || '').replace(/^@/, '')
  try {
    let known = null
    if (vscode.authentication.getAccounts) {
      const accts = await vscode.authentication.getAccounts('github')
      known = accts.some(a => a.label.toLowerCase() === login.toLowerCase())
    }
    if (known === false) {
      const b = await vscode.window.showInformationMessage(`Copilot in VS Code: sign in to GitHub as ${login} once, then pick it for Copilot.`, 'Sign in to GitHub')
      if (!b) return
      await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true, clearSessionPreference: true })
    }
    await vscode.commands.executeCommand('_manageAccountPreferencesForExtension', COPILOT_EXT, 'github')
    if (login) vscode.window.setStatusBarMessage(`Pick ${login} for GitHub Copilot`, 8000)
  } catch (e) {
    output.appendLine(`[copilot picker] ${e.message}`)
    vscode.window.showInformationMessage(`To use ${login} with Copilot in VS Code: Accounts menu → Manage Extension Account Preferences → GitHub Copilot Chat.`)
  }
}

function stopPoll() {
  if (loginPoll) clearInterval(loginPoll)
  loginPoll = null
}

async function addStart(context, prov) {
  stopPoll()
  claudeLogin = null
  try {
    if (prov === 'claude') {
      const start = await run(context, ['login-start', '--json'])
      if (!start.ok) throw new Error(start.error || 'Could not start login')
      claudeLogin = start
      provider && provider.post({ type: 'login', login: { provider: 'claude', status: 'pending', url: start.url, login_id: start.login_id } })
      await vscode.env.openExternal(vscode.Uri.parse(start.url))
      return
    }
    const s = await run(context, ['login-start', '--provider', prov, '--json'])
    if (!s.ok) throw new Error(s.error || 'Could not start sign-in')
    provider && provider.post({ type: 'login', login: { ...s, provider: prov } })
    if (prov === 'antigravity') await vscode.env.openExternal(vscode.Uri.parse(s.url))
    if (prov === 'copilot') await vscode.env.clipboard.writeText(s.user_code)
    let busy = false
    loginPoll = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const st = await run(context, ['login-status', s.login_id, '--json'])
        provider && provider.post({ type: 'login', login: { ...st, provider: prov } })
        if (st.status && st.status !== 'pending') {
          stopPoll()
          if (st.status === 'done') {
            vscode.window.showInformationMessage(`Connected ${PNAME[prov]} · ${st.label}.${st.warning ? ' ' + st.warning : ''}`)
            await refresh(context, { force: true })
          }
        }
      } catch (e) {
        output.appendLine(`[login poll] ${e.message}`)
      } finally {
        busy = false
      }
    }, 2000)
  } catch (e) {
    provider && provider.post({ type: 'login', login: { provider: prov, status: 'error', error: e.message } })
  }
}

async function loginFinishClaude(context, code) {
  try {
    const r = await run(context, ['login-finish', '--json', '--stdin'], { input: code })
    if (!r.ok) throw new Error(r.error)
    provider && provider.post({ type: 'login', login: { provider: 'claude', status: 'done', label: r.label, warning: r.warning } })
    vscode.window.showInformationMessage(`Connected ${r.label}.${r.warning ? ' ' + r.warning : ''}`)
    await refresh(context, { force: true })
  } catch (e) {
    provider && provider.post({ type: 'login', login: { provider: 'claude', status: 'pending', error: e.message } })
  }
}

async function addAccount(context) {
  // command palette / view title: show the provider menu in the panel, or a quick pick if hidden
  if (provider && provider.view && provider.view.visible) return provider.post({ type: 'openAdd' })
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(sparkle) Claude', description: 'Pro, Max or Team', id: 'claude' },
      { label: '$(rocket) Antigravity', description: 'Google sign-in', id: 'antigravity' },
      { label: '$(copilot) GitHub Copilot', description: 'GitHub device code', id: 'copilot' }
    ],
    { placeHolder: 'Connect which account?' }
  )
  if (!pick) return
  await vscode.commands.executeCommand('claudeAccounts.panel.focus')
  setTimeout(() => provider && provider.post({ type: 'openAdd', provider: pick.id }), 400)
}

async function pickAndSwitch(context) {
  const st = lastState || (await refresh(context)).state
  if (!st) return
  const items = []
  const push = (prov, a) =>
    a.switchable &&
    a.kind !== 'hermes' &&
    items.push({
      label: `${a.live ? '$(pass-filled) ' : ''}${a.email || a.login || a.label}`,
      description: [PNAME[prov], a.plan, a.peak_pct != null ? `${Math.round(a.peak_pct)}% used` : null, a.live ? 'active' : null].filter(Boolean).join(' · '),
      prov,
      id: a.id
    })
  ;(st.accounts || []).forEach(a => push('claude', a))
  Object.entries(st.providers || {}).forEach(([p, info]) => (info.accounts || []).forEach(a => push(p, a)))
  if (!items.length) return vscode.window.showInformationMessage('No saved accounts yet — connect one first.')
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Switch to…', matchOnDescription: true })
  if (pick) await doUse(context, pick.prov, pick.id)
}

async function importCurrent(context) {
  try {
    const r = await run(context, ['import', '--json'])
    if (!r.ok) throw new Error(r.error)
    vscode.window.showInformationMessage(`Saved ${r.label} — you can now switch back to it any time.`)
    await refresh(context)
  } catch (e) {
    vscode.window.showErrorMessage(`Switchboard: ${e.message}`)
  }
}

async function removeAccount(context, prov, id, label) {
  const ok = await vscode.window.showWarningMessage(`Forget ${label}? The ${PNAME[prov || 'claude'].replace(' Code', '')} account itself is not affected.`, { modal: true }, 'Remove')
  if (ok !== 'Remove') return
  const args = ['remove', id, '--json']
  if (prov && prov !== 'claude') args.push('--provider', prov)
  const r = await run(context, args)
  if (!r.ok) vscode.window.showErrorMessage(`Switchboard: ${r.error}`)
  await refresh(context)
}

async function saveSettings(context, patch) {
  const args = ['config', '--json', ...Object.entries(patch).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`)]
  await run(context, args)
  await refresh(context)
}

async function setupClaudeCode(context) {
  const script = path.join(context.extensionPath, 'claude-code', 'install.sh')
  if (!fs.existsSync(script)) return vscode.window.showErrorMessage('install.sh not bundled')
  const term = vscode.window.createTerminal({ name: 'Switchboard setup' })
  term.show()
  term.sendText(`bash ${JSON.stringify(script)}`)
}

// ─── webview ──────────────────────────────────────────────────────────────────────────────────

class Provider {
  constructor(context) {
    this.context = context
    this.view = null
  }
  post(msg) {
    if (this.view) this.view.webview.postMessage(msg)
  }
  resolveWebviewView(view) {
    this.view = view
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    const nonce = crypto.randomBytes(16).toString('hex')
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'))
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'))
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource} https: data:;">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="root" class="ca-root"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`
    view.webview.onDidReceiveMessage(async m => {
      const c = this.context
      switch (m.type) {
        case 'ready':
          if (lastState) this.post({ type: 'state', state: lastState })
          refresh(c)
          break
        case 'refresh':
          await refresh(c, { force: true })
          this.post({ type: 'refreshed' })
          break
        case 'refreshOne':
          await refresh(c, { one: { id: m.id, provider: m.provider } })
          this.post({ type: 'refreshed' })
          break
        case 'use':
        case 'switch':
          await doUse(c, m.provider, m.id)
          break
        case 'add':
        case 'addStart':
          await addStart(c, m.provider || 'claude')
          break
        case 'loginFinish':
          await loginFinishClaude(c, m.code)
          break
        case 'loginCancel':
          stopPoll()
          if (m.login_id) run(c, ['login-cancel', m.login_id, '--json']).catch(() => {})
          break
        case 'import':
          await importCurrent(c)
          break
        case 'remove':
          await removeAccount(c, m.provider, m.id, m.label)
          break
        case 'settings':
          await saveSettings(c, m.patch)
          break
        case 'setup':
          await setupClaudeCode(c)
          break
        case 'routing': {
          const args = ['routing', '--json', ...Object.entries(m.patch || {}).map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`)]
          try {
            const r = await run(c, args)
            if (!r.ok) throw new Error(r.error || 'Could not save routing')
          } catch (e) {
            vscode.window.showErrorMessage(`Switchboard: ${e.message}`)
          }
          await refresh(c)
          break
        }
        case 'copilotPicker': {
          const sel = lastState && lastState.providers && lastState.providers.copilot && lastState.providers.copilot.accounts.find(a => a.live)
          await copilotPicker(c, sel && sel.login)
          break
        }
        case 'openUrl':
          if (m.copy) await vscode.env.clipboard.writeText(m.copy)
          if (m.url) vscode.env.openExternal(vscode.Uri.parse(m.url))
          break
        case 'copy':
          if (m.text) await vscode.env.clipboard.writeText(m.text)
          break
        case 'openSession':
          if (m.path) vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true })
          break
      }
    })
    view.onDidChangeVisibility(() => view.visible && refresh(this.context))
  }
}

// ─── activate ─────────────────────────────────────────────────────────────────────────────────

function activate(context) {
  output = vscode.window.createOutputChannel('Switchboard')
  provider = new Provider(context)
  context.subscriptions.push(output, vscode.window.registerWebviewViewProvider('claudeAccounts.panel', provider, { webviewOptions: { retainContextWhenHidden: true } }))

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusItem.command = 'claudeAccounts.switch'
  statusItem.text = '$(sync~spin) Accounts'
  context.subscriptions.push(statusItem)

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  reg('claudeAccounts.refresh', () => refresh(context, { force: true }))
  reg('claudeAccounts.switch', () => pickAndSwitch(context))
  reg('claudeAccounts.add', () => addAccount(context))
  reg('claudeAccounts.import', () => importCurrent(context))
  reg('claudeAccounts.toggleAuto', async () => {
    const on = !(lastState && lastState.settings.auto_switch)
    await saveSettings(context, { auto_switch: on })
    vscode.window.showInformationMessage(`Switchboard: auto-switch ${on ? 'on' : 'off'}`)
  })
  reg('claudeAccounts.setupClaudeCode', () => setupClaudeCode(context))

  // Context changes as Claude Code writes its transcript: refresh (debounced) on transcript writes.
  try {
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
    if (fs.existsSync(projects)) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(projects), '**/*.jsonl'))
      let t = null
      const kick = () => {
        clearTimeout(t)
        t = setTimeout(() => refresh(context), 4000)
      }
      w.onDidChange(kick)
      w.onDidCreate(kick)
      context.subscriptions.push(w)
    }
  } catch (e) {
    output.appendLine(`[watch] ${e.message}`)
  }

  const schedule = () => {
    clearInterval(timer)
    const secs = Math.max(20, vscode.workspace.getConfiguration('claudeAccounts').get('refreshSeconds') || 60)
    timer = setInterval(() => refresh(context), secs * 1000)
  }
  schedule()
  context.subscriptions.push({ dispose: () => (clearInterval(timer), stopPoll()) })
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('claudeAccounts') && (schedule(), lastState && updateStatus(lastState))))
  refresh(context)
}

function deactivate() {
  clearInterval(timer)
  stopPoll()
}

module.exports = { activate, deactivate }
