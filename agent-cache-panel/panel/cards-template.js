import {
  escapeHtml,
  formatClock,
  formatClockSec,
  formatPercent,
  formatTokens,
  getThresholds,
  refreshSvg,
  stateText,
  toneForRate,
  zapSvg
} from './formatters.js'

export function headerHtml(session, state) {
  const rate = session ? session.sessionHitRate : null
  const tone = session ? toneForRate(rate, state.settings) : 'neutral'
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

export function chipsHtml(sessions, selected, settings) {
  if (sessions.length <= 1) return ''
  return `
    <div class="chips" role="tablist" aria-label="已打开的 Coding Agent 窗口">
      ${sessions
        .map((s) => {
          const isSelected = selected && selected.id === s.id
          const dotTone = toneForRate(s.sessionHitRate, settings)
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

export function kpiGridHtml(session, settings, tzOffsetMinutes) {
  const sRate = session.sessionHitRate
  const lRate = session.latestHitRate
  const sTone = toneForRate(sRate, settings)
  const lTone = toneForRate(lRate, settings)
  const sWidth = sRate == null ? 0 : Math.max(0, Math.min(100, sRate))
  const lWidth = lRate == null ? 0 : Math.max(0, Math.min(100, lRate))

  const latestTurn = session.turns?.length ? session.turns[session.turns.length - 1] : null
  const sTip = `会话累计命中率：${formatPercent(sRate)}\n缓存读取：${formatTokens(
    session.cacheReadTokens
  )}\n总输入：${formatTokens(session.totalInputTokens)}\n共 ${session.turnCount} 轮`
  const lTip = latestTurn
    ? `第 #${latestTurn.index} 轮 (${formatClockSec(latestTurn.timestamp, tzOffsetMinutes)})\n模型：${
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
          latestTurn
            ? `新增 ${escapeHtml(formatTokens(latestTurn.inputTokens))} · 总 ${escapeHtml(
                formatTokens(latestTurn.totalInputTokens)
              )}`
            : '—'
        }</div>
      </div>
    </div>
  `
}

export function sparkbarCardHtml(session, settings, tzOffsetMinutes) {
  if (session.cacheTelemetryAvailable === false) return ''
  const turns = Array.isArray(session.turns) ? session.turns.slice(-28) : []
  if (!turns.length) return ''

  const { good } = getThresholds(settings)
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
      const tone = toneForRate(pct, settings)
      const h = Math.max(2.5, (pct / 100) * plotH)
      const x = startX + i * (barW + gap)
      const y = padTop + plotH - h
      const rx = Math.min(2.5, barW / 2)
      const tip = [
        `#${t.index} · ${formatClockSec(t.timestamp, tzOffsetMinutes)} · ${t.model || session.model}`,
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
  const firstTime = turns[0]?.timestamp ? formatClock(turns[0].timestamp, tzOffsetMinutes) : ''
  const lastTime = turns[turns.length - 1]?.timestamp
    ? formatClock(turns[turns.length - 1].timestamp, tzOffsetMinutes)
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

export function footerHtml(snapshot, session, settings) {
  const wsName = snapshot?.workspace?.displayName || '本地工作区'
  const sec = Number(settings?.refreshSeconds)
  const intervalText = Number.isFinite(sec) && sec >= 2 ? `${sec}s` : '3s'
  const dotClass = session?.live ? '' : 'idle'
  const tz = snapshot?.tzOffsetMinutes
  return `
    <footer class="foot">
      <span class="live-dot ${dotClass}" aria-hidden="true"></span>
      <span>${escapeHtml(wsName)}</span>
      <span class="sep">·</span>
      <span>每 ${intervalText}同步</span>
      <span class="updated" data-tooltip="上次检查：${escapeHtml(
        formatClockSec(snapshot?.fetchedAt, tz)
      )}">更新于 ${escapeHtml(formatClock(snapshot?.fetchedAt, tz))}</span>
    </footer>
  `
}

export function emptyHtml(msg) {
  return `
    <div class="empty">
      <h2>暂无缓存数据</h2>
      <p>${escapeHtml(msg)}</p>
      <button class="text-btn" data-action="refresh">重新检测</button>
    </div>
  `
}
