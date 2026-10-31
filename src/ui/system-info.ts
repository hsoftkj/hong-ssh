import type { TerminalSession } from '../terminal/session'
import { el } from './dom'
import { icon } from './icons'

export class SystemInfoBar {
  readonly element: HTMLElement

  constructor() {
    this.element = el('div', { class: 'system-info-bar', hidden: true, 'aria-label': '系统信息' })
  }

  update(session: TerminalSession | null): void {
    if (!session || !session.isConnected()) {
      this.element.hidden = true
      this.element.replaceChildren()
      return
    }
    const connection = session.connection
    const info = session.systemInfo
    const stats = session.systemStats
    const items: HTMLElement[] = []
    const item = (label: string, value: string, className = '', title = '') =>
      el(
        'span',
        { class: `system-info-item ${className}`.trim(), title: title || value },
        el('span', { class: 'system-info-label', text: label }),
        el('span', { class: 'system-info-value', text: value })
      )

    const cpuCount = info?.cpuCount ?? 0
    if (stats?.cpuPercent != null) {
      const percent = Math.round(stats.cpuPercent)
      items.push(
        item(
          'CPU',
          `${percent}%${cpuCount ? ` · ${cpuCount} 核` : ''}`,
          'is-cpu',
          `CPU 使用率 ${percent}%${cpuCount ? ` · ${cpuCount} 核` : ''}`
        )
      )
    } else if (cpuCount) {
      items.push(item('CPU', `${cpuCount} 核`, 'is-cpu'))
    }

    const memoryTotal = stats?.memoryTotal || info?.memoryTotal || 0
    const memoryUsed = stats?.memoryUsed ?? info?.memoryUsed ?? 0
    if (memoryTotal > 0) {
      const totalGb = memoryTotal / 1024
      const usedGb = memoryUsed / 1024
      const percent = stats?.memoryPercent
      const detail = `${usedGb.toFixed(usedGb >= 10 ? 0 : 1)}/${totalGb.toFixed(
        totalGb >= 10 ? 0 : 1
      )} GB`
      items.push(
        item(
          '内存',
          percent != null ? `${Math.round(percent)}% · ${detail}` : detail,
          'is-memory',
          percent != null ? `内存使用率 ${Math.round(percent)}% · ${detail}` : `内存 ${detail}`
        )
      )
    }

    items.push(
      item(
        'IP',
        `${info?.ip || connection.host}:${connection.port}`,
        'is-ip',
        `${connection.username}@${info?.ip || connection.host}:${connection.port}`
      )
    )
    items.push(
      item(
        '系统',
        info?.osName || '正在获取系统信息…',
        info?.osName && !info.osName.startsWith('正在获取') ? '' : 'is-loading',
        info?.osName || '正在通过 SSH exec 获取远端系统信息'
      )
    )
    if (info?.hostname) items.push(item('主机', info.hostname, 'is-host'))
    if (info?.kernel) items.push(item('内核', info.kernel, 'is-kernel'))
    if (info?.uptime) items.push(item('运行', info.uptime, 'is-uptime'))

    this.element.replaceChildren(
      el('span', { class: 'system-info-icon', html: icon('server', 13) }),
      ...items
    )
    this.element.hidden = false
  }
}
