import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'

import type {
  Connection,
  HongSshApi,
  SessionStatus,
  Settings,
  SshClosedEvent,
  SshStatusEvent,
  SystemInfo,
  SystemStats
} from '../types'
import { DEFAULT_FONT_FAMILY, TERMINAL_THEMES } from './themes'
import { el, clear, uid } from '../ui/dom'
import { icon } from '../ui/icons'
import { showContextMenu } from '../ui/context-menu'

interface OverlayAction {
  label: string
  primary?: boolean
  action: () => void
}

interface SessionCallbacks {
  onStatusChange: (session: TerminalSession, status: SshStatusEvent) => void
  onTitleChange: (session: TerminalSession, title: string) => void
  onResize: (session: TerminalSession) => void
  onRequestClose: (session: TerminalSession) => void
  onRequestEdit: (session: TerminalSession) => void
  onToast: (message: string, kind?: 'info' | 'error' | 'success' | 'warning') => void
}

interface SessionOptions {
  api: HongSshApi
  connection: Connection
  settings: Settings
  callbacks: SessionCallbacks
  getSettings: () => Settings
}

const SEARCH_OPTIONS: ISearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  decorations: {
    matchBackground: '#4d3f00',
    matchBorder: '#e5c07b',
    matchOverviewRuler: '#e5c07b',
    activeMatchBackground: '#f5c542',
    activeMatchColorOverviewRuler: '#ff9f1a'
  }
}

let sessionCounter = 0

export class TerminalSession {
  readonly id: string
  readonly connection: Connection
  readonly element: HTMLElement
  readonly surface: HTMLElement
  systemInfo: SystemInfo | null = null
  systemStats: SystemStats | null = null

  private readonly api: HongSshApi
  private readonly callbacks: SessionCallbacks
  private readonly getSettings: () => Settings
  private settings: Settings
  private term!: Terminal
  private fitAddon!: FitAddon
  private searchAddon!: SearchAddon
  private resizeObserver: ResizeObserver | null = null
  private searchBar!: HTMLElement
  private searchInput!: HTMLInputElement
  private searchCount!: HTMLElement
  private overlay!: HTMLElement
  private overlayBody!: HTMLElement
  private statusValue: SessionStatus = 'connecting'
  private connected = false
  private disposed = false
  private active = false
  private opening = false
  private remoteTitle = ''
  private fitScheduled = false
  private intentionalDisconnect = false
  private lastStatusEvent: SshStatusEvent | null = null
  private multilineRun = 0

  constructor(options: SessionOptions) {
    this.api = options.api
    this.connection = options.connection
    this.settings = options.settings
    this.callbacks = options.callbacks
    this.getSettings = options.getSettings
    this.id = `s${Date.now().toString(36)}-${(sessionCounter += 1).toString(36)}-${uid().slice(0, 8)}`

    this.element = el('section', {
      class: 'session-pane',
      'data-session-id': this.id,
      'aria-label': `终端 ${this.connection.name}`
    })
    this.surface = el('div', { class: 'terminal-surface' })
    this.overlay = el('div', { class: 'session-overlay', hidden: true })
    this.overlayBody = el('div', { class: 'session-overlay-body' })
    this.overlay.appendChild(this.overlayBody)

    this.buildSearchBar()
    this.element.append(this.surface, this.searchBar, this.overlay)
    this.createTerminal()
    this.bindTerminalEvents()
    this.bindDomEvents()
    this.showConnecting()
  }

  private createTerminal(): void {
    this.term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: this.settings.cursorBlink,
      cursorStyle: this.settings.cursorStyle,
      drawBoldTextInBrightColors: true,
      fontFamily: this.settings.fontFamily || DEFAULT_FONT_FAMILY,
      fontSize: this.settings.fontSize,
      fontWeight: '400',
      fontWeightBold: '700',
      letterSpacing: this.settings.letterSpacing,
      lineHeight: Math.max(1, Math.min(2.2, this.settings.lineHeight)),
      minimumContrastRatio: 1,
      scrollback: this.settings.scrollback,
      scrollOnUserInput: true,
      tabStopWidth: 8,
      theme: TERMINAL_THEMES[this.settings.terminalTheme].theme,
      windowsPty: undefined
    })

    this.fitAddon = new FitAddon()
    this.searchAddon = new SearchAddon()
    const unicode = new Unicode11Addon()
    const webLinks = new WebLinksAddon((event, uri) => {
      event.preventDefault()
      void this.api.openExternal(uri)
    })

    this.term.loadAddon(this.fitAddon)
    this.term.loadAddon(this.searchAddon)
    this.term.loadAddon(unicode)
    this.term.loadAddon(webLinks)
    this.term.unicode.activeVersion = '11'
    this.term.open(this.surface)

    this.searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      this.searchCount.textContent = resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : '0/0'
      this.searchCount.classList.toggle('is-empty', resultCount === 0)
    })

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit())
    this.resizeObserver.observe(this.surface)
    void document.fonts?.ready?.then(() => this.scheduleFit())
  }

  private bindTerminalEvents(): void {
    this.term.onData((data) => {
      if (this.disposed) return
      void this.api.writeSession(this.id, data)
    })

    this.term.onResize(({ cols, rows }) => {
      if (this.disposed) return
      void this.api.resizeSession(this.id, cols, rows)
      this.callbacks.onResize(this)
    })

    this.term.onTitleChange((title) => {
      const clean = title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
      this.remoteTitle = clean
      this.callbacks.onTitleChange(this, clean)
    })

    this.term.onBell(() => {
      if (!this.getSettings().bell) return
      this.element.classList.add('bell-flash')
      window.setTimeout(() => this.element.classList.remove('bell-flash'), 220)
    })

    this.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const ctrl = event.ctrlKey || event.metaKey
      if (ctrl && event.shiftKey && event.code === 'KeyC') {
        this.copySelection()
        return false
      }
      if (ctrl && event.shiftKey && event.code === 'KeyV') {
        this.paste()
        return false
      }
      if (ctrl && event.code === 'KeyF' && !event.shiftKey && !event.altKey) {
        this.openSearch()
        return false
      }
      if (ctrl && event.shiftKey && event.code === 'KeyA') {
        this.term.selectAll()
        return false
      }
      if (event.ctrlKey && event.code === 'Insert') {
        this.copySelection()
        return false
      }
      if (event.shiftKey && event.code === 'Insert') {
        this.paste()
        return false
      }
      return true
    })
  }

  private bindDomEvents(): void {
    window.addEventListener('contextmenu', this.onContextMenu, true)

    this.surface.addEventListener('mouseup', () => {
      if (!this.getSettings().copyOnSelect) return
      const selection = this.term.getSelection()
      if (selection) this.api.clipboardWrite(selection)
    })
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    if (!target || !this.element.contains(target)) return
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    event.preventDefault()
    event.stopPropagation()
    const rightClick = this.getSettings().rightClick
    if (rightClick === 'nothing') return
    if (rightClick === 'paste') {
      this.paste()
      return
    }
    this.showTerminalContextMenu(event.clientX, event.clientY)
  }

  private showTerminalContextMenu(x: number, y: number): void {
    const hasSelection = this.term.hasSelection()
    const clipboardText = this.api.clipboardRead()
    showContextMenu(
      [
        {
          label: '复制当前选择的内容',
          icon: 'copy',
          shortcut: 'Ctrl+Shift+C',
          disabled: !hasSelection,
          action: () => this.copySelection()
        },
        {
          label: '复制并粘贴到光标位置',
          icon: 'clipboard',
          disabled: !hasSelection,
          action: () => this.copyAndPasteSelection()
        },
        {
          label: '粘贴多行指令',
          icon: 'clipboard',
          shortcut: 'Ctrl+Shift+V',
          disabled: !clipboardText,
          action: () => this.pasteMultiline()
        },
        { separator: true },
        { label: '全选', icon: 'check', shortcut: 'Ctrl+Shift+A', action: () => this.term.selectAll() },
        { label: '查找', icon: 'search', shortcut: 'Ctrl+F', action: () => this.openSearch() },
        { label: '清屏', icon: 'eraser', action: () => this.clear() },
        {
          label: '滚动到底部',
          icon: 'chevronDown',
          action: () => this.term.scrollToBottom()
        }
      ],
      x,
      y
    )
  }

  private buildSearchBar(): void {
    this.searchInput = el('input', {
      class: 'search-input',
      type: 'text',
      placeholder: '在终端中查找…',
      spellcheck: false,
      'aria-label': '在终端中查找'
    })
    this.searchCount = el('span', { class: 'search-count', text: '0/0' })
    const prev = el(
      'button',
      {
        class: 'icon-btn small',
        type: 'button',
        title: '上一个匹配 (Shift+Enter)',
        html: icon('chevronDown', 15, 'rotate-180')
      },
      null
    )
    const next = el(
      'button',
      { class: 'icon-btn small', type: 'button', title: '下一个匹配 (Enter)', html: icon('chevronDown', 15) },
      null
    )
    const close = el(
      'button',
      { class: 'icon-btn small', type: 'button', title: '关闭查找 (Esc)', html: icon('close', 15) },
      null
    )

    this.searchBar = el(
      'div',
      { class: 'terminal-search', hidden: true },
      el('span', { class: 'search-icon', html: icon('search', 15) }),
      this.searchInput,
      this.searchCount,
      prev,
      next,
      close
    )

    const findNext = () => {
      if (!this.searchInput.value) {
        this.searchAddon.clearDecorations()
        this.searchCount.textContent = '0/0'
        return
      }
      this.searchAddon.findNext(this.searchInput.value, SEARCH_OPTIONS)
    }
    const findPrevious = () => {
      if (!this.searchInput.value) return
      this.searchAddon.findPrevious(this.searchInput.value, SEARCH_OPTIONS)
    }

    this.searchInput.addEventListener('input', () => findNext())
    this.searchInput.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        this.closeSearch()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (event.shiftKey) findPrevious()
        else findNext()
      }
    })
    prev.addEventListener('click', () => {
      findPrevious()
      this.searchInput.focus()
    })
    next.addEventListener('click', () => {
      findNext()
      this.searchInput.focus()
    })
    close.addEventListener('click', () => this.closeSearch())
  }

  openSearch(): void {
    this.searchBar.hidden = false
    const selection = this.term.getSelection()
    if (selection && selection.length < 200 && !selection.includes('\n')) {
      this.searchInput.value = selection
    }
    this.searchInput.focus()
    this.searchInput.select()
    if (this.searchInput.value) {
      this.searchAddon.findNext(this.searchInput.value, SEARCH_OPTIONS)
    }
  }

  closeSearch(): void {
    this.searchBar.hidden = true
    this.searchAddon.clearDecorations()
    this.searchCount.textContent = '0/0'
    this.focus()
  }

  private showConnecting(): void {
    this.renderOverlay({
      kind: 'connecting',
      title: '正在连接',
      message: `${this.connection.username}@${this.connection.host}:${this.connection.port}`,
      actions: [
        {
          label: '取消',
          action: () => this.callbacks.onRequestClose(this)
        }
      ]
    })
  }

  async start(options: {
    password?: string
    passphrase?: string
    rememberPassword?: boolean
    rememberPassphrase?: boolean
  }): Promise<void> {
    if (this.opening || this.disposed) return
    this.opening = true
    this.showConnecting()
    this.fitNow()
    try {
      await this.api.openSession({
        sessionId: this.id,
        connectionId: this.connection.id,
        password: options.password,
        passphrase: options.passphrase,
        rememberPassword: options.rememberPassword,
        rememberPassphrase: options.rememberPassphrase,
        cols: this.term.cols || 100,
        rows: this.term.rows || 30
      })
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error))
    } finally {
      this.opening = false
    }
  }

  handleData(data: string): void {
    if (this.disposed) return
    this.term.write(data)
  }

  handleStatus(event: SshStatusEvent): void {
    if (this.disposed) return
    this.statusValue = event.status
    this.lastStatusEvent = event
    if (event.status === 'connected') {
      this.connected = true
      this.intentionalDisconnect = false
      this.hideOverlay()
      this.scheduleFit()
      if (this.active) this.focus()
    } else if (event.status === 'connecting') {
      this.connected = false
      this.showConnecting()
    } else if (event.status === 'opening-shell') {
      this.connected = false
      this.renderOverlay({
        kind: 'connecting',
        title: '认证成功',
        message: '正在打开远端终端…',
        actions: []
      })
    } else if (event.status === 'reconnecting') {
      this.connected = false
      this.renderOverlay({
        kind: 'reconnecting',
        title: '正在重新连接',
        message: event.message || '连接中断，正在尝试恢复…',
        detail: event.attempt ? `第 ${event.attempt} 次尝试` : '',
        actions: []
      })
    } else if (event.status === 'error') {
      this.connected = false
      this.showError(event.message, event.code)
    } else if (event.status === 'disconnected') {
      this.connected = false
      if (!this.intentionalDisconnect) {
        this.showDisconnected(event.message || '连接已断开')
      }
    }
    this.callbacks.onStatusChange(this, event)
  }

  handleClosed(event: SshClosedEvent): void {
    if (this.disposed) return
    if (event.reason === 'error' || this.statusValue === 'error') return
    if (event.reason === 'closed' && !this.intentionalDisconnect) {
      this.connected = false
      this.showDisconnected(event.message || '连接已断开')
    }
  }

  private showError(message: string, code?: string): void {
    this.statusValue = 'error'
    const actions: OverlayAction[] = [
      { label: '重试', primary: true, action: () => void this.reconnect() },
      { label: '关闭', action: () => this.callbacks.onRequestClose(this) }
    ]
    if (code === 'AUTH_FAILED' || code === 'HOST_KEY_CHANGED' || code === 'BAD_PASSPHRASE') {
      actions.splice(1, 0, { label: '编辑连接', action: () => this.callbacks.onRequestEdit(this) })
    }
    this.renderOverlay({
      kind: 'error',
      title: code === 'HOST_KEY_CHANGED' ? '主机密钥已变更' : '连接失败',
      message,
      detail: code ? `错误代码：${code}` : '',
      actions
    })
  }

  private showDisconnected(message: string): void {
    this.statusValue = 'disconnected'
    this.renderOverlay({
      kind: 'disconnected',
      title: '连接已断开',
      message,
      actions: [
        { label: '重新连接', primary: true, action: () => void this.reconnect() },
        { label: '关闭', action: () => this.callbacks.onRequestClose(this) }
      ]
    })
  }

  private renderOverlay(options: {
    kind: 'connecting' | 'reconnecting' | 'error' | 'disconnected'
    title: string
    message: string
    detail?: string
    actions: OverlayAction[]
  }): void {
    clear(this.overlayBody)
    this.overlay.hidden = false
    this.overlay.className = `session-overlay is-${options.kind}`
    const showSpinner = options.kind === 'connecting' || options.kind === 'reconnecting'
    const card = el(
      'div',
      { class: 'session-overlay-card', role: 'status' },
      showSpinner
        ? el('div', { class: 'overlay-spinner', 'aria-hidden': 'true' })
        : el('div', {
            class: 'overlay-icon',
            html: icon(options.kind === 'error' ? 'warning' : 'unplug', 26)
          }),
      el('h2', { class: 'overlay-title', text: options.title }),
      el('p', { class: 'overlay-message', text: options.message }),
      options.detail ? el('p', { class: 'overlay-detail', text: options.detail }) : null,
      options.actions.length > 0
        ? el(
            'div',
            { class: 'overlay-actions' },
            ...options.actions.map((action) =>
              el(
                'button',
                {
                  class: `btn ${action.primary ? 'btn-primary' : 'btn-ghost'}`,
                  type: 'button',
                  text: action.label,
                  onclick: action.action
                },
                null
              )
            )
          )
        : null
    )
    this.overlayBody.appendChild(card)
  }

  private hideOverlay(): void {
    this.overlay.hidden = true
    clear(this.overlayBody)
  }

  async reconnect(): Promise<void> {
    if (this.disposed || this.statusValue === 'connecting' || this.statusValue === 'reconnecting') return
    this.intentionalDisconnect = false
    this.connected = false
    this.statusValue = 'reconnecting'
    this.term.write('\r\n\x1b[38;5;244m── 正在重新连接 ──\x1b[0m\r\n')
    this.renderOverlay({
      kind: 'reconnecting',
      title: '正在重新连接',
      message: `${this.connection.username}@${this.connection.host}:${this.connection.port}`,
      actions: []
    })
    try {
      await this.api.reconnectSession(this.id)
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error))
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true
    try {
      await this.api.disconnectSession(this.id, false)
    } catch {
      // The status event is authoritative.
    }
  }

  copySelection(): void {
    const selection = this.term.getSelection()
    if (!selection) {
      this.callbacks.onToast('没有选中的内容', 'info')
      return
    }
    this.api.clipboardWrite(selection)
    this.callbacks.onToast('已复制到剪贴板', 'success')
  }

  copyAndPasteSelection(): void {
    const selection = this.term.getSelection()
    if (!selection) {
      this.callbacks.onToast('没有选中的内容', 'info')
      return
    }
    this.api.clipboardWrite(selection)
    this.term.paste(selection)
    this.focus()
    this.callbacks.onToast('已复制并粘贴到光标位置', 'success')
  }

  pasteMultiline(): void {
    const text = this.api.clipboardRead()
    if (!text) {
      this.callbacks.onToast('剪贴板为空', 'info')
      return
    }
    if (!this.connected) {
      this.callbacks.onToast('当前会话未连接', 'warning')
      return
    }
    const normalized = text.replace(/\r\n?/g, '\n')
    const hasNewline = normalized.includes('\n')
    const run = ++this.multilineRun
    this.focus()

    if (!hasNewline) {
      this.callbacks.onToast('已粘贴到光标位置', 'success')
      void this.api.writeSession(this.id, normalized).catch(() => {})
      return
    }

    const trailingNewline = normalized.endsWith('\n')
    const lines = normalized.split('\n')
    if (trailingNewline) lines.pop()
    if (lines.length === 0) {
      this.callbacks.onToast('剪贴板中没有可执行的指令', 'info')
      return
    }
    this.callbacks.onToast(
      trailingNewline
        ? `开始逐行执行 ${lines.length} 条指令`
        : `开始逐行粘贴 ${lines.length} 行`,
      'success'
    )
    let index = 0
    const executeNext = () => {
      if (
        this.disposed ||
        run !== this.multilineRun ||
        !this.connected ||
        index >= lines.length
      ) {
        return
      }
      const line = lines[index]
      const isLastLine = index === lines.length - 1
      index += 1
      const suffix = !isLastLine || trailingNewline ? '\r' : ''
      void this.api.writeSession(this.id, `${line}${suffix}`).catch(() => {})
      if (index < lines.length) window.setTimeout(executeNext, 220)
    }
    executeNext()
  }

  paste(): void {
    const text = this.api.clipboardRead()
    if (!text) return
    this.term.paste(text)
    this.focus()
  }

  selectAll(): void {
    this.term.selectAll()
  }

  clear(): void {
    this.term.clear()
    this.focus()
  }

  sendCommand(command: string): void {
    if (!this.connected) {
      this.callbacks.onToast('当前会话未连接', 'warning')
      return
    }
    const suffix = command.endsWith('\r') || command.endsWith('\n') ? '' : '\r'
    void this.api.writeSession(this.id, `${command}${suffix}`)
    this.focus()
  }

  sendText(text: string): void {
    if (!this.connected) return
    void this.api.writeSession(this.id, text)
    this.focus()
  }

  focus(): void {
    if (this.disposed) return
    this.term.focus()
  }

  blur(): void {
    if (this.disposed) return
    this.term.blur()
  }

  setActive(active: boolean): void {
    this.active = active
    this.element.classList.toggle('is-active', active)
    if (active) {
      this.scheduleFit()
      window.setTimeout(() => this.focus(), 0)
    } else {
      this.blur()
    }
  }

  scheduleFit(): void {
    if (this.fitScheduled || this.disposed) return
    this.fitScheduled = true
    requestAnimationFrame(() => {
      this.fitScheduled = false
      this.fitNow()
    })
  }

  fitNow(): void {
    if (this.disposed || !this.element.isConnected || !this.active) return
    if (this.element.offsetParent === null) return
    try {
      this.fitAddon.fit()
    } catch {
      // Dimensions may be transiently zero while switching tabs.
    }
  }

  applySettings(settings: Settings): void {
    this.settings = settings
    if (this.disposed) return
    this.term.options.fontFamily = settings.fontFamily || DEFAULT_FONT_FAMILY
    this.term.options.fontSize = settings.fontSize
    this.term.options.lineHeight = Math.max(1, Math.min(2.2, settings.lineHeight))
    this.term.options.letterSpacing = settings.letterSpacing
    this.term.options.scrollback = settings.scrollback
    this.term.options.cursorStyle = settings.cursorStyle
    this.term.options.cursorBlink = settings.cursorBlink
    this.term.options.theme = TERMINAL_THEMES[settings.terminalTheme].theme as ITheme
    this.scheduleFit()
  }

  getStatus(): SessionStatus {
    return this.statusValue
  }

  isConnected(): boolean {
    return this.connected
  }

  getRemoteTitle(): string {
    return this.remoteTitle
  }

  getLastStatus(): SshStatusEvent | null {
    return this.lastStatusEvent
  }

  getTerminal(): Terminal {
    return this.term
  }

  getBufferText(): string {
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)
      if (line) lines.push(line.translateToString(true))
    }
    return lines.join('\n').replace(/\s+$/g, '')
  }

  getColorCells(): Array<{
    line: number
    column: number
    text: string
    fgMode: number
    fg: number
    bgMode: number
    bg: number
    bold: boolean
  }> {
    const buffer = this.term.buffer.active
    const cells: Array<{
      line: number
      column: number
      text: string
      fgMode: number
      fg: number
      bgMode: number
      bg: number
      bold: boolean
    }> = []
    const firstLine = Math.max(0, buffer.length - 120)
    for (let lineIndex = firstLine; lineIndex < buffer.length; lineIndex += 1) {
      const line = buffer.getLine(lineIndex)
      if (!line) continue
      for (let column = 0; column < line.length; column += 1) {
        const cell = line.getCell(column)
        if (!cell) continue
        const text = cell.getChars()
        if (!text.trim()) continue
        const fgMode = cell.getFgColorMode()
        const bgMode = cell.getBgColorMode()
        if (fgMode === 0 && bgMode === 0 && !cell.isBold()) continue
        cells.push({
          line: lineIndex,
          column,
          text,
          fgMode,
          fg: cell.getFgColor(),
          bgMode,
          bg: cell.getBgColor(),
          bold: Boolean(cell.isBold())
        })
        if (cells.length > 4000) return cells
      }
    }
    return cells
  }

  getBufferType(): string {
    return this.term.buffer.active.type
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.multilineRun += 1
    window.removeEventListener('contextmenu', this.onContextMenu, true)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    try {
      this.term.dispose()
    } catch {
      // ignore
    }
    this.element.remove()
  }

  getSettingsSnapshot(): Settings {
    return this.settings
  }
}
