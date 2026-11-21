export function escapeHtml(value) {
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

export function zapSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
}

export function refreshSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>'
}

export function chevronSvg() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 4 10 8 6 12"/></svg>'
}

export function getThresholds(settings) {
  const good = Number(settings?.goodAbove)
  const warn = Number(settings?.warnBelow)
  return {
    good: Number.isFinite(good) ? good : 85,
    warn: Number.isFinite(warn) ? warn : 65
  }
}

export function toneForRate(rate, settings) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'neutral'
  const { good, warn } = getThresholds(settings)
  if (rate >= good) return ''
  if (rate >= warn) return 'warning'
  return 'danger'
}

export function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(Math.round(n))
}

function localDate(ms, tzOffsetMinutes) {
  const offset = Number(tzOffsetMinutes)
  if (Number.isFinite(offset)) {
    return new Date(ms + offset * 60_000)
  }
  return new Date(ms - new Date().getTimezoneOffset() * 60_000)
}

export function formatClock(ms, tzOffsetMinutes) {
  if (!Number.isFinite(ms)) return '—'
  const d = localDate(ms, tzOffsetMinutes)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function formatClockSec(ms, tzOffsetMinutes) {
  if (!Number.isFinite(ms)) return '—'
  const d = localDate(ms, tzOffsetMinutes)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(
    2,
    '0'
  )}:${String(d.getUTCSeconds()).padStart(2, '0')}`
}

export function stateText(s) {
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
