import {
  chevronSvg,
  escapeHtml,
  formatLocalDateTime,
  formatPercent,
  layersSvg,
  resetsInText,
  sparkleSvg,
  toneForPercent
} from './formatters.js'
import {
  capabilityTags,
  classifyGroup,
  findBucket,
  groupModels,
  safeBuckets
} from './quota-classifier.js'
import { prettyGroupTitle } from './quota-metrics.js'

function meterTileHtml(bucket, label, state) {
  if (!bucket) return ''
  const fraction =
    typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
      ? bucket.remainingFraction
      : null
  const percent = fraction == null ? null : Math.max(0, Math.min(100, fraction * 100))
  const width = percent == null ? 0 : percent
  const tone = toneForPercent(percent, state.settings)
  const resetIso = bucket.resetTime || ''
  const resetRel = resetIso ? resetsInText(resetIso) : ''
  const resetLocal = resetIso ? formatLocalDateTime(resetIso, state.snapshot) : ''

  const tipLines = [`${label}：剩余 ${formatPercent(percent)}`]
  if (resetLocal) tipLines.push(`重置时间：${resetLocal}`)

  return `
    <div class="meter-tile" data-tooltip="${escapeHtml(tipLines.join('\n'))}">
      <div class="meter-top">
        <span class="meter-label">${escapeHtml(label)}</span>
        <span class="meter-pct ${tone}">${formatPercent(percent)}</span>
      </div>
      <div class="bar-track" role="progressbar" aria-label="${escapeHtml(label)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width.toFixed(1)}">
        <div class="bar-fill ${tone}" style="width:${width.toFixed(1)}%"></div>
      </div>
      <div class="meter-reset">${
        resetRel
          ? `<span class="reset-relative" data-reset-iso="${escapeHtml(resetIso)}">${escapeHtml(
              resetRel
            )}</span>`
          : '—'
      }</div>
    </div>
  `
}

export function usageGroupHtml(group, state) {
  const kind = classifyGroup(group)
  const title = prettyGroupTitle(group)
  const icon = kind === 'gemini' || kind === 'argon' ? sparkleSvg() : layersSvg()
  const fiveHour = findBucket(group, '5h')
  const weekly = findBucket(group, 'weekly')

  let tiles = []
  if (fiveHour) tiles.push(meterTileHtml(fiveHour, '5h 窗口', state))
  if (weekly) tiles.push(meterTileHtml(weekly, '每周额度', state))
  if (!tiles.length) {
    tiles = safeBuckets(group).map((b) => meterTileHtml(b, b.displayName || '额度', state))
  }

  let groupTag = ''
  if (kind === 'argon') {
    const tip =
      'Pro 账号的 Gemini 4 Argon 使用独立每周配额桶，不与 Neon / Hydrogen / Flash 共享。'
    groupTag = `<span class="group-tag" data-tooltip="${escapeHtml(tip)}">独立桶</span>`
  }

  const titleTip = group.description ? ` data-tooltip="${escapeHtml(group.description)}"` : ''

  return `
    <div class="group">
      <div class="group-head">
        <h2 class="group-title"${titleTip}>${icon}<span>${escapeHtml(title)}</span></h2>
        ${groupTag}
      </div>
      <div class="bucket-grid ${tiles.length === 1 ? 'single' : ''}">${tiles.join('')}</div>
    </div>
  `
}

function detailRowHtml(model, settings) {
  const tone = toneForPercent(model.percent, settings)
  const width = model.percent == null ? 0 : Math.max(0, Math.min(100, model.percent))
  const resetShort = model.resetLocal ? model.resetLocal.slice(5, 16) : ''
  const tipLines = [`${model.name} · 剩余 ${formatPercent(model.percent)}`]
  if (model.resetLocal) tipLines.push(`重置时间：${model.resetLocal}`)
  if (model.variants.length) tipLines.push(`变体：${model.variants.join(', ')}`)

  return `
    <div class="detail-row" data-tooltip="${escapeHtml(tipLines.join('\n'))}">
      <span class="detail-name">${escapeHtml(model.name)}</span>
      <span class="detail-bar-mini" aria-hidden="true">
        <span class="bar-fill ${tone}" style="display:block;width:${width.toFixed(1)}%"></span>
      </span>
      <span class="detail-pct ${tone}">${formatPercent(model.percent)}</span>
      <span class="detail-reset">${escapeHtml(resetShort)}</span>
    </div>
  `
}

export function detailSectionHtml(account, state) {
  const models = groupModels(account.models)
  if (!models.length) return ''
  const expanded = Boolean(state.expanded[account.account])

  let body = ''
  if (expanded) {
    const geminiModels = models.filter((m) => !m.thirdParty && !m.argon)
    const argonModels = models.filter((m) => m.argon)
    const thirdModels = models.filter((m) => m.thirdParty)
    const sections = []
    if (geminiModels.length) {
      sections.push({
        label: argonModels.length ? 'Gemini（主池）' : 'Gemini',
        items: geminiModels
      })
    }
    if (argonModels.length) {
      sections.push({ label: 'Gemini 4 Argon（独立周桶）', items: argonModels })
    }
    if (thirdModels.length) {
      sections.push({ label: 'Claude · GPT', items: thirdModels })
    }

    const renderRow = (m) => detailRowHtml(m, state.settings)
    const listHtml =
      sections.length > 1
        ? sections
            .map(
              (sec) =>
                `<div class="detail-section-label">${escapeHtml(sec.label)}</div>${sec.items
                  .map(renderRow)
                  .join('')}`
            )
            .join('')
        : models.map(renderRow).join('')

    const note = argonModels.length
      ? '同组模型共享对应额度桶（Pro 账号的 Argon 为独立周桶），以下为上游逐模型快照。'
      : '同组模型共享上方 5h / 每周额度池，以下为上游逐模型快照。'

    body = `
      <div class="detail">
        <div class="detail-note">${note}</div>
        ${listHtml}
      </div>
    `
  }

  return `
    <div class="detail-bar">
      <button class="detail-toggle" aria-expanded="${expanded}" data-action="toggle-detail" data-account="${escapeHtml(
        account.account
      )}">
        <span class="detail-toggle-left">
          <span>${expanded ? '收起模型明细' : '模型明细'}</span>
          <span class="detail-count">${models.length}</span>
        </span>
        <span class="chevron" aria-hidden="true">${chevronSvg()}</span>
      </button>
      ${body}
    </div>
  `
}

export function capabilityRowHtml(account) {
  const tags = capabilityTags(account)
  if (!tags.length) return ''
  return `<div class="cap-row">${tags
    .map((t) => `<span class="cap-tag ${t.accent ? 'accent' : ''}">${escapeHtml(t.text)}</span>`)
    .join('')}</div>`
}
