import { breakdownCardHtml } from './breakdown-card.js'
import {
  chipsHtml,
  emptyHtml,
  footerHtml,
  headerHtml,
  kpiGridHtml,
  sparkbarCardHtml
} from './cards-template.js'

const api = window.orca
const app = document.getElementById('app')
const tooltipEl = document.getElementById('tooltip')

const state = {
  snapshot: null,
  settings: {},
  loading: true,
  refreshing: false,
  error: null,
  selectedId: null,
  lastFocusedId: null,
  turnsExpanded: false
}

function activeSession(snapshot) {
  const list = Array.isArray(snapshot?.sessions) ? snapshot.sessions : []
  if (!list.length) return null
  if (state.selectedId) {
    const found = list.find((s) => s.id === state.selectedId)
    if (found) return found
  }
  if (snapshot?.primarySessionId) {
    const primary = list.find((s) => s.id === snapshot.primarySessionId)
    if (primary) return primary
  }
  return list[0]
}

let activeTipTarget = null

function showTooltip(target) {
  if (!tooltipEl || !target) return
  const text = target.getAttribute('data-tooltip')
  if (!text) return
  activeTipTarget = target
  tooltipEl.textContent = text
  tooltipEl.setAttribute('aria-hidden', 'false')
  tooltipEl.classList.add('visible')

  const rect = target.getBoundingClientRect()
  const tipRect = tooltipEl.getBoundingClientRect()
  const pad = 8
  let left = rect.left + rect.width / 2 - tipRect.width / 2
  left = Math.max(pad, Math.min(window.innerWidth - tipRect.width - pad, left))

  let top = rect.top - tipRect.height - 6
  if (top < pad) top = rect.bottom + 6
  if (top + tipRect.height > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - tipRect.height - pad)
  }

  tooltipEl.style.left = `${Math.round(left)}px`
  tooltipEl.style.top = `${Math.round(top)}px`
}

function hideTooltip() {
  activeTipTarget = null
  if (!tooltipEl) return
  tooltipEl.classList.remove('visible')
  tooltipEl.setAttribute('aria-hidden', 'true')
}

function render() {
  hideTooltip()
  if (!api || !api.plugin) {
    app.setAttribute('aria-busy', 'false')
    app.innerHTML = headerHtml(null, state) + emptyHtml('Orca 插件桥不可用，请重新打开面板。')
    return
  }

  const snapshot = state.snapshot
  app.setAttribute('aria-busy', state.loading || state.refreshing ? 'true' : 'false')

  if (!snapshot) {
    app.innerHTML =
      headerHtml(null, state) +
      emptyHtml(state.error || '正在读取当前工作区 Coding Agent 会话日志…')
    return
  }

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const session = activeSession(snapshot)
  if (!session) {
    app.innerHTML =
      headerHtml(null, state) +
      emptyHtml(
        '当前工作区没有打开的 Coding Agent 或 Bot 会话。打开 Claude Code / Codex / OpenCode / Pi / AGY 或 Bot 对话后将自动显示。'
      ) +
      footerHtml(snapshot, null, state.settings)
    return
  }

  const tz = snapshot.tzOffsetMinutes
  app.innerHTML = [
    headerHtml(session, state),
    chipsHtml(sessions, session, state.settings),
    kpiGridHtml(session, state.settings, tz),
    sparkbarCardHtml(session, state.settings, tz),
    breakdownCardHtml(session, state),
    footerHtml(snapshot, session, state.settings)
  ].join('')
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  state.snapshot = snapshot
  state.loading = false
  state.refreshing = false
  state.error = snapshot.error || null
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []

  // Auto-follow when the user switches to a different coding agent tab in Orca.
  const nextFocused = snapshot.focusedSessionId || null
  if (nextFocused && nextFocused !== state.lastFocusedId) {
    state.lastFocusedId = nextFocused
    state.selectedId = nextFocused
  } else if (state.selectedId && !sessions.some((s) => s.id === state.selectedId)) {
    state.selectedId = null
  }
  render()
}

async function load(force) {
  if (force) state.refreshing = true
  render()
  try {
    const res = force
      ? await api.plugin.request('cache.refresh', undefined, { timeoutMs: 30000 })
      : await api.plugin.request('cache.get', {}, { timeoutMs: 30000 })
    applySnapshot(res)
  } catch (error) {
    state.error = error?.message || String(error)
    state.loading = false
    state.refreshing = false
    render()
  }
}

app.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tooltip]')
  if (target === activeTipTarget) return
  if (target) showTooltip(target)
  else hideTooltip()
})

app.addEventListener('pointerleave', () => hideTooltip())
window.addEventListener('scroll', () => hideTooltip(), true)

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  const action = target.getAttribute('data-action')
  if (action === 'refresh') {
    if (!state.refreshing) void load(true)
  } else if (action === 'select') {
    state.selectedId = target.getAttribute('data-id') || null
    render()
  } else if (action === 'toggle-turns') {
    state.turnsExpanded = !state.turnsExpanded
    render()
  }
})

window.addEventListener('keydown', (event) => {
  if (
    event.key.toLowerCase() === 'r' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.repeat
  ) {
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (!state.refreshing) void load(true)
  }
})

async function init() {
  if (!api || !api.plugin) {
    render()
    return
  }

  try {
    state.settings = (await api.settings.get()) || {}
    api.settings.onDidChange(async () => {
      state.settings = (await api.settings.get()) || {}
      render()
    })
  } catch {
    state.settings = {}
  }

  try {
    api.plugin.on('cache.changed', (snapshot) => applySnapshot(snapshot))
  } catch (error) {
    state.error = error?.message || String(error)
  }

  if (typeof api.on === 'function') {
    api.on('theme', ({ colorScheme }) => {
      document.documentElement.classList.toggle('dark', colorScheme === 'dark')
      document.documentElement.classList.toggle('light', colorScheme !== 'dark')
    })
  }

  await load(false)
}

void init()
