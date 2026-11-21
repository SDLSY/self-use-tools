import { accountCardHtml } from './account-card.js'
import {
  calloutsHtml,
  chipsHtml,
  emptyStateHtml,
  footerHtml,
  headerHtml,
  skeletonHtml
} from './chrome-template.js'
import { resetsInText } from './formatters.js'
import { poolOverviewHtml } from './pool-overview.js'
import { sortAccounts } from './quota-metrics.js'

const api = window.orca
const app = document.getElementById('app')
const tooltipEl = document.getElementById('tooltip')

const state = {
  snapshot: null,
  settings: {},
  loading: true,
  refreshing: false,
  error: null,
  selectedAccount: 'all',
  expanded: {}
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

function tick() {
  document.querySelectorAll('.reset-relative[data-reset-iso]').forEach((el) => {
    const iso = el.getAttribute('data-reset-iso')
    if (!iso) return
    const next = resetsInText(iso)
    if (next) el.textContent = next
  })
}

function render() {
  hideTooltip()
  if (!api || !api.plugin) {
    app.setAttribute('aria-busy', 'false')
    app.innerHTML =
      headerHtml(null, state) + emptyStateHtml('Orca 插件桥不可用，请确认插件已启用并重新打开面板。')
    return
  }

  const snapshot = state.snapshot
  app.setAttribute('aria-busy', state.loading || state.refreshing ? 'true' : 'false')

  if (!snapshot) {
    app.innerHTML =
      headerHtml(null, state) + (state.error ? emptyStateHtml(state.error) : skeletonHtml())
    return
  }

  const accounts = sortAccounts(Array.isArray(snapshot.accounts) ? snapshot.accounts : [])
  if (!accounts.length) {
    app.innerHTML =
      headerHtml(snapshot, state) +
      calloutsHtml(snapshot, state) +
      emptyStateHtml(snapshot.error || '没有可用的 CPA Antigravity 账号。')
    return
  }

  const visible =
    state.selectedAccount === 'all'
      ? accounts
      : accounts.filter((a) => a.account === state.selectedAccount)

  app.innerHTML = [
    headerHtml(snapshot, state),
    poolOverviewHtml(accounts, state),
    chipsHtml(accounts, state),
    calloutsHtml(snapshot, state),
    `<div class="accounts">${visible.map((a) => accountCardHtml(a, state)).join('')}</div>`,
    footerHtml(snapshot, state)
  ].join('')

  tick()
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    state.error = '额度返回格式无效。'
    state.loading = false
    state.refreshing = false
    render()
    return
  }
  state.snapshot = snapshot
  state.error = snapshot.error || null
  state.loading = false
  state.refreshing = false
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : []
  if (
    state.selectedAccount !== 'all' &&
    !accounts.some((a) => a && a.account === state.selectedAccount)
  ) {
    state.selectedAccount = 'all'
  }
  render()
}

async function load(force) {
  state.error = null
  if (force) state.refreshing = true
  if (!state.snapshot) state.loading = true
  render()
  try {
    const result = force
      ? await api.plugin.request('quota.refresh', undefined, { timeoutMs: 120000 })
      : await api.plugin.request('quota.get', {}, { timeoutMs: 120000 })
    applySnapshot(result)
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
  } else if (action === 'account') {
    state.selectedAccount = target.getAttribute('data-account') || 'all'
    render()
  } else if (action === 'toggle-detail') {
    const account = target.getAttribute('data-account') || ''
    state.expanded[account] = !state.expanded[account]
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
    api.plugin.on('quota.changed', (snapshot) => applySnapshot(snapshot))
    api.plugin.on('quota.refreshing', () => {
      state.refreshing = true
      render()
    })
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
  setInterval(tick, 30_000)
}

void init()
