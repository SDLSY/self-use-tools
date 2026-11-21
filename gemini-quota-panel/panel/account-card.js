import { capabilityRowHtml, detailSectionHtml, usageGroupHtml } from './account-sections.js'
import { escapeHtml, formatPercent, localizeReason, toneForPercent } from './formatters.js'
import { supportsGemini4 } from './quota-classifier.js'
import {
  accountArgonBreakdown,
  accountGeminiBreakdown,
  displayGroupsForAccount
} from './quota-metrics.js'

function mutedAccountCardHtml(account, primary, showEmail, pillClass, pillText, snapshot) {
  return `
    <section class="account-card is-muted">
      <div class="account-body">
        <div class="account-head">
          <div class="account-id">
            <div class="account-name-row">
              <span class="account-primary" data-tooltip="${escapeHtml(primary)}">${escapeHtml(
                primary
              )}</span>
            </div>
            ${
              showEmail
                ? `<div class="account-email" data-tooltip="${escapeHtml(
                    account.account
                  )}">${escapeHtml(account.account)}</div>`
                : ''
            }
          </div>
          <span class="status-pill ${pillClass}">${pillText}</span>
        </div>
        <div class="skipped-reason">${escapeHtml(localizeReason(account, snapshot))}</div>
      </div>
    </section>
  `
}

export function accountCardHtml(account, state) {
  const primary = account.label || account.account
  const showEmail = Boolean(account.label && account.account && account.label !== account.account)

  if (account.status === 'skipped') {
    return mutedAccountCardHtml(account, primary, showEmail, 'neutral', '已跳过', state.snapshot)
  }

  const groups = displayGroupsForAccount(account)
  if (account.status === 'error' && !groups.length) {
    return mutedAccountCardHtml(account, primary, showEmail, 'danger', '查询失败', state.snapshot)
  }

  const g4Capable = supportsGemini4(account)
  const breakdown = accountGeminiBreakdown(account)
  const argonBreakdown = accountArgonBreakdown(account)
  const argonPct = argonBreakdown.weekly ?? argonBreakdown.overall

  let healthBadge = ''
  if (!g4Capable && argonPct != null) {
    healthBadge = `<span class="account-badge compact ${toneForPercent(
      argonPct,
      state.settings
    )}" data-tooltip="未开通 Neon / Hydrogen 主模型，仅计入 Gemini 4 Argon 独立周桶">Argon ${formatPercent(
      argonPct
    )}</span>`
  } else if (!g4Capable) {
    healthBadge = `<span class="account-badge muted" data-tooltip="未开通 Gemini 4 主模型，剩余额度不计入 Gemini 汇总计算">不计入 G4</span>`
  } else if (breakdown.fiveHour != null || breakdown.weekly != null) {
    const badges = []
    if (breakdown.fiveHour != null) {
      badges.push(
        `<span class="account-badge compact ${toneForPercent(
          breakdown.fiveHour,
          state.settings
        )}" data-tooltip="Gemini 主池 5h 窗口剩余额度">5h ${formatPercent(breakdown.fiveHour)}</span>`
      )
    }
    if (breakdown.weekly != null) {
      badges.push(
        `<span class="account-badge compact ${toneForPercent(
          breakdown.weekly,
          state.settings
        )}" data-tooltip="Gemini 主池每周剩余额度">周 ${formatPercent(breakdown.weekly)}</span>`
      )
    }
    healthBadge = `<div class="account-badges">${badges.join('')}</div>`
  } else if (breakdown.overall != null) {
    healthBadge = `<span class="account-badge ${toneForPercent(
      breakdown.overall,
      state.settings
    )}" data-tooltip="Gemini 主池最低剩余额度">${formatPercent(breakdown.overall)}</span>`
  }

  let body
  if (groups.length) {
    body = `<div class="groups">${groups.map((g) => usageGroupHtml(g, state)).join('')}</div>`
  } else {
    const msg = account.quotaSummaryError?.message || account.error || '上游未返回 Usage 汇总。'
    body = `<div class="callout warning"><div><strong>Usage 汇总暂不可用</strong><p>${escapeHtml(
      msg
    )}</p></div></div>`
  }

  const partialError =
    account.status === 'error' && groups.length
      ? `<div class="callout warning"><div><p>部分数据获取失败：${escapeHtml(
          account.error || 'unknown error'
        )}</p></div></div>`
      : ''

  return `
    <section class="account-card ${g4Capable || argonPct != null ? '' : 'is-excluded'}">
      <div class="account-body">
        <div class="account-head">
          <div class="account-id">
            <div class="account-name-row">
              <span class="account-primary" data-tooltip="${escapeHtml(primary)}">${escapeHtml(
                primary
              )}</span>
            </div>
            ${
              showEmail
                ? `<div class="account-email" data-tooltip="${escapeHtml(
                    account.account
                  )}">${escapeHtml(account.account)}</div>`
                : ''
            }
          </div>
          ${healthBadge}
        </div>
        ${capabilityRowHtml(account)}
        ${body}
        ${partialError}
      </div>
      ${detailSectionHtml(account, state)}
    </section>
  `
}
