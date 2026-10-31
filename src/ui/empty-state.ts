import type { AppState, Connection } from '../types'
import { el } from './dom'
import { icon, logo } from './icons'
import { formatRelativeTime } from './dom'

interface EmptyStateOptions {
  onNewConnection: () => void
  onImport: () => void
  onOpenConnection: (connection: Connection) => void
}

export class EmptyState {
  readonly element: HTMLElement
  private readonly options: EmptyStateOptions
  private readonly recentSection: HTMLElement
  private readonly recentGrid: HTMLElement

  constructor(options: EmptyStateOptions) {
    this.options = options
    this.recentGrid = el('div', { class: 'empty-recent-grid' })
    this.recentSection = el(
      'section',
      { class: 'empty-recent' },
      el(
        'header',
        { class: 'empty-section-header' },
        el('span', { class: 'empty-section-title', text: '最近连接' }),
        el('span', { class: 'empty-section-hint', text: '双击左侧连接也可以打开会话' })
      ),
      this.recentGrid
    )

    const hero = el(
      'div',
      { class: 'empty-hero' },
      el('div', { class: 'empty-logo', html: logo(64) }),
      el('h1', { class: 'empty-title', text: '开始一个 SSH 会话' }),
      el('p', {
        class: 'empty-subtitle',
        text: '连接远端服务器，完整支持 top、vi、htop、less 等交互式程序，并按服务器实际输出显示 ANSI / 256 / TrueColor 颜色。'
      }),
      el(
        'div',
        { class: 'empty-actions' },
        el(
          'button',
          {
            class: 'btn btn-primary btn-lg',
            type: 'button',
            html: `${icon('plus', 17)}<span>新建连接</span>`,
            onclick: () => this.options.onNewConnection()
          },
          null
        ),
        el(
          'button',
          {
            class: 'btn btn-ghost btn-lg',
            type: 'button',
            html: `${icon('import', 17)}<span>导入配置</span>`,
            onclick: () => this.options.onImport()
          },
          null
        )
      ),
      el(
        'div',
        { class: 'empty-tips' },
        tipCard('terminal', '完整终端', 'PTY + xterm-256color，top、vi 等全屏程序可正常交互。'),
        tipCard('palette', '真实配色', '保留服务器设置的 16 色、256 色和 TrueColor 输出。'),
        tipCard('shield', '安全存储', '密码通过系统 DPAPI 加密，主机指纹变化时自动阻止连接。')
      )
    )

    this.element = el('div', { class: 'empty-state' }, hero, this.recentSection)
  }

  render(state: AppState): void {
    const recent = [...state.connections]
      .sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0))
      .slice(0, 6)
    this.recentSection.hidden = state.connections.length === 0
    this.recentGrid.replaceChildren()
    for (const connection of recent) {
      const card = el(
        'button',
        {
          class: 'recent-card',
          type: 'button',
          title: `${connection.username}@${connection.host}:${connection.port}`
        },
        el('span', {
          class: 'recent-card-icon',
          style: { color: connection.color },
          html: icon('terminal', 18)
        }),
        el(
          'span',
          { class: 'recent-card-main' },
          el('span', { class: 'recent-card-name', text: connection.name }),
          el('span', {
            class: 'recent-card-host',
            text: `${connection.username}@${connection.host}:${connection.port}`
          })
        ),
        el('span', {
          class: 'recent-card-time',
          text: connection.lastConnectedAt ? formatRelativeTime(connection.lastConnectedAt) : '未连接'
        })
      )
      card.addEventListener('click', () => this.options.onOpenConnection(connection))
      this.recentGrid.appendChild(card)
    }
  }
}

function tipCard(iconName: string, title: string, description: string): HTMLElement {
  return el(
    'div',
    { class: 'empty-tip' },
    el('span', { class: 'empty-tip-icon', html: icon(iconName, 18) }),
    el(
      'span',
      { class: 'empty-tip-text' },
      el('strong', { text: title }),
      el('span', { text: description })
    )
  )
}
