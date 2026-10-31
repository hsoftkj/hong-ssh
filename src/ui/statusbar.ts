import type { AppState } from '../types'
import type { TerminalSession } from '../terminal/session'
import { el } from './dom'
import { icon } from './icons'

interface StatusBarOptions {
  onZoomOut: () => void
  onZoomIn: () => void
}

export class StatusBar {
  readonly element: HTMLElement
  private readonly dot: HTMLElement
  private readonly primary: HTMLElement
  private readonly middle: HTMLElement
  private readonly size: HTMLElement
  private readonly sessions: HTMLElement
  private readonly security: HTMLElement
  private readonly zoomLabel: HTMLElement
  private state: AppState

  constructor(state: AppState, options: StatusBarOptions) {
    this.state = state
    this.dot = el('span', { class: 'status-dot' })
    this.primary = el('span', { class: 'status-primary', text: '未连接' })
    this.middle = el('span', { class: 'status-middle', text: 'xterm-256color · UTF-8' })
    this.size = el('span', { class: 'status-metric', title: '终端行列数' })
    this.sessions = el('span', { class: 'status-metric', title: '打开的会话数' })
    this.security = el('span', { class: 'status-metric status-security', title: '密码存储状态' })
    this.zoomLabel = el('span', { class: 'status-zoom-label', title: '当前字号' })
    const zoomOut = el(
      'button',
      {
        class: 'status-zoom-button',
        type: 'button',
        title: '缩小字体 (Ctrl+-)',
        'aria-label': '缩小字体',
        html: icon('zoomOut', 13),
        onclick: options.onZoomOut
      },
      null
    )
    const zoomIn = el(
      'button',
      {
        class: 'status-zoom-button',
        type: 'button',
        title: '放大字体 (Ctrl+=)',
        'aria-label': '放大字体',
        html: icon('zoomIn', 13),
        onclick: options.onZoomIn
      },
      null
    )
    this.element = el(
      'footer',
      { class: 'statusbar', role: 'status' },
      el(
        'div',
        { class: 'status-left' },
        this.dot,
        this.primary,
        el('span', { class: 'status-separator' }),
        this.middle
      ),
      el(
        'div',
        { class: 'status-right' },
        this.security,
        this.size,
        this.sessions,
        el(
          'div',
          { class: 'status-zoom', role: 'group', 'aria-label': '字体缩放' },
          zoomOut,
          this.zoomLabel,
          zoomIn
        )
      )
    )
    this.setSessions(0)
    this.setZoomLabel()
  }

  update(active: TerminalSession | null, sessionCount: number): void {
    if (!active) {
      this.dot.className = 'status-dot is-idle'
      this.primary.textContent = '未连接'
      this.middle.textContent = '就绪'
      this.size.textContent = '—'
    } else {
      const status = active.getStatus()
      const connection = active.connection
      if (status === 'connected') {
        this.dot.className = 'status-dot is-connected'
        this.primary.textContent = `${connection.name} · ${connection.username}@${connection.host}:${connection.port}`
        this.middle.textContent = `${connection.terminalType || 'xterm-256color'} · UTF-8`
      } else if (status === 'error') {
        this.dot.className = 'status-dot is-error'
        this.primary.textContent = `${connection.name} · 连接失败`
        this.middle.textContent = '请查看终端中的错误信息'
      } else if (status === 'disconnected') {
        this.dot.className = 'status-dot is-idle'
        this.primary.textContent = `${connection.name} · 已断开`
        this.middle.textContent = '可重新连接'
      } else {
        this.dot.className = 'status-dot is-connecting'
        this.primary.textContent = `${connection.name} · 正在连接`
        this.middle.textContent = `${connection.username}@${connection.host}:${connection.port}`
      }
      const term = active.getTerminal()
      this.size.textContent = `${term.cols} × ${term.rows}`
      this.size.title = `终端大小 ${term.cols} 列 × ${term.rows} 行`
    }
    this.setSessions(sessionCount)
    this.setZoomLabel()
    this.security.innerHTML = `${icon(this.state.secretsEncrypted ? 'shield' : 'warning', 12)}<span>${
      this.state.secretsEncrypted ? 'DPAPI' : '无凭据存储'
    }</span>`
  }

  setSessions(count: number): void {
    this.sessions.textContent = `${count} 个会话`
  }

  setTerminalSize(cols: number, rows: number): void {
    this.size.textContent = `${cols} × ${rows}`
  }

  setState(state: AppState): void {
    this.state = state
    this.setZoomLabel()
  }

  private setZoomLabel(): void {
    this.zoomLabel.textContent = `${this.state.settings.fontSize}px`
  }

  setMiddle(text: string): void {
    this.middle.textContent = text
  }
}
