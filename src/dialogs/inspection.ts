import type {
  AppState,
  Connection,
  HongSshApi,
  InspectionDisk,
  InspectionProgressEvent,
  InspectionResult,
  InspectionStatus,
  InspectionSummary
} from '../types'
import { el, uid } from '../ui/dom'
import { icon } from '../ui/icons'
import { button } from '../ui/forms'
import type { ModalHandle, ModalHost } from '../ui/modal'
import { folderPathLabel } from './misc'

type InspectionFilter = 'all' | InspectionStatus

const STATUS_LABELS: Record<InspectionStatus | 'pending', string> = {
  alert: '告警',
  ok: '正常',
  error: '失败',
  skipped: '跳过',
  pending: '等待'
}

const STATUS_ORDER: Record<InspectionStatus | 'pending', number> = {
  alert: 0,
  error: 1,
  ok: 2,
  skipped: 3,
  pending: 4
}

export function openInspectionDialog(options: {
  modal: ModalHost
  api: HongSshApi
  state: AppState
  onThresholdChange: (value: number) => void
}): void {
  const { modal, api, state, onThresholdChange } = options
  const connections = state.connections.filter((connection) => connection.protocol === 'ssh')
  const results = new Map<string, InspectionResult>()

  let handle: ModalHandle
  let filter: InspectionFilter = 'all'
  let running = false
  let stopping = false
  let finished = false
  let aborted = false
  let runId = ''
  let runStartedAt = 0
  let threshold = clampThreshold(state.settings.inspectionDiskThreshold)
  let diskEnabled = true

  const thresholdInput = el('input', {
    class: 'text-input',
    type: 'number',
    min: 1,
    max: 100,
    step: 1,
    value: String(threshold),
    autofocus: true,
    'aria-label': '磁盘使用率告警阈值'
  })
  const diskCheckbox = el('input', {
    type: 'checkbox',
    checked: true,
    'aria-label': '巡检磁盘空间'
  })
  const errorEl = el('div', { class: 'inspection-error', role: 'alert', hidden: true })
  const progressEl = el('div', { class: 'inspection-progress', hidden: true })
  const progressSpinner = el('span', { class: 'mini-spinner' })
  const progressText = el('span', { class: 'inspection-progress-text' })
  const progressCount = el('span', { class: 'inspection-progress-count' })
  const progressFill = el('span', { class: 'inspection-progress-fill' })
  const summaryEl = el('div', { class: 'inspection-summary', hidden: true })
  const bannerEl = el('div', { class: 'inspection-banner', hidden: true })
  const resultsEl = el('div', { class: 'inspection-results' })
  const footerNote = el('span', { class: 'inspection-footer-note' })
  const startLabel = el('span', { text: '开始巡检' })
  const startButton = el(
    'button',
    {
      class: 'btn btn-primary inspection-run-button',
      type: 'button',
      onclick: () => void start()
    },
    el('span', { class: 'btn-icon', html: icon('shield', 16) }),
    startLabel
  )
  const stopButton = el(
    'button',
    {
      class: 'btn inspection-stop-button',
      type: 'button',
      hidden: true,
      onclick: () => void stop()
    },
    el('span', { class: 'btn-icon', html: icon('close', 16) }),
    el('span', { text: '停止' })
  )

  progressEl.append(
    el(
      'div',
      { class: 'inspection-progress-head' },
      progressSpinner,
      progressText,
      progressCount
    ),
    el('div', { class: 'inspection-progress-track', role: 'progressbar' }, progressFill)
  )

  const scopeEl = el('span', { class: 'inspection-scope' })
  const setupEl = el(
    'section',
    { class: 'inspection-setup' },
    el(
      'label',
      { class: 'inspection-option' },
      diskCheckbox,
      el(
        'span',
        { class: 'inspection-option-text' },
        el('strong', { class: 'inspection-option-title', text: '磁盘空间使用率' }),
        el('span', {
          class: 'inspection-option-hint',
          text: '通过 SSH 执行 df，检查每个挂载点是否达到告警阈值'
        })
      )
    ),
    el(
      'div',
      { class: 'inspection-threshold' },
      el('span', { class: 'inspection-threshold-label', text: '告警阈值' }),
      el(
        'div',
        { class: 'inspection-threshold-input' },
        thresholdInput,
        el('span', { class: 'inspection-threshold-unit', text: '%' })
      )
    )
  )

  const body = el(
    'div',
    { class: 'inspection' },
    setupEl,
    el(
      'div',
      { class: 'inspection-meta' },
      el('span', { class: 'inspection-meta-icon', html: icon('server', 14) }),
      scopeEl,
      el('span', { class: 'inspection-meta-hint', text: '已打开的会话会被复用' })
    ),
    errorEl,
    progressEl,
    summaryEl,
    bannerEl,
    resultsEl
  )

  const progressUnsubscribe = api.onInspectionProgress(onProgress)

  handle = modal.open({
    title: '主机巡检',
    subtitle: '检查已配置连接的磁盘空间，快速定位空间告警',
    icon: 'shield',
    width: 900,
    body,
    footer: el(
      'div',
      { class: 'modal-actions spread' },
      footerNote,
      el(
        'div',
        { class: 'modal-actions' },
        stopButton,
        button('关闭', { kind: 'ghost', onClick: () => handle.close() }),
        startButton
      )
    ),
    onClose: () => {
      progressUnsubscribe()
      if (running && runId) {
        void api.cancelInspection(runId).catch(() => {})
      }
    }
  })

  diskCheckbox.addEventListener('change', () => {
    diskEnabled = diskCheckbox.checked
    render()
  })

  thresholdInput.addEventListener('change', () => {
    const value = readThreshold()
    onThresholdChange(value)
    render()
  })

  thresholdInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void start()
    }
  })

  render()

  function countResults(): {
    alert: number
    ok: number
    error: number
    skipped: number
    done: number
    total: number
  } {
    const counts = { alert: 0, ok: 0, error: 0, skipped: 0, done: results.size, total: connections.length }
    for (const result of results.values()) counts[result.status] += 1
    return counts
  }

  function render(): void {
    const counts = countResults()
    renderProgress(counts)
    renderSummary(counts)
    renderBanner(counts)
    renderResults()
    updateControls(counts)
  }

  function renderProgress(counts: ReturnType<typeof countResults>): void {
    const visible = running || counts.done > 0
    progressEl.hidden = !visible
    if (!visible) return
    const percent = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0
    progressFill.style.width = `${percent}%`
    progressFill.parentElement?.setAttribute('aria-valuenow', String(percent))
    progressCount.textContent = `${counts.done} / ${counts.total}`
    progressSpinner.hidden = !running
    if (running) progressText.textContent = '正在巡检已配置的连接…'
    else if (aborted) progressText.textContent = '巡检已停止'
    else progressText.textContent = '巡检完成'
  }

  function renderSummary(counts: ReturnType<typeof countResults>): void {
    summaryEl.hidden = counts.done === 0
    if (counts.done === 0) {
      summaryEl.replaceChildren()
      return
    }
    summaryEl.replaceChildren(
      statTile('全部', counts.total, 'all'),
      statTile('告警', counts.alert, 'alert', 'is-alert'),
      statTile('正常', counts.ok, 'ok', 'is-ok'),
      statTile('失败', counts.error, 'error', 'is-error'),
      ...(counts.skipped > 0
        ? [statTile('跳过', counts.skipped, 'skipped', 'is-skipped')]
        : [])
    )
  }

  function statTile(
    label: string,
    value: number,
    target: InspectionFilter,
    tone = ''
  ): HTMLButtonElement {
    return el(
      'button',
      {
        class: `inspection-stat${tone ? ` ${tone}` : ''}${
          filter === target ? ' is-active' : ''
        }`,
        type: 'button',
        'aria-pressed': filter === target ? 'true' : 'false',
        onclick: () => {
          filter = target
          render()
        }
      },
      el('span', { class: 'inspection-stat-value', text: String(value) }),
      el('span', { class: 'inspection-stat-label', text: label })
    )
  }

  function renderBanner(counts: ReturnType<typeof countResults>): void {
    if (counts.done === 0) {
      bannerEl.hidden = true
      return
    }
    const alertResults = [...results.values()].filter((result) => result.status === 'alert')
    if (alertResults.length > 0) {
      const names = alertResults.slice(0, 6).map((result) => result.name).join('、')
      const extra = alertResults.length > 6 ? ` 等 ${alertResults.length} 台` : ''
      bannerEl.hidden = false
      bannerEl.className = 'inspection-banner is-alert'
      bannerEl.replaceChildren(
        el('span', { class: 'inspection-banner-icon', html: icon('warning', 18) }),
        el(
          'div',
          { class: 'inspection-banner-text' },
          el('strong', {
            text: `发现 ${alertResults.length} 台主机磁盘使用率达到 ${threshold}%`
          }),
          el('span', { text: `${names}${extra}` })
        )
      )
      return
    }
    if (running) {
      bannerEl.hidden = true
      return
    }
    const extras: string[] = []
    if (counts.error > 0) extras.push(`${counts.error} 台巡检失败`)
    if (counts.skipped > 0) extras.push(`${counts.skipped} 台跳过`)
    if (aborted) {
      bannerEl.hidden = false
      bannerEl.className = 'inspection-banner is-info'
      bannerEl.replaceChildren(
        el('span', { class: 'inspection-banner-icon', html: icon('info', 18) }),
        el(
          'div',
          { class: 'inspection-banner-text' },
          el('strong', { text: '巡检已停止' }),
          el('span', {
            text: `已完成 ${counts.done}/${counts.total} 个连接${
              extras.length > 0 ? `，${extras.join('，')}` : ''
            }`
          })
        )
      )
      return
    }
    bannerEl.hidden = false
    bannerEl.className = 'inspection-banner is-success'
    bannerEl.replaceChildren(
      el('span', { class: 'inspection-banner-icon', html: icon('check', 18) }),
      el(
        'div',
        { class: 'inspection-banner-text' },
        el('strong', { text: '未发现磁盘空间告警' }),
        el('span', {
          text: extras.length > 0 ? extras.join('，') : `所有挂载点使用率低于 ${threshold}%`
        })
      )
    )
  }

  function renderResults(): void {
    if (results.size === 0 && !running && !finished) {
      resultsEl.replaceChildren(
        el(
          'div',
          { class: 'inspection-empty' },
          el('div', { class: 'inspection-empty-icon', html: icon('shield', 26) }),
          el('strong', { text: '开始巡检已配置的 SSH 连接' }),
          el('span', {
            text: '巡检会为每台主机执行 df 并检查挂载点使用率；已打开的会话直接复用，无需重复输入密码。'
          })
        )
      )
      return
    }

    const rows = connections
      .map((connection, order) => ({ connection, order, result: results.get(connection.id) }))
      .filter(({ result }) => {
        if (filter === 'all') return true
        const status = result?.status ?? 'pending'
        return status === filter
      })
      .sort((left, right) => {
        const leftStatus = left.result?.status ?? 'pending'
        const rightStatus = right.result?.status ?? 'pending'
        return STATUS_ORDER[leftStatus] - STATUS_ORDER[rightStatus] || left.order - right.order
      })

    if (rows.length === 0) {
      resultsEl.replaceChildren(
        el(
          'div',
          { class: 'inspection-empty is-compact' },
          el('div', { class: 'inspection-empty-icon', html: icon('filter', 20) }),
          el('strong', { text: '没有符合筛选条件的连接' })
        )
      )
      return
    }

    resultsEl.replaceChildren(
      ...rows.map(({ connection, result }) => renderConnectionRow(connection, result))
    )
  }

  function renderConnectionRow(
    connection: Connection,
    result: InspectionResult | undefined
  ): HTMLElement {
    const status = result?.status ?? 'pending'
    const row = el('div', { class: `inspection-row is-${status}` })
    const iconName =
      status === 'alert' || status === 'error'
        ? 'warning'
        : status === 'ok'
          ? 'check'
          : status === 'skipped'
            ? 'minus'
            : 'clock'
    const iconBox = el(
      'span',
      { class: 'inspection-row-icon' },
      status === 'pending' && running
        ? el('span', { class: 'mini-spinner' })
        : el('span', { html: icon(iconName, 15) })
    )
    row.append(
      el(
        'div',
        { class: 'inspection-row-main' },
        iconBox,
        el(
          'div',
          { class: 'inspection-row-heading' },
          el(
            'div',
            { class: 'inspection-row-title' },
            el('span', { class: 'inspection-row-name', text: connection.name }),
            result && result.elapsed > 0
              ? el('span', {
                  class: 'inspection-row-elapsed',
                  text: `${(result.elapsed / 1000).toFixed(1)}s`
                })
              : null
          ),
          el('span', {
            class: 'inspection-row-host',
            text: `${connection.username}@${connection.host}:${connection.port} · ${folderPathLabel(
              connection.folderId,
              state.folders
            )}`
          })
        ),
        el('span', {
          class: `inspection-status is-${status}`,
          text: STATUS_LABELS[status]
        })
      )
    )

    let body: HTMLElement | null = null
    if (result?.status === 'alert') {
      body = el(
        'div',
        { class: 'inspection-disks' },
        ...result.alerts.map((disk) => renderDisk(disk, true))
      )
    } else if (result?.status === 'ok') {
      const top = result.disks[0]
      body = el(
        'div',
        { class: 'inspection-disks' },
        top ? renderDisk(top, false) : null,
        el('div', {
          class: 'inspection-row-note',
          text: `共 ${result.disks.length} 个挂载点，使用率均低于 ${threshold}%`
        })
      )
    } else if (result?.status === 'error' || result?.status === 'skipped') {
      body = el('div', { class: 'inspection-row-note', text: result.message })
    } else if (status === 'pending') {
      body = el('div', {
        class: 'inspection-row-note',
        text: running ? '等待巡检…' : aborted ? '未巡检（巡检已停止）' : '等待巡检…'
      })
    }
    if (body) row.append(el('div', { class: 'inspection-row-body' }, body))
    return row
  }

  function renderDisk(disk: InspectionDisk, alert: boolean): HTMLElement {
    return el(
      'div',
      { class: 'inspection-disk' },
      el('span', {
        class: 'inspection-disk-mount',
        title: `${disk.filesystem} · ${disk.mount}`,
        text: disk.mount
      }),
      el(
        'span',
        { class: 'inspection-disk-track' },
        el('span', {
          class: `inspection-disk-fill${alert ? '' : ' is-ok'}`,
          style: { width: `${Math.min(100, Math.max(0, disk.usagePercent))}%` }
        })
      ),
      el('span', {
        class: `inspection-disk-percent${alert ? '' : ' is-ok'}`,
        text: `${formatPercent(disk.usagePercent)}%`
      }),
      el('span', {
        class: 'inspection-disk-size',
        text: `${formatKb(disk.usedKb)} / ${formatKb(disk.sizeKb)}`
      })
    )
  }

  function updateControls(counts: ReturnType<typeof countResults>): void {
    const thresholdChanged = parseThresholdInput() !== threshold
    diskCheckbox.disabled = running
    thresholdInput.disabled = running || !diskEnabled
    startButton.disabled = running || !diskEnabled || connections.length === 0
    startLabel.textContent = finished ? '重新巡检' : '开始巡检'
    startButton.title = !diskEnabled
      ? '请先勾选巡检项目'
      : connections.length === 0
        ? '尚未配置 SSH 连接'
        : running
          ? '巡检正在进行'
          : finished
            ? '按当前阈值重新巡检'
            : '巡检所有已配置的 SSH 连接'
    stopButton.hidden = !running
    stopButton.disabled = stopping
    scopeEl.textContent =
      connections.length === 0
        ? '尚未配置 SSH 连接'
        : `共 ${state.connections.length} 个连接 · ${connections.length} 个 SSH 连接可巡检`
    if (running) {
      footerNote.textContent = '正在巡检，可随时停止'
    } else if (finished && thresholdChanged) {
      footerNote.textContent = '阈值已调整，点击“重新巡检”后生效'
    } else if (finished && aborted) {
      footerNote.textContent = `巡检已停止：已完成 ${counts.done}/${counts.total} 个连接`
    } else if (finished) {
      const seconds = Math.max(0.1, (Date.now() - runStartedAt) / 1000)
      const alertNote = counts.alert > 0 ? `，${counts.alert} 台告警` : ''
      footerNote.textContent = `已完成 ${counts.done}/${counts.total} 个连接${alertNote} · 用时 ${seconds.toFixed(
        1
      )}s`
    } else {
      footerNote.textContent = connections.length
        ? '巡检会复用已打开的会话'
        : '配置 SSH 连接后即可巡检'
    }
  }

  function parseThresholdInput(): number | null {
    const value = Number(thresholdInput.value)
    if (!Number.isFinite(value)) return null
    return Math.min(100, Math.max(1, Math.round(value)))
  }

  function readThreshold(): number {
    const value = parseThresholdInput() ?? threshold
    thresholdInput.value = String(value)
    return value
  }

  function onProgress(event: InspectionProgressEvent): void {
    if (!runId || event.runId !== runId) return
    results.set(event.result.connectionId, event.result)
    render()
  }

  function applySummary(summary: InspectionSummary): void {
    for (const result of summary.results) results.set(result.connectionId, result)
    threshold = clampThreshold(summary.threshold)
    aborted = summary.aborted
    finished = true
  }

  async function start(): Promise<void> {
    if (running || !diskEnabled || connections.length === 0) return
    const value = readThreshold()
    threshold = value
    onThresholdChange(value)
    errorEl.hidden = true
    errorEl.replaceChildren()
    results.clear()
    filter = 'all'
    running = true
    stopping = false
    finished = false
    aborted = false
    runStartedAt = Date.now()
    runId = uid()
    render()
    try {
      const summary = await api.runInspection({
        runId,
        threshold: value,
        connectionIds: connections.map((connection) => connection.id)
      })
      if (summary.runId !== runId) return
      applySummary(summary)
    } catch (error) {
      errorEl.hidden = false
      errorEl.replaceChildren(
        el('span', { html: icon('warning', 15) }),
        el('span', { text: errorMessage(error) })
      )
    } finally {
      running = false
      stopping = false
      runId = ''
      render()
    }
  }

  async function stop(): Promise<void> {
    if (!running || stopping) return
    stopping = true
    render()
    try {
      await api.cancelInspection(runId)
    } catch {
      // The run may have finished between the click and the IPC call.
    }
  }
}

function clampThreshold(value: number): number {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return 90
  return Math.min(100, Math.max(1, number))
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatKb(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return '0'
  const gb = kb / 1024 / 1024
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`
  if (gb >= 100) return `${Math.round(gb)} GB`
  if (gb >= 10) return `${gb.toFixed(1)} GB`
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${Math.max(1, Math.round(kb / 1024))} MB`
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
