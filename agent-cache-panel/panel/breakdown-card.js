import {
  chevronSvg,
  escapeHtml,
  formatClock,
  formatClockSec,
  formatPercent,
  formatTokens,
  toneForRate
} from './formatters.js'

export function breakdownCardHtml(session, state) {
  const tz = state.snapshot?.tzOffsetMinutes
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
                    const tone = toneForRate(t.hitRate, state.settings)
                    const w = t.hitRate == null ? 0 : Math.max(0, Math.min(100, t.hitRate))
                    const tip = `#${t.index} · ${formatClockSec(t.timestamp, tz)} · ${
                      t.model
                    }\n缓存读取 ${formatTokens(t.cacheReadTokens)} / 总输入 ${formatTokens(
                      t.totalInputTokens
                    )}\n未缓存 ${formatTokens(t.inputTokens)} · 输出 ${formatTokens(t.outputTokens)}`
                    return `
                      <div class="turn-row" data-tooltip="${escapeHtml(tip)}">
                        <span class="turn-time">${escapeHtml(formatClock(t.timestamp, tz))}</span>
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
