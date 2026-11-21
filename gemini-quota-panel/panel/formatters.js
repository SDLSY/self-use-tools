export const DISPLAY_NAMES = {
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-4-hydrogen-sonar': 'Gemini 4 Hydrogen Sonar',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash Image',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
  'gemini-2.5-flash-thinking': 'Gemini 2.5 Flash Thinking',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'gpt-oss-120b': 'GPT-OSS 120B'
}

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

export function sparkleSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="url(#gemini-gradient)" d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z"/></svg>'
}

export function layersSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/></svg>'
}

export function refreshSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>'
}

export function chevronSvg() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 4 10 8 6 12"/></svg>'
}

export function getThresholds(settings) {
  const warn = Number(settings?.warnBelow)
  const danger = Number(settings?.dangerBelow)
  return {
    warn: Number.isFinite(warn) ? warn : 20,
    danger: Number.isFinite(danger) ? danger : 5
  }
}

export function toneForPercent(value, settings) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const { warn, danger } = getThresholds(settings)
  if (value < danger) return 'danger'
  if (value < warn) return 'warning'
  return ''
}

export function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

export function systemOffsetMinutes(snapshot) {
  if (snapshot?.generatedAt && snapshot?.collectedAtLocal) {
    const utcMs = Date.parse(snapshot.generatedAt)
    const m = String(snapshot.collectedAtLocal).match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/
    )
    if (Number.isFinite(utcMs) && m) {
      const localAsUtc = Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] || 0)
      )
      const diffMin = Math.round((localAsUtc - utcMs) / 60000 / 15) * 15
      if (Number.isFinite(diffMin) && Math.abs(diffMin) <= 840) return diffMin
    }
  }
  return -new Date().getTimezoneOffset()
}

export function formatLocalDateTime(value, snapshot) {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return ''
  const shifted = new Date(ms + systemOffsetMinutes(snapshot) * 60000)
  if (Number.isNaN(shifted.getTime())) return ''
  return `${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日 ${String(
    shifted.getUTCHours()
  ).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
}

export function resetsInText(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return ''
  const diff = ms - Date.now()
  if (diff <= 0) return '即将重置'
  const minutes = Math.floor(diff / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return `${days}d ${hours}h 后重置`
  if (hours > 0) return `${hours}h ${rest}m 后重置`
  return `${Math.max(1, rest)}m 后重置`
}

export function localizeReason(account, snapshot) {
  const raw = String(account?.reason || account?.error || '').trim()
  if (!raw) return account?.status === 'skipped' ? '该账号当前已跳过。' : '查询失败。'

  const expiredMatch = raw.match(
    /access token expired at\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*UTC/i
  )
  if (expiredMatch) {
    const iso = `${expiredMatch[1].replace(' ', 'T')}:00Z`
    const local = formatLocalDateTime(iso, snapshot)
    return `Token 已于 ${local || expiredMatch[1] + ' UTC'} 过期，等待 CPA 使用时自动刷新`
  }
  if (/disabled in auth file/i.test(raw)) return '已在 CPA 认证配置中禁用'
  if (/no access_token/i.test(raw)) return '认证文件缺少 access_token'
  return raw
}
