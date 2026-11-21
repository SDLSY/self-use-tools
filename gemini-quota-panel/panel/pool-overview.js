import {
  escapeHtml,
  formatLocalDateTime,
  formatPercent,
  layersSvg,
  resetsInText,
  sparkleSvg,
  toneForPercent
} from './formatters.js'
import { supportsGemini4 } from './quota-classifier.js'
import {
  accountArgonBreakdown,
  accountGeminiBreakdown,
  computePoolTile
} from './quota-metrics.js'

export function poolOverviewHtml(accounts, state) {
  const okAccounts = accounts.filter((a) => a && a.status === 'ok')
  if (state.selectedAccount !== 'all' || okAccounts.length === 0) return ''

  const g4Accounts = okAccounts.filter((a) => supportsGemini4(a))
  const excludedAccounts = okAccounts.filter((a) => !supportsGemini4(a))
  const gemini = computePoolTile(g4Accounts, 'gemini')
  const argon = computePoolTile(okAccounts, 'argon')
  const third = computePoolTile(okAccounts, 'third-party')

  const excludedNames = excludedAccounts
    .map((a) => a.label || a.account.split('@')[0])
    .join('、')

  const windowTile = (title, pct, minPct, resetObj, perAccountLines) => {
    const tone = toneForPercent(pct, state.settings)
    const width = pct == null ? 0 : Math.max(0, Math.min(100, pct))
    const tipLines = [
      `Gemini 4 主池 · ${title}（${g4Accounts.length} 个支持 G4 账号平均）`,
      `平均剩余：${formatPercent(pct)}`
    ]
    if (minPct != null && g4Accounts.length > 1) tipLines.push(`最低账号：${formatPercent(minPct)}`)
    if (resetObj) tipLines.push(`最近重置：${formatLocalDateTime(resetObj.ms, state.snapshot)}`)
    if (perAccountLines.length) tipLines.push(...perAccountLines)
    if (excludedAccounts.length > 0) tipLines.push(`已排除无 G4 账号：${excludedNames}`)

    const resetHtml = resetObj
      ? `<span class="reset-relative" data-reset-iso="${escapeHtml(resetObj.iso)}">${escapeHtml(
          resetsInText(resetObj.iso)
        )}</span>`
      : '—'
    const lowText =
      minPct != null && g4Accounts.length > 1
        ? `最低 ${formatPercent(minPct)}`
        : `${g4Accounts.length} 账号`

    return `
      <div class="pool-tile" data-tooltip="${escapeHtml(tipLines.join('\n'))}">
        <div class="pool-head">
          <span class="pool-name">${escapeHtml(title)}</span>
          <span class="pool-badge">平均</span>
        </div>
        <div class="pool-pct ${tone}">${formatPercent(pct)}</div>
        <div class="bar-track" role="progressbar" aria-label="Gemini 4 ${escapeHtml(
          title
        )}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width.toFixed(1)}">
          <div class="bar-fill ${tone}" style="width:${width.toFixed(1)}%"></div>
        </div>
        <div class="pool-meta">
          <span class="pool-meta-item">${escapeHtml(lowText)}</span>
          <span class="pool-meta-item pool-meta-reset">${resetHtml}</span>
        </div>
      </div>
    `
  }

  let geminiBody = ''
  if (g4Accounts.length === 0) {
    geminiBody = `
      <div class="callout warning">
        <div>
          <strong>暂无支持 Gemini 4 的可用账号</strong>
          <p>当前 ${okAccounts.length} 个在线账号均未开通 Gemini 4 主模型，已全部排除出 Gemini 额度计算。</p>
        </div>
      </div>
    `
  } else {
    const fiveHourLines = []
    const weeklyLines = []
    for (const a of g4Accounts) {
      const name = a.label || a.account.split('@')[0]
      const b = accountGeminiBreakdown(a)
      if (b.fiveHour != null) fiveHourLines.push(`· ${name}：${formatPercent(b.fiveHour)}`)
      if (b.weekly != null) weeklyLines.push(`· ${name}：${formatPercent(b.weekly)}`)
    }
    geminiBody = `
      <div class="pool-grid">
        ${windowTile(
          '5h 额度',
          gemini.avg5h ?? gemini.avgAll,
          gemini.min5h ?? gemini.minAll,
          gemini.earliest5hReset,
          fiveHourLines
        )}
        ${windowTile('周额度', gemini.avgWeekly, gemini.minWeekly, gemini.earliestWeeklyReset, weeklyLines)}
      </div>
    `
  }

  const excludedBadge =
    excludedAccounts.length > 0
      ? `<span class="pool-excluded-tag" data-tooltip="以下账号未开通 Gemini 4 主模型，不计入上方汇总：\n${escapeHtml(
          excludedNames
        )}">已排除 ${excludedAccounts.length} 个无 G4</span>`
      : ''

  let argonStrip = ''
  const argonPct = argon.avgWeekly ?? argon.avgAll
  if (argonPct != null) {
    const argonTone = toneForPercent(argonPct, state.settings)
    const argonWidth = Math.max(0, Math.min(100, argonPct))
    const argonLines = []
    for (const a of okAccounts) {
      const ab = accountArgonBreakdown(a)
      const val = ab.weekly ?? ab.overall
      if (val != null) {
        argonLines.push(`· ${a.label || a.account.split('@')[0]}：${formatPercent(val)}`)
      }
    }
    const argonTipLines = [
      `Gemini 4 Argon · 独立每周额度桶（${argon.accountCount} 个账号平均）`,
      `平均剩余：${formatPercent(argonPct)}`
    ]
    const argonMin = argon.minWeekly ?? argon.minAll
    if (argonMin != null && argon.accountCount > 1) {
      argonTipLines.push(`最低账号：${formatPercent(argonMin)}`)
    }
    if (argon.earliestWeeklyReset) {
      argonTipLines.push(`最近重置：${formatLocalDateTime(argon.earliestWeeklyReset.ms, state.snapshot)}`)
    }
    if (argonLines.length) argonTipLines.push(...argonLines)

    argonStrip = `
      <div class="pool-secondary" data-tooltip="${escapeHtml(argonTipLines.join('\n'))}">
        <div class="pool-secondary-left">
          <span class="pool-icon">${sparkleSvg()}</span>
          <span class="pool-secondary-name">Gemini 4 Argon</span>
          <span class="pool-secondary-tag">独立周桶</span>
        </div>
        <div class="pool-secondary-metrics">
          <span class="pool-meta-item"><span>周</span><strong class="${argonTone}">${escapeHtml(
            formatPercent(argonPct)
          )}</strong></span>
          <span class="pool-secondary-bar" aria-hidden="true">
            <span class="bar-fill ${argonTone}" style="display:block;width:${argonWidth.toFixed(1)}%"></span>
          </span>
        </div>
      </div>
    `
  }

  let thirdStrip = ''
  if (third.avgAll != null) {
    const thirdTone = toneForPercent(third.avgAll, state.settings)
    const thirdWidth = Math.max(0, Math.min(100, third.avgAll))
    const thirdTip = [
      `Claude · GPT 池（${third.accountCount || okAccounts.length} 个在线账号平均）`,
      third.avg5h != null ? `5h 窗口平均：${formatPercent(third.avg5h)}` : '',
      third.avgWeekly != null ? `每周额度平均：${formatPercent(third.avgWeekly)}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    thirdStrip = `
      <div class="pool-secondary" data-tooltip="${escapeHtml(thirdTip)}">
        <div class="pool-secondary-left">
          <span class="pool-icon">${layersSvg()}</span>
          <span class="pool-secondary-name">Claude · GPT 池</span>
        </div>
        <div class="pool-secondary-metrics">
          <span class="pool-meta-item"><span>5h</span><strong>${escapeHtml(
            formatPercent(third.avg5h ?? third.avgAll)
          )}</strong></span>
          <span class="pool-meta-sep" aria-hidden="true">·</span>
          <span class="pool-meta-item"><span>周</span><strong>${escapeHtml(
            formatPercent(third.avgWeekly)
          )}</strong></span>
          <span class="pool-secondary-bar" aria-hidden="true">
            <span class="bar-fill ${thirdTone}" style="display:block;width:${thirdWidth.toFixed(1)}%"></span>
          </span>
        </div>
      </div>
    `
  }

  return `
    <section class="pool-section" aria-label="Gemini 4 共享池总览">
      <div class="pool-section-head">
        <div class="pool-section-title">
          <span class="pool-icon">${sparkleSvg()}</span>
          <span>Gemini 4 额度池</span>
          <span class="pool-count">${g4Accounts.length} 账号</span>
        </div>
        ${excludedBadge}
      </div>
      ${geminiBody}
      ${argonStrip}
      ${thirdStrip}
    </section>
  `
}
