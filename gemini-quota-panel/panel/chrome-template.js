import {
  escapeHtml,
  formatLocalDateTime,
  formatPercent,
  refreshSvg,
  sparkleSvg,
  toneForPercent
} from './formatters.js'
import { supportsGemini4 } from './quota-classifier.js'
import { accountArgonBreakdown, accountGeminiBreakdown } from './quota-metrics.js'

export function headerHtml(snapshot, state) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : []
  const ok = snapshot?.summary?.ok ?? 0
  const total = snapshot?.summary?.accounts ?? 0
  const failed = snapshot?.summary?.failed ?? 0
  const okAccounts = accounts.filter((a) => a && a.status === 'ok')
  const g4Ok = okAccounts.filter((a) => supportsGemini4(a)).length
  const excludedOk = okAccounts.length - g4Ok

  let pill = ''
  if (snapshot) {
    if (snapshot.error && !snapshot.stale) {
      pill = '<span class="status-pill danger">查询异常</span>'
    } else if (snapshot.stale) {
      pill = '<span class="status-pill warning">缓存中</span>'
    } else if (failed > 0) {
      pill = `<span class="status-pill warning">${g4Ok}/${total} 支持 G4</span>`
    } else if (g4Ok > 0) {
      const label = excludedOk > 0 ? `${g4Ok}/${total} 支持 G4` : `${g4Ok}/${total} 可用`
      const tip =
        excludedOk > 0
          ? `${ok}/${total} 账号在线 · ${g4Ok} 个支持 Gemini 4 · ${excludedOk} 个无 Gemini 4 已排除`
          : `${ok}/${total} 账号可用`
      pill = `<span class="status-pill" data-tooltip="${escapeHtml(tip)}">${label}</span>`
    } else if (ok > 0) {
      pill = `<span class="status-pill warning" data-tooltip="在线账号均未开通 Gemini 4 主模型">0/${total} 支持 G4</span>`
    } else if (total > 0) {
      pill = `<span class="status-pill neutral">0/${total} 可用</span>`
    }
  }

  return `
    <header class="topbar">
      <div class="brand">
        <span class="spark">${sparkleSvg()}</span>
        <span class="title">Gemini Quota</span>
        ${pill}
      </div>
      <button class="icon-btn ${state.refreshing ? 'spinning' : ''}" data-action="refresh" ${
        state.refreshing ? 'disabled' : ''
      } aria-label="刷新额度" data-tooltip="立即刷新额度 (R)">
        ${refreshSvg()}
      </button>
    </header>
  `
}

export function chipsHtml(accounts, state) {
  if (accounts.length <= 1) return ''
  const allChip = `
    <button class="chip" role="tab" aria-selected="${state.selectedAccount === 'all'}" data-action="account" data-account="all">
      <span class="chip-name">全部</span>
      <span class="chip-metric">${accounts.length}</span>
    </button>
  `
  const accountChips = accounts
    .map((account) => {
      const name = account.label || account.account.split('@')[0]
      let dotClass = ''
      let metric = ''
      let tip = account.account
      if (account.status === 'ok') {
        const g4 = supportsGemini4(account)
        const b = accountGeminiBreakdown(account)
        const ab = accountArgonBreakdown(account)
        const argonPct = ab.weekly ?? ab.overall
        if (!g4 && argonPct != null) {
          dotClass = toneForPercent(argonPct, state.settings)
          metric = `Argon ${formatPercent(argonPct)}`
          tip = `${account.account}\n未开通 Neon / Hydrogen 主模型，仅支持 Gemini 4 Argon\nArgon 周额度：${formatPercent(
            argonPct
          )}`
        } else if (!g4) {
          dotClass = 'skipped'
          metric = '无 G4'
          tip = `${account.account}\n未开通 Gemini 4 主模型，不计入汇总`
        } else {
          dotClass = toneForPercent(b.overall, state.settings)
          if (b.fiveHour != null && b.weekly != null) {
            metric = `${formatPercent(b.fiveHour)} / ${formatPercent(b.weekly)}`
            tip = `${account.account}\n5h 额度：${formatPercent(b.fiveHour)} · 周额度：${formatPercent(
              b.weekly
            )}`
          } else {
            metric = formatPercent(b.overall)
          }
          if (argonPct != null) tip += `\nArgon 周额度：${formatPercent(argonPct)}`
        }
      } else if (account.status === 'skipped') {
        dotClass = 'skipped'
        metric = '跳过'
      } else {
        dotClass = 'danger'
        metric = '失败'
      }
      return `
        <button class="chip" role="tab" aria-selected="${state.selectedAccount === account.account}" data-action="account" data-account="${escapeHtml(
          account.account
        )}" data-tooltip="${escapeHtml(tip)}">
          <span class="chip-dot ${dotClass}" aria-hidden="true"></span>
          <span class="chip-name">${escapeHtml(name)}</span>
          <span class="chip-metric">${escapeHtml(metric)}</span>
        </button>
      `
    })
    .join('')

  return `<div class="chips" role="tablist" aria-label="账号筛选">${allChip}${accountChips}</div>`
}

export function calloutsHtml(snapshot, state) {
  const error = snapshot?.error || state.error
  if (!error) return ''
  return `
    <div class="callout ${snapshot?.stale ? 'warning' : 'danger'}">
      <div>
        <strong>${snapshot?.stale ? '刷新失败 · 显示缓存' : '额度获取失败'}</strong>
        <p>${escapeHtml(error)}</p>
      </div>
      <button class="text-btn" data-action="refresh">重试</button>
    </div>
  `
}

export function footerHtml(snapshot, state) {
  const minutes = Number(state.settings?.refreshMinutes)
  const refreshText = Number.isFinite(minutes) && minutes >= 1 ? `${minutes} 分钟` : '5 分钟'
  const dot = snapshot.error && !snapshot.stale ? 'error' : snapshot.stale ? 'stale' : ''
  const fullStamp =
    snapshot.collectedAtLocal || formatLocalDateTime(snapshot.fetchedAt, snapshot) || '—'
  const shortStamp =
    typeof snapshot.collectedAtLocal === 'string' && snapshot.collectedAtLocal.length >= 16
      ? snapshot.collectedAtLocal.slice(11, 16)
      : fullStamp

  const left = state.refreshing
    ? '<span class="spinner" aria-hidden="true"></span><span>刷新中…</span>'
    : `<span class="live-dot ${dot}" aria-hidden="true"></span><span>CPA · Antigravity</span><span class="sep">·</span><span>每 ${refreshText}</span>`

  return `
    <footer class="foot">
      ${left}
      <span class="updated" data-tooltip="上次同步：${escapeHtml(fullStamp)}">更新于 ${escapeHtml(
        shortStamp
      )}</span>
    </footer>
  `
}

export function skeletonHtml() {
  return `
    <div class="skeleton" aria-label="正在加载额度">
      <div class="sk-card">
        <div class="sk-line" style="width:42%"></div>
        <div class="sk-line" style="width:76%"></div>
        <div class="sk-line" style="width:58%"></div>
      </div>
      <div class="sk-card">
        <div class="sk-line" style="width:36%"></div>
        <div class="sk-line" style="width:68%"></div>
      </div>
    </div>
  `
}

export function emptyStateHtml(message) {
  return `
    <div class="empty">
      <span class="spark">${sparkleSvg()}</span>
      <h2>暂无额度数据</h2>
      <p>${escapeHtml(message)}</p>
      <button class="text-btn" data-action="refresh">重新查询</button>
    </div>
  `
}
