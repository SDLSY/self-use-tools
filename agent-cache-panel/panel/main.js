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

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function zapSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
}

function refreshSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>'
}

function chevronSvg() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 4 10 8 6 12"/></svg>'
}

function getThresholds() {
  const good = Number(state.settings?.goodAbove)
  const warn = Number(state.settings?.warnBelow)
  return {
    good: Number.isFinite(good) ? good : 85,
    warn: Number.isFinite(warn) ? warn : 65
  }
}

function toneForRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'neutral'
  const { good, warn } = getThresholds()
  if (rate >= good) return ''
  if (rate >= warn) return 'warning'
  return 'danger'
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(Math.round(n))
}

function localDate(ms) {
  const offset = Number(state.snapshot?.tzOffsetMinutes)
  if (Number.isFinite(offset)) {
    return new Date(ms + offset * 60_000)
  }
  return new Date(ms - new Date().getTimezoneOffset() * 60_000)
}

function formatClock(ms) {
  if (!Number.isFinite(ms)) return '—'
  const d = localDate(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function formatClockSec(ms) {
  if (!Number.isFinite(ms)) return '—'
  const d = localDate(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(
    2,
    '0'
  )}:${String(d.getUTCSeconds()).padStart(2, '0')}`
}

function stateText(s) {
  switch (s) {
    case 'working':
      return '运行中'
    case 'waiting':
      return '等待输入'
    case 'blocked':
      return '待确认'
    case 'done':
      return '已完成'
    default:
      return '最近会话'
  }
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

function headerHtml(session) {
  const rate = session ? session.sessionHitRate : null
  const tone = session ? toneForRate(rate) : 'neutral'
  let pill = '<span class="status-pill neutral">待检测</span>'
  if (session) {
    const pillTone = session.live ? '' : 'neutral'
    pill = `<span class="status-pill ${pillTone}">${escapeHtml(session.agentLabel)} · ${escapeHtml(
      stateText(session.state)
    )}</span>`
  }

  return `
    <header class="topbar">
      <div class="brand">
        <span class="brand-icon ${tone}">${zapSvg()}</span>
        <span class="title">Agent Cache</span>
        ${pill}
      </div>
      <button class="icon-btn ${state.refreshing ? 'spinning' : ''}" data-action="refresh" ${
        state.refreshing ? 'disabled' : ''
      } aria-label="刷新缓存统计" data-tooltip="立即刷新 (R)">
        ${refreshSvg()}
      </button>
    </header>
  `
}

function chipsHtml(sessions, selected) {
  if (sessions.length <= 1) return ''
  return `
    <div class="chips" role="tablist" aria-label="已打开的 Coding Agent 窗口">
      ${sessions
        .map((s) => {
          const isSelected = selected && selected.id === s.id
          const dotTone = toneForRate(s.sessionHitRate)
          const focusTag = s.focused ? ' · 当前聚焦窗口' : ''
          const tip = `${s.title} (${s.agentLabel} · ${s.model})${focusTag}\n${s.turnCount} 轮 · 会话命中 ${formatPercent(
            s.sessionHitRate
          )}`
          return `
            <button class="chip" role="tab" aria-selected="${isSelected}" data-action="select" data-id="${escapeHtml(
              s.id
            )}" data-tooltip="${escapeHtml(tip)}">
              <span class="chip-dot ${dotTone}" aria-hidden="true"></span>
              <span class="chip-name">${escapeHtml(s.title)}</span>
              <span class="chip-metric">${escapeHtml(formatPercent(s.sessionHitRate))}</span>
            </button>
          `
        })
        .join('')}
    </div>
  `
}

function kpiGridHtml(session) {
  const sRate = session.sessionHitRate
  const lRate = session.latestHitRate
  const sTone = toneForRate(sRate)
  const lTone = toneForRate(lRate)
  const sWidth = sRate == null ? 0 : Math.max(0, Math.min(100, sRate))
  const lWidth = lRate == null ? 0 : Math.max(0, Math.min(100, lRate))

  const latestTurn = session.turns?.length ? session.turns[session.turns.length - 1] : null
  const sTip = `会话累计命中率：${formatPercent(sRate)}\n缓存读取：${formatTokens(
    session.cacheReadTokens
  )}\n总输入：${formatTokens(session.totalInputTokens)}\n共 ${session.turnCount} 轮`
  const lTip = latestTurn
    ? `第 #${latestTurn.index} 轮 (${formatClockSec(latestTurn.timestamp)})\n模型：${
        latestTurn.model
      }\n命中率：${formatPercent(latestTurn.hitRate)}\n缓存读取 ${formatTokens(
        latestTurn.cacheReadTokens
      )} · 未缓存 ${formatTokens(latestTurn.inputTokens)}`
    : '暂无轮次数据'

  return `
    <div class="kpi-grid">
      <div class="kpi-tile" data-tooltip="${escapeHtml(sTip)}">
        <div class="kpi-head">
          <span class="kpi-name">会话命中率</span>
          <span class="kpi-sub">${session.turnCount} 轮</span>
        </div>
        <div class="kpi-value ${sTone}">${formatPercent(sRate)}</div>
        <div class="bar-track" role="progressbar" aria-label="会话缓存命中率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${sWidth.toFixed(
          1
        )}">
          <div class="bar-fill ${sTone}" style="width:${sWidth.toFixed(1)}%"></div>
        </div>
        <div class="kpi-meta">${escapeHtml(formatTokens(session.cacheReadTokens))} / ${escapeHtml(
          formatTokens(session.totalInputTokens)
        )}</div>
      </div>

      <div class="kpi-tile" data-tooltip="${escapeHtml(lTip)}">
        <div class="kpi-head">
          <span class="kpi-name">最近一轮</span>
          <span class="kpi-sub">近 5 轮 ${escapeHtml(formatPercent(session.recent5HitRate))}</span>
        </div>
        <div class="kpi-value ${lTone}">${formatPercent(lRate)}</div>
        <div class="bar-track" role="progressbar" aria-label="最近一轮缓存命中率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${lWidth.toFixed(
          1
        )}">
          <div class="bar-fill ${lTone}" style="width:${lWidth.toFixed(1)}%"></div>
        </div>
        <div class="kpi-meta">${
          latestTurn ? `新增 ${escapeHtml(formatTokens(latestTurn.inputTokens))} · 总 ${escapeHtml(formatTokens(latestTurn.totalInputTokens))}` : '—'
        }</div>
      </div>
    </div>
  `
}

function sparkbarCardHtml(session) {
  if (session.cacheTelemetryAvailable === false) return ''
  const turns = Array.isArray(session.turns) ? session.turns.slice(-28) : []
  if (!turns.length) return ''

  const { good } = getThresholds()
  const W = 310
  const H = 92
  const padLeft = 26
  const padRight = 4
  const padTop = 8
  const padBottom = 8
  const plotW = W - padLeft - padRight
  const plotH = H - padTop - padBottom

  const yFor = (pct) => padTop + plotH * (1 - pct / 100)
  const slotW = plotW / Math.max(turns.length, 10)
  const gap = Math.min(3, Math.max(1.5, slotW * 0.22))
  const barW = Math.max(3, Math.min(12, slotW - gap))
  const startX = padLeft + (plotW - turns.length * (barW + gap) + gap)

  const bars = turns
    .map((t, i) => {
      const pct = typeof t.hitRate === 'number' && Number.isFinite(t.hitRate) ? t.hitRate : 0
      const tone = toneForRate(pct)
      const h = Math.max(2.5, (pct / 100) * plotH)
      const x = startX + i * (barW + gap)
      const y = padTop + plotH - h
      const rx = Math.min(2.5, barW / 2)
      const tip = [
        `#${t.index} · ${formatClockSec(t.timestamp)} · ${t.model || session.model}`,
        `命中率：${formatPercent(t.hitRate)}`,
        `缓存读取：${formatTokens(t.cacheReadTokens)} | 未缓存：${formatTokens(t.inputTokens)}`,
        t.cacheCreateTokens > 0
          ? `缓存写入：${formatTokens(t.cacheCreateTokens)} | 输出：${formatTokens(t.outputTokens)}`
          : `输出：${formatTokens(t.outputTokens)}`
      ].join('\n')
      return `<rect class="chart-bar ${tone}" x="${x.toFixed(1)}" y="${y.toFixed(
        1
      )}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx.toFixed(
        1
      )}" data-tooltip="${escapeHtml(tip)}" />`
    })
    .join('')

  const yGood = yFor(good)
  const yMid = yFor(50)
  const yZero = yFor(0)

  const firstTime = turns[0]?.timestamp ? formatClock(turns[0].timestamp) : ''
  const lastTime = turns[turns.length - 1]?.timestamp
    ? formatClock(turns[turns.length - 1].timestamp)
    : ''

  return `
    <section class="card">
      <div class="card-body">
        <div class="card-head">
          <h2 class="card-title">逐轮命中趋势</h2>
          <span class="card-meta" data-tooltip="${escapeHtml(session.model)}">${escapeHtml(
            session.model
          )}</span>
        </div>
        <div class="chart-wrap">
          <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="最近 ${
            turns.length
          } 轮缓存命中率柱状图">
            <line class="chart-grid" x1="${padLeft}" y1="${yGood.toFixed(1)}" x2="${W - padRight}" y2="${yGood.toFixed(1)}" />
            <line class="chart-grid" x1="${padLeft}" y1="${yMid.toFixed(1)}" x2="${W - padRight}" y2="${yMid.toFixed(1)}" />
            <line class="chart-grid" x1="${padLeft}" y1="${yZero.toFixed(1)}" x2="${W - padRight}" y2="${yZero.toFixed(1)}" />
            <text class="chart-axis-label" x="${padLeft - 4}" y="${(yGood + 3).toFixed(1)}" text-anchor="end">${good}%</text>
            <text class="chart-axis-label" x="${padLeft - 4}" y="${(yMid + 3).toFixed(1)}" text-anchor="end">50%</text>
            <text class="chart-axis-label" x="${padLeft - 4}" y="${(yZero + 2).toFixed(1)}" text-anchor="end">0%</text>
            ${bars}
          </svg>
        </div>
        <div class="chart-foot">
          <span>近 ${turns.length} 轮${firstTime ? ` · ${firstTime}` : ''}</span>
          <span>${lastTime ? `最新 ${lastTime}` : ''}</span>
        </div>
      </div>
    </section>
  `
}

function breakdownCardHtml(session) {
  const totalIn = Math.max(1, session.totalInputTokens)
  const hitPct = (session.cacheReadTokens / totalIn) * 100
  const writePct = (session.cacheCreateTokens / totalIn) * 100
  const missPct = Math.max(0, 100 - hitPct - writePct)

  const segments = []
  if (session.cacheReadTokens > 0) {
    segments.push(
      `<div class="seg hit" style="width:${hitPct.toFixed(2)}%" data-tooltip="缓存读取：${formatTokens(
        session.cacheReadTokens
      )} (${hitPct.toFixed(1)}%)"></div>`
    )
  }
  if (session.cacheCreateTokens > 0) {
    segments.push(
      `<div class="seg write" style="width:${writePct.toFixed(
        2
      )}%" data-tooltip="缓存写入：${formatTokens(session.cacheCreateTokens)} (${writePct.toFixed(
        1
      )}%)"></div>`
    )
  }
  if (session.uncachedInputTokens > 0) {
    segments.push(
      `<div class="seg miss" style="width:${missPct.toFixed(
        2
      )}%" data-tooltip="未缓存输入：${formatTokens(session.uncachedInputTokens)} (${missPct.toFixed(
        1
      )}%)"></div>`
    )
  }

  const noteHtml =
    session.cacheTelemetryAvailable === false && session.telemetryNote
      ? `
        <div class="callout info">
          <strong>当前 Agent 暂未提供缓存明细</strong>
          <p>${escapeHtml(session.telemetryNote)}</p>
        </div>
      `
      : ''

  const alertHtml =
    session.cacheTelemetryAvailable !== false && session.largeMissCount > 0
      ? `
        <div class="callout">
          <strong>检测到 ${session.largeMissCount} 次大额缓存未命中</strong>
          <p>累计重算 ${escapeHtml(
            formatTokens(session.largeMissTokens)
          )} 未缓存输入（单轮 ≥25K 且命中 &lt;20%），常见原因为超过 ~5 分钟 TTL 或上游切换账号。</p>
        </div>
      `
      : ''

  const recentList = [...(session.turns || [])].reverse().slice(0, 15)
  const turnsDrawer = recentList.length
    ? `
      <div class="detail-bar">
        <button class="detail-toggle" aria-expanded="${state.turnsExpanded}" data-action="toggle-turns">
          <span class="detail-toggle-left">
            <span>${state.turnsExpanded ? '收起轮次明细' : '最近轮次明细'}</span>
            <span class="detail-count">${recentList.length}</span>
          </span>
          <span class="chevron" aria-hidden="true">${chevronSvg()}</span>
        </button>
        ${
          state.turnsExpanded
            ? `
              <div class="detail">
                ${recentList
                  .map((t) => {
                    const tone = toneForRate(t.hitRate)
                    const w = t.hitRate == null ? 0 : Math.max(0, Math.min(100, t.hitRate))
                    const tip = `#${t.index} · ${formatClockSec(t.timestamp)} · ${
                      t.model
                    }\n缓存读取 ${formatTokens(t.cacheReadTokens)} / 总输入 ${formatTokens(
                      t.totalInputTokens
                    )}\n未缓存 ${formatTokens(t.inputTokens)} · 输出 ${formatTokens(t.outputTokens)}`
                    return `
                      <div class="turn-row" data-tooltip="${escapeHtml(tip)}">
                        <span class="turn-time">${escapeHtml(formatClock(t.timestamp))}</span>
                        <span class="turn-in">总 ${escapeHtml(
                          formatTokens(t.totalInputTokens)
                        )} · 新 ${escapeHtml(formatTokens(t.inputTokens))}</span>
                        <span class="turn-bar" aria-hidden="true">
                          <span class="bar-fill ${tone}" style="display:block;width:${w.toFixed(
                            1
                          )}%"></span>
                        </span>
                        <span class="turn-pct ${tone}">${formatPercent(t.hitRate)}</span>
                      </div>
                    `
                  })
                  .join('')}
              </div>
            `
            : ''
        }
      </div>
    `
    : ''

  return `
    <section class="card">
      <div class="card-body">
        <div class="card-head">
          <h2 class="card-title">输入 Token 构成</h2>
          <span class="card-meta">总计 ${escapeHtml(
            formatTokens(session.totalInputTokens + session.outputTokens)
          )}</span>
        </div>
        <div class="seg-bar" role="img" aria-label="缓存读取与未缓存输入占比">${segments.join(
          ''
        )}</div>
        <div class="stat-grid">
          <div class="stat-cell">
            <span class="stat-label"><span class="swatch hit"></span>缓存读取</span>
            <span class="stat-num">${escapeHtml(formatTokens(session.cacheReadTokens))}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label"><span class="swatch miss"></span>未缓存输入</span>
            <span class="stat-num">${escapeHtml(formatTokens(session.uncachedInputTokens))}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label"><span class="swatch write"></span>缓存写入</span>
            <span class="stat-num">${escapeHtml(formatTokens(session.cacheCreateTokens))}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label"><span class="swatch out"></span>总输出</span>
            <span class="stat-num">${escapeHtml(formatTokens(session.outputTokens))}</span>
          </div>
        </div>
        ${noteHtml}
        ${alertHtml}
      </div>
      ${turnsDrawer}
    </section>
  `
}

function footerHtml(snapshot, session) {
  const wsName = snapshot?.workspace?.displayName || '本地工作区'
  const sec = Number(state.settings?.refreshSeconds)
  const intervalText = Number.isFinite(sec) && sec >= 2 ? `${sec}s` : '3s'
  const dotClass = session?.live ? '' : 'idle'
  return `
    <footer class="foot">
      <span class="live-dot ${dotClass}" aria-hidden="true"></span>
      <span>${escapeHtml(wsName)}</span>
      <span class="sep">·</span>
      <span>每 ${intervalText}同步</span>
      <span class="updated" data-tooltip="上次检查：${escapeHtml(
        formatClockSec(snapshot?.fetchedAt)
      )}">更新于 ${escapeHtml(formatClock(snapshot?.fetchedAt))}</span>
    </footer>
  `
}

function emptyHtml(msg) {
  return `
    <div class="empty">
      <h2>暂无缓存数据</h2>
      <p>${escapeHtml(msg)}</p>
      <button class="text-btn" data-action="refresh">重新检测</button>
    </div>
  `
}

function render() {
  hideTooltip()
  if (!api || !api.plugin) {
    app.setAttribute('aria-busy', 'false')
    app.innerHTML = headerHtml(null) + emptyHtml('Orca 插件桥不可用，请重新打开面板。')
    return
  }

  const snapshot = state.snapshot
  app.setAttribute('aria-busy', state.loading || state.refreshing ? 'true' : 'false')

  if (!snapshot) {
    app.innerHTML =
      headerHtml(null) +
      emptyHtml(state.error || '正在读取当前工作区 Coding Agent 会话日志…')
    return
  }

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const session = activeSession(snapshot)
  if (!session) {
    app.innerHTML =
      headerHtml(null) +
      emptyHtml('当前工作区没有打开的 Coding Agent 或 Bot 会话。打开 Claude Code / Codex / OpenCode / Pi / AGY 或 Bot 对话后将自动显示。') +
      footerHtml(snapshot, null)
    return
  }

  app.innerHTML = [
    headerHtml(session),
    chipsHtml(sessions, session),
    kpiGridHtml(session),
    sparkbarCardHtml(session),
    breakdownCardHtml(session),
    footerHtml(snapshot, session)
  ].join('')
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  state.snapshot = snapshot
  state.loading = false
  state.refreshing = false
  state.error = snapshot.error || null
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []

  // Auto-follow when the user switches to a different coding agent tab in Orca
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

// Viewport-clamped floating tooltip
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
