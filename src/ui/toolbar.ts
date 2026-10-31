import type { AppState } from '../types'
import type { TerminalSession } from '../terminal/session'
import { el } from './dom'
import { icon } from './icons'
import { isDarkAppTheme } from '../ui-themes'

const QUICK_COMMANDS: Array<{ command: string; label: string; description: string }> = [
  { command: 'top -d 1', label: 'top', description: '每 1 秒刷新进程与负载' },
  { command: 'htop', label: 'htop', description: '彩色交互式进程管理器' },
  { command: 'df -h', label: 'df -h', description: '磁盘空间使用情况' },
  { command: 'free -m', label: 'free -m', description: '内存使用情况（MB）' },
  { command: 'ps aux --sort=-%cpu | head -20', label: 'ps top', description: 'CPU 占用最高的进程' },
  { command: 'vi /etc/hosts', label: 'vi hosts', description: '用 vi 编辑 hosts 文件' },
  { command: 'tail -f', label: 'tail -f', description: '实时查看系统日志' },
  { command: 'clear', label: 'clear', description: '清空屏幕' }
]

const FONT_SIZES: Array<{ label: string; size: number }> = [
  { label: '小', size: 14 },
  { label: '中', size: 16 },
  { label: '大', size: 18 }
]

interface ToolbarOptions {
  onNewConnection: () => void
  onNewGroup: () => void
  onImport: () => void
  onExport: () => void
  onReconnect: () => void
  onDisconnect: () => void
  onCopy: () => void
  onPaste: () => void
  onFind: () => void
  onClear: () => void
  onInspection: () => void
  onToggleFiles: () => void
  onQuickCommand: (command: string) => void
  onFontSize: (size: number) => void
  onSettings: () => void
  onToggleTheme: () => void
  onToggleRecording: () => void
  onScreenshot: () => void
  onToggleSidebar: () => void
}

export class Toolbar {
  readonly element: HTMLElement
  private readonly reconnectButton: HTMLButtonElement
  private readonly disconnectButton: HTMLButtonElement
  private readonly copyButton: HTMLButtonElement
  private readonly pasteButton: HTMLButtonElement
  private readonly findButton: HTMLButtonElement
  private readonly clearButton: HTMLButtonElement
  private readonly filesButton: HTMLButtonElement
  private readonly quickButton: HTMLButtonElement
  private readonly quickWrap: HTMLElement
  private readonly quickMenu: HTMLElement
  private readonly quickItems: HTMLButtonElement[] = []
  private readonly fontButton: HTMLButtonElement
  private readonly fontWrap: HTMLElement
  private readonly fontMenu: HTMLElement
  private readonly fontItems: HTMLButtonElement[] = []
  private readonly recordButton: HTMLButtonElement
  private readonly themeButton: HTMLButtonElement
  private readonly sidebarButton: HTMLButtonElement
  private readonly connectionStatus: HTMLElement
  private readonly connectionStatusLabel: HTMLElement
  private readonly sessionBadge: HTMLElement

  constructor(options: ToolbarOptions) {
    this.element = el('header', { class: 'toolbar', role: 'toolbar', 'aria-label': '会话工具栏' })

    const newButton = this.toolbarButton('新建连接', 'plus', 'Ctrl+N', options.onNewConnection, true)
    const newGroupButton = this.toolbarButton('新建分组', 'folder', '', options.onNewGroup)
    const importButton = this.toolbarButton('导入配置', 'import', '', options.onImport)
    const exportButton = this.toolbarButton('导出配置', 'upload', '', options.onExport)
    this.reconnectButton = this.toolbarButton('重新连接', 'refresh', 'Ctrl+R', options.onReconnect)
    this.disconnectButton = this.toolbarButton('断开连接', 'unplug', '', options.onDisconnect)
    this.copyButton = this.toolbarButton('复制', 'copy', 'Ctrl+Shift+C', options.onCopy)
    this.pasteButton = this.toolbarButton('粘贴', 'clipboard', 'Ctrl+Shift+V', options.onPaste)
    this.findButton = this.toolbarButton('查找', 'search', 'Ctrl+F', options.onFind)
    this.clearButton = this.toolbarButton('清屏', 'eraser', '', options.onClear)
    const inspectionButton = this.toolbarButton(
      '主机巡检',
      'shield',
      '',
      options.onInspection
    )
    inspectionButton.classList.add('toolbar-inspection-button')
    this.filesButton = this.toolbarButton(
      '文件传输',
      'folderOpen',
      'Ctrl+Shift+E',
      options.onToggleFiles
    )
    this.quickButton = this.toolbarButton('快捷命令', 'command', '', () => this.toggleQuickMenu())
    this.quickButton.classList.add('toolbar-quick-button')
    this.quickButton.setAttribute('aria-haspopup', 'menu')
    this.quickButton.setAttribute('aria-expanded', 'false')
    this.quickButton.insertAdjacentHTML(
      'beforeend',
      `<span class="toolbar-quick-chevron">${icon('chevronDown', 10)}</span>`
    )
    this.quickMenu = el(
      'div',
      { class: 'toolbar-quick-menu', role: 'menu', 'aria-label': '快捷命令', hidden: true },
      el(
        'div',
        { class: 'quick-commands-header' },
        el('span', { class: 'quick-commands-title', html: `${icon('command', 14)}<span>快捷命令</span>` }),
        el('span', { class: 'quick-commands-hint', text: '点击发送到当前会话' })
      ),
      el('div', { class: 'quick-commands-list' })
    )
    const quickList = this.quickMenu.querySelector('.quick-commands-list') as HTMLElement
    for (const item of QUICK_COMMANDS) {
      const button = el(
        'button',
        {
          class: 'quick-command',
          type: 'button',
          role: 'menuitem',
          title: `${item.description}\n发送：${item.command}`,
          disabled: true
        },
        el('code', { class: 'quick-command-code', text: item.label }),
        el('span', { class: 'quick-command-desc', text: item.description })
      )
      button.addEventListener('click', () => {
        if (button.disabled) return
        this.closeQuickMenu()
        options.onQuickCommand(item.command)
      })
      this.quickItems.push(button)
      quickList.appendChild(button)
    }
    this.quickWrap = el('div', { class: 'toolbar-quick-wrap' }, this.quickButton, this.quickMenu)
    this.quickWrap.hidden = true

    document.addEventListener('mousedown', (event) => {
      if (this.quickMenu.hidden) return
      if (this.quickWrap.contains(event.target as Node)) return
      this.closeQuickMenu()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.quickMenu.hidden) {
        this.closeQuickMenu()
        this.quickButton.focus()
      }
    })

    this.fontButton = el(
      'button',
      {
        class: 'toolbar-button toolbar-font-button',
        type: 'button',
        title: '字体大小',
        'aria-label': '字体大小',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        html: `<span class="toolbar-font-a">A</span><span class="toolbar-font-chevron">${icon('chevronDown', 10)}</span>`
      },
      null
    )
    this.fontButton.addEventListener('click', () => this.toggleFontMenu())
    this.fontMenu = el('div', {
      class: 'toolbar-font-menu',
      role: 'menu',
      'aria-label': '字体大小',
      hidden: true
    })
    for (const preset of FONT_SIZES) {
      const item = el(
        'button',
        {
          class: 'toolbar-font-item',
          type: 'button',
          role: 'menuitemradio',
          'data-size': String(preset.size),
          'aria-checked': 'false'
        },
        el('span', { class: 'toolbar-font-label', text: preset.label }),
        el('span', { class: 'toolbar-font-px', text: `${preset.size}px` })
      )
      item.addEventListener('click', () => {
        this.closeFontMenu()
        options.onFontSize(preset.size)
      })
      this.fontItems.push(item)
      this.fontMenu.appendChild(item)
    }
    this.fontWrap = el('div', { class: 'toolbar-font-wrap' }, this.fontButton, this.fontMenu)
    document.addEventListener('mousedown', (event) => {
      if (this.fontMenu.hidden) return
      if (this.fontWrap.contains(event.target as Node)) return
      this.closeFontMenu()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.fontMenu.hidden) {
        this.closeFontMenu()
        this.fontButton.focus()
      }
    })

    this.themeButton = this.toolbarButton('切换深色模式', 'moon', '', options.onToggleTheme)
    this.recordButton = this.toolbarButton('区域录屏', 'record', '', options.onToggleRecording)
    this.recordButton.classList.add('toolbar-record-button')
    const screenshotButton = this.toolbarButton(
      '框选截图',
      'camera',
      'Ctrl+Shift+X',
      options.onScreenshot
    )
    screenshotButton.classList.add('toolbar-screenshot-button')
    const settingsButton = this.toolbarButton('设置', 'settings', 'Ctrl+,', options.onSettings)
    this.sidebarButton = this.toolbarButton(
      '显示/隐藏连接面板',
      'layout',
      'Ctrl+B',
      options.onToggleSidebar
    )
    this.connectionStatusLabel = el('span', { class: 'toolbar-status-label', text: '未连接' })
    this.connectionStatus = el(
      'span',
      {
        class: 'toolbar-status is-idle',
        role: 'status',
        'aria-live': 'polite',
        title: '当前会话状态：未连接'
      },
      el('span', { class: 'toolbar-status-dot' }),
      this.connectionStatusLabel
    )
    this.sessionBadge = el('span', { class: 'toolbar-session-badge', title: '当前打开的会话数' })

    this.element.append(
      el('div', { class: 'toolbar-group' }, newButton, newGroupButton, importButton, exportButton, this.sidebarButton),
      el('span', { class: 'toolbar-separator' }),
      el('div', { class: 'toolbar-group' }, this.reconnectButton, this.disconnectButton),
      el('span', { class: 'toolbar-separator' }),
      el(
        'div',
        { class: 'toolbar-group' },
        this.copyButton,
        this.pasteButton,
        this.findButton,
        this.clearButton,
        this.quickWrap,
        inspectionButton,
        this.filesButton
      ),
      el('span', { class: 'toolbar-spacer' }),
      el('span', { class: 'toolbar-separator' }),
      el(
        'div',
        { class: 'toolbar-group' },
        screenshotButton,
        this.recordButton,
        this.fontWrap,
        this.themeButton,
        settingsButton,
        this.connectionStatus,
        this.sessionBadge
      )
    )
  }

  private toolbarButton(
    title: string,
    iconName: string,
    shortcut: string,
    onClick: () => void,
    primary = false
  ): HTMLButtonElement {
    return el(
      'button',
      {
        class: `toolbar-button${primary ? ' is-primary' : ''}`,
        type: 'button',
        title: shortcut ? `${title} (${shortcut})` : title,
        'aria-label': title,
        html: icon(iconName, 17),
        onclick: onClick
      },
      null
    )
  }

  update(state: AppState, active: TerminalSession | null, sessionCount: number): void {
    const hasSession = active !== null
    const status = active?.getStatus() ?? 'disconnected'
    this.reconnectButton.disabled = !hasSession || status === 'connecting' || status === 'reconnecting'
    this.disconnectButton.disabled =
      !hasSession || status === 'disconnected' || status === 'error'
    this.copyButton.disabled = !hasSession
    this.pasteButton.disabled = !hasSession
    this.findButton.disabled = !hasSession
    this.clearButton.disabled = !hasSession
    this.themeButton.innerHTML = icon(isDarkAppTheme(state.settings.theme) ? 'sun' : 'moon', 17)
    this.themeButton.title = isDarkAppTheme(state.settings.theme) ? '切换浅色模式' : '切换深色模式'
    this.themeButton.classList.toggle('is-active', isDarkAppTheme(state.settings.theme))
    this.themeButton.setAttribute('aria-pressed', String(isDarkAppTheme(state.settings.theme)))
    this.sidebarButton.classList.toggle('is-active', state.settings.sidebarVisible)
    this.sidebarButton.setAttribute('aria-pressed', String(state.settings.sidebarVisible))
    this.sessionBadge.textContent = String(sessionCount)
    this.sessionBadge.hidden = sessionCount === 0
    this.sessionBadge.title = `当前打开 ${sessionCount} 个会话`
    const fontSize = state.settings.fontSize
    const fontPreset = FONT_SIZES.find((preset) => preset.size === fontSize)
    for (const item of this.fontItems) {
      const active = Number(item.dataset.size) === fontSize
      item.classList.toggle('is-active', active)
      item.setAttribute('aria-checked', String(active))
    }
    this.fontButton.title = fontPreset
      ? `字体大小：${fontPreset.label}（${fontSize}px）`
      : `字体大小：${fontSize}px（自定义）`
    this.fontButton.setAttribute('aria-label', this.fontButton.title)
    this.updateConnectionStatus(hasSession, status)
    const quickEnabled = hasSession && status === 'connected'
    this.quickWrap.hidden = !state.settings.showQuickCommands
    this.quickButton.disabled = !quickEnabled
    this.quickButton.title = quickEnabled ? '快捷命令' : '快捷命令（连接会话后可用）'
    for (const item of this.quickItems) item.disabled = !quickEnabled
    if (!quickEnabled || !state.settings.showQuickCommands) this.closeQuickMenu()
  }

  setFilesActive(active: boolean): void {
    this.filesButton.classList.toggle('is-active', active)
    this.filesButton.setAttribute('aria-pressed', String(active))
  }

  setRecording(active: boolean): void {
    this.recordButton.classList.toggle('is-recording', active)
    this.recordButton.setAttribute('aria-pressed', String(active))
    this.recordButton.title = active ? '停止区域录屏' : '区域录屏'
    this.recordButton.setAttribute('aria-label', this.recordButton.title)
  }

  private toggleQuickMenu(): void {
    if (this.quickButton.disabled) return
    if (this.quickMenu.hidden) this.openQuickMenu()
    else this.closeQuickMenu()
  }

  private toggleFontMenu(): void {
    if (this.fontMenu.hidden) this.openFontMenu()
    else this.closeFontMenu()
  }

  private openFontMenu(): void {
    this.closeQuickMenu()
    this.fontMenu.hidden = false
    this.fontButton.classList.add('is-active')
    this.fontButton.setAttribute('aria-expanded', 'true')
  }

  private closeFontMenu(): void {
    if (this.fontMenu.hidden) return
    this.fontMenu.hidden = true
    this.fontButton.classList.remove('is-active')
    this.fontButton.setAttribute('aria-expanded', 'false')
  }

  private openQuickMenu(): void {
    this.closeFontMenu()
    this.quickMenu.hidden = false
    this.quickButton.classList.add('is-active')
    this.quickButton.setAttribute('aria-expanded', 'true')
  }

  private closeQuickMenu(): void {
    if (this.quickMenu.hidden) return
    this.quickMenu.hidden = true
    this.quickButton.classList.remove('is-active')
    this.quickButton.setAttribute('aria-expanded', 'false')
  }

  private updateConnectionStatus(hasSession: boolean, status: string): void {
    let label = '未连接'
    let state = 'idle'
    if (hasSession) {
      switch (status) {
        case 'connected':
          label = '已连接'
          state = 'online'
          break
        case 'connecting':
        case 'opening-shell':
          label = '连接中'
          state = 'pending'
          break
        case 'reconnecting':
          label = '重连中'
          state = 'pending'
          break
        case 'error':
          label = '异常'
          state = 'error'
          break
        default:
          label = '离线'
          state = 'idle'
      }
    }
    this.connectionStatus.classList.remove('is-idle', 'is-pending', 'is-online', 'is-error')
    this.connectionStatus.classList.add(`is-${state}`)
    this.connectionStatus.dataset.state = state
    this.connectionStatus.title = `当前会话状态：${label}`
    this.connectionStatusLabel.textContent = label
  }
}
