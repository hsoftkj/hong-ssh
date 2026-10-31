import type {
  AppState,
  Connection,
  HongSshApi,
  SshClosedEvent,
  SshDataEvent,
  SshStatusEvent,
  SystemInfoEvent,
  SystemStatsEvent
} from '../types'
import { TerminalSession } from './session'
import { el } from '../ui/dom'
import { icon } from '../ui/icons'
import { showContextMenu } from '../ui/context-menu'
import type { ModalHost } from '../ui/modal'
import type { ToastHost } from '../ui/toast'

interface SessionManagerOptions {
  api: HongSshApi
  tabsContainer: HTMLElement
  panesContainer: HTMLElement
  emptyState: HTMLElement
  modal: ModalHost
  toast: ToastHost
  getState: () => AppState
  getSettings: () => AppState['settings']
  onActiveChange: (session: TerminalSession | null) => void
  onSessionsChange: () => void
  onTerminalResize: (session: TerminalSession) => void
  onEditConnection: (connection: Connection) => void
  onDuplicateConnection: (connection: Connection) => void
}

interface OpenOptions {
  password?: string
  passphrase?: string
  rememberPassword?: boolean
  rememberPassphrase?: boolean
}

export class SessionManager {
  private readonly api: HongSshApi
  private readonly tabsContainer: HTMLElement
  private readonly panesContainer: HTMLElement
  private readonly emptyState: HTMLElement
  private readonly modal: ModalHost
  private readonly toast: ToastHost
  private readonly getState: () => AppState
  private readonly getSettings: () => AppState['settings']
  private readonly onActiveChange: (session: TerminalSession | null) => void
  private readonly onSessionsChange: () => void
  private readonly onTerminalResize: (session: TerminalSession) => void
  private readonly onEditConnection: (connection: Connection) => void
  private readonly onDuplicateConnection: (connection: Connection) => void

  private readonly sessions = new Map<string, TerminalSession>()
  private readonly tabs = new Map<string, HTMLElement>()
  private activeId: string | null = null
  private disposed = false

  constructor(options: SessionManagerOptions) {
    this.api = options.api
    this.tabsContainer = options.tabsContainer
    this.panesContainer = options.panesContainer
    this.emptyState = options.emptyState
    this.modal = options.modal
    this.toast = options.toast
    this.getState = options.getState
    this.getSettings = options.getSettings
    this.onActiveChange = options.onActiveChange
    this.onSessionsChange = options.onSessionsChange
    this.onTerminalResize = options.onTerminalResize
    this.onEditConnection = options.onEditConnection
    this.onDuplicateConnection = options.onDuplicateConnection

    this.tabsContainer.addEventListener(
      'wheel',
      (event) => {
        if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
        this.tabsContainer.scrollLeft += event.deltaY
        event.preventDefault()
      },
      { passive: false }
    )
  }

  get active(): TerminalSession | null {
    return this.activeId ? this.sessions.get(this.activeId) ?? null : null
  }

  get count(): number {
    return this.sessions.size
  }

  get allSessions(): TerminalSession[] {
    return [...this.sessions.values()]
  }

  async open(connection: Connection, options: OpenOptions = {}): Promise<TerminalSession> {
    const settings = this.getSettings()
    const session = new TerminalSession({
      api: this.api,
      connection,
      settings,
      getSettings: this.getSettings,
      callbacks: {
        onStatusChange: () => {},
        onTitleChange: (item, title) => this.handleTitle(item, title),
        onResize: (item) => this.onTerminalResize(item),
        onRequestClose: (item) => void this.close(item.id),
        onRequestEdit: (item) => {
          const latest = this.getState().connections.find((value) => value.id === item.connection.id)
          if (latest) this.onEditConnection(latest)
        },
        onToast: (message, kind = 'info') => {
          if (kind === 'error') this.toast.error(message)
          else if (kind === 'success') this.toast.success(message)
          else if (kind === 'warning') this.toast.warning(message)
          else this.toast.info(message)
        }
      }
    })

    this.sessions.set(session.id, session)
    this.panesContainer.appendChild(session.element)
    this.createTab(session)
    this.emptyState.hidden = true
    this.activate(session.id)
    this.onSessionsChange()
    await session.start(options)
    return session
  }

  private createTab(session: TerminalSession): void {
    const closeButton = el(
      'button',
      {
        class: 'session-tab-close',
        type: 'button',
        title: '关闭会话',
        'aria-label': `关闭 ${session.connection.name}`,
        html: icon('close', 12),
        onclick: (event: MouseEvent) => {
          event.stopPropagation()
          void this.close(session.id)
        }
      },
      null
    )

    const tab = el(
      'div',
      {
        class: 'session-tab is-connecting',
        role: 'tab',
        tabindex: '0',
        draggable: 'true',
        title: `${session.connection.username}@${session.connection.host}:${session.connection.port}`,
        dataset: { sessionId: session.id }
      },
      el('span', { class: 'session-tab-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'session-tab-name', text: session.connection.name }),
      closeButton
    )

    tab.addEventListener('click', () => this.activate(session.id))
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        this.activate(session.id)
      }
    })
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault()
        void this.close(session.id)
      }
    })
    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.showTabMenu(session, event.clientX, event.clientY)
    })
    tab.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/x-hongssh-session', session.id)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      tab.classList.add('is-dragging')
    })
    tab.addEventListener('dragend', () => tab.classList.remove('is-dragging'))
    tab.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('text/x-hongssh-session')) {
        event.preventDefault()
      }
    })
    tab.addEventListener('drop', (event) => {
      event.preventDefault()
      const draggedId = event.dataTransfer?.getData('text/x-hongssh-session')
      if (!draggedId || draggedId === session.id) return
      const dragged = this.tabs.get(draggedId)
      if (!dragged) return
      const rect = tab.getBoundingClientRect()
      const after = event.clientX > rect.left + rect.width / 2
      this.tabsContainer.insertBefore(dragged, after ? tab.nextSibling : tab)
    })

    this.tabs.set(session.id, tab)
    this.tabsContainer.appendChild(tab)
  }

  private showTabMenu(session: TerminalSession, x: number, y: number): void {
    showContextMenu(
      [
        {
          label: '重新连接',
          icon: 'refresh',
          disabled: session.getStatus() === 'connecting' || session.getStatus() === 'reconnecting',
          action: () => void session.reconnect()
        },
        {
          label: '断开连接',
          icon: 'unplug',
          disabled: !session.isConnected(),
          action: () => void session.disconnect()
        },
        { separator: true },
        {
          label: '复制会话',
          icon: 'copy',
          action: () => {
            const connection = this.getState().connections.find(
              (value) => value.id === session.connection.id
            )
            if (connection) this.onDuplicateConnection(connection)
          }
        },
        { label: '关闭标签页', icon: 'close', action: () => void this.close(session.id) },
        { label: '关闭其他标签页', icon: 'layout', action: () => void this.closeOthers(session.id) },
        { label: '关闭全部标签页', icon: 'trash', danger: true, action: () => void this.closeAll() }
      ],
      x,
      y
    )
  }

  activate(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.activeId = id
    for (const [tabId, tab] of this.tabs) {
      tab.classList.toggle('is-active', tabId === id)
      tab.setAttribute('aria-selected', tabId === id ? 'true' : 'false')
    }
    for (const item of this.sessions.values()) item.setActive(item.id === id)
    this.onActiveChange(session)
    this.updateTitle()
    requestAnimationFrame(() => {
      const tab = this.tabs.get(id)
      tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }

  async close(id: string, force = false): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    const settings = this.getSettings()
    const status = session.getStatus()
    const isOpen = status === 'connected'
    if (!force && isOpen && settings.confirmClose) {
      const confirmed = await this.modal.confirm({
        title: '关闭会话',
        message: `确定要关闭 “${session.connection.name}” 吗？`,
        detail: session.isConnected() ? '远端 shell 会被断开。' : '当前连接尚未建立。',
        confirmText: '关闭会话',
        danger: true
      })
      if (!confirmed) return
    }
    this.removeSession(id)
    try {
      await this.api.disconnectSession(id, true)
    } catch {
      // The main process may have already cleaned up the session.
    }
  }

  private removeSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    const wasActive = this.activeId === id
    const ids = [...this.sessions.keys()]
    const index = ids.indexOf(id)
    this.sessions.delete(id)
    this.tabs.get(id)?.remove()
    this.tabs.delete(id)
    session.dispose()
    if (wasActive) {
      this.activeId = null
      const nextId = ids[index + 1] && this.sessions.has(ids[index + 1]) ? ids[index + 1] : ids[index - 1]
      if (nextId && this.sessions.has(nextId)) this.activate(nextId)
      else this.onActiveChange(null)
    }
    this.emptyState.hidden = this.sessions.size > 0
    this.onSessionsChange()
    this.updateTitle()
  }

  async closeOthers(id: string): Promise<void> {
    const ids = [...this.sessions.keys()].filter((sessionId) => sessionId !== id)
    for (const sessionId of ids) await this.close(sessionId, true)
    this.activate(id)
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    for (const id of ids) await this.close(id, true)
  }

  async closeActive(): Promise<void> {
    if (this.activeId) await this.close(this.activeId)
  }

  reconnectActive(): void {
    void this.active?.reconnect()
  }

  disconnectActive(): void {
    const session = this.active
    if (!session) return
    if (!session.isConnected()) {
      this.toast.info('当前会话未连接')
      return
    }
    void session.disconnect()
  }

  clearActive(): void {
    this.active?.clear()
  }

  copyActive(): void {
    this.active?.copySelection()
  }

  pasteActive(): void {
    this.active?.paste()
  }

  selectAllActive(): void {
    this.active?.selectAll()
  }

  findActive(): void {
    this.active?.openSearch()
  }

  sendCommandToActive(command: string): void {
    this.active?.sendCommand(command)
  }

  next(): void {
    const ids = [...this.sessions.keys()]
    if (ids.length < 2 || !this.activeId) return
    const index = ids.indexOf(this.activeId)
    this.activate(ids[(index + 1) % ids.length])
  }

  previous(): void {
    const ids = [...this.sessions.keys()]
    if (ids.length < 2 || !this.activeId) return
    const index = ids.indexOf(this.activeId)
    this.activate(ids[(index - 1 + ids.length) % ids.length])
  }

  applySettings(): void {
    const settings = this.getSettings()
    for (const session of this.sessions.values()) session.applySettings(settings)
    this.updateTitle()
  }

  updateConnection(connection: Connection): void {
    for (const session of this.sessions.values()) {
      if (session.connection.id !== connection.id) continue
      Object.assign(session.connection, connection)
      const tab = this.tabs.get(session.id)
      if (tab) {
        const name = tab.querySelector('.session-tab-name')
        if (name) name.textContent = connection.name
        tab.title = `${connection.username}@${connection.host}:${connection.port}`
      }
    }
    this.updateTitle()
  }

  updateTitle(): void {
    const session = this.active
    if (!session) {
      document.title = 'HongSSH'
      void this.api.setWindowTitle('')
      return
    }
    const remote = session.getRemoteTitle()
    const suffix = remote && remote !== session.connection.name ? ` — ${remote}` : ''
    document.title = `${session.connection.name}${suffix} - HongSSH`
    void this.api.setWindowTitle(`${session.connection.name}${suffix}`)
  }

  handleData(event: SshDataEvent): void {
    this.sessions.get(event.sessionId)?.handleData(event.data)
  }

  handleStatus(event: SshStatusEvent): void {    const session = this.sessions.get(event.sessionId)
    if (!session) return
    session.handleStatus(event)
    const tab = this.tabs.get(event.sessionId)
    if (tab) {
      tab.classList.remove('is-connecting', 'is-connected', 'is-error', 'is-disconnected')
      if (event.status === 'connected') tab.classList.add('is-connected')
      else if (event.status === 'error') tab.classList.add('is-error')
      else if (event.status === 'disconnected') tab.classList.add('is-disconnected')
      else tab.classList.add('is-connecting')
      tab.title = `${session.connection.username}@${session.connection.host}:${session.connection.port}${
        event.message ? `\n${event.message}` : ''
      }`
    }
    if (event.status === 'connected') {
      const connection = this.getState().connections.find((value) => value.id === event.connectionId)
      if (connection) {
        connection.lastConnectedAt = Date.now()
        this.onSessionsChange()
      }
    }
    if (this.activeId === event.sessionId) this.onActiveChange(session)
  }

  handleClosed(event: SshClosedEvent): void {
    this.sessions.get(event.sessionId)?.handleClosed(event)
  }

  handleSystemInfo(event: SystemInfoEvent): void {
    const session = this.sessions.get(event.sessionId)
    if (!session) return
    session.systemInfo = event.info
    if (this.activeId === event.sessionId) this.onActiveChange(session)
  }

  handleSystemStats(event: SystemStatsEvent): void {
    const session = this.sessions.get(event.sessionId)
    if (!session) return
    session.systemStats = event.stats
  }

  handleTitle(session: TerminalSession, title: string): void {
    if (!title) return
    const tab = this.tabs.get(session.id)
    if (tab) tab.title = `${session.connection.username}@${session.connection.host}:${session.connection.port}\n${title}`
    if (this.activeId === session.id) this.updateTitle()
  }

  getSessionByConnectionId(connectionId: string): TerminalSession[] {
    return [...this.sessions.values()].filter(
      (session) => session.connection.id === connectionId
    )
  }

  dispose(): void {
    this.disposed = true
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    this.tabs.clear()
    this.onActiveChange(null)
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}
