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
