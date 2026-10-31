import './styles/app.css'

import type {
  AppInfo,
  AppState,
  Connection,
  ConnectionDraft,
  HongSshApi,
  MenuAction,
  ScreenRecordingStatus,
  Settings,
  SshClosedEvent,
  SshDataEvent,
  SshHostKeyEvent,
  SshStatusEvent,
  TestResult
} from './types'
import { debounce, el } from './ui/dom'
import { icon, logo } from './ui/icons'
import { ToastHost } from './ui/toast'
import { ModalHost } from './ui/modal'
import { Sidebar } from './ui/sidebar'
import { SystemInfoBar } from './ui/system-info'
import { TitleBar } from './ui/titlebar'
import { Toolbar } from './ui/toolbar'
import { StatusBar } from './ui/statusbar'
import { EmptyState } from './ui/empty-state'
import { SftpPanel } from './ui/sftp-panel'
import { SessionManager } from './terminal/manager'
import { openConnectionDialog } from './dialogs/connection'
import { chooseConnectionType } from './dialogs/connection-type'
import { openRemoteConnectionDialog } from './dialogs/remote-connection'
import { askPassword } from './dialogs/password'
import { openInspectionDialog } from './dialogs/inspection'
import { openSettingsDialog } from './dialogs/settings'
import {
  folderPathLabel,
  showAboutDialog,
  showImportResult,
  showShortcutsDialog
} from './dialogs/misc'
import { TERMINAL_THEME_ORDER, TERMINAL_THEMES } from './terminal/themes'
import { isDarkAppTheme } from './ui-themes'

class HongSshApp {
  private readonly api: HongSshApi
  private state!: AppState
  private info!: AppInfo
  private modal!: ModalHost
  private toast!: ToastHost
  private sidebar!: Sidebar
  private titlebar!: TitleBar
  private systemInfo!: SystemInfoBar
  private toolbar!: Toolbar
  private statusbar!: StatusBar
  private emptyState!: EmptyState
  private recording = false
  private screenshotting = false
  private sftp!: SftpPanel
  private sessions!: SessionManager
  private tabsEl!: HTMLElement
  private panesEl!: HTMLElement
  private resizerEl!: HTMLElement
  private filesResizerEl!: HTMLElement
  private lastSettingsSignature = ''
  private settingsQueue: Promise<void> = Promise.resolve()
  private sidebarWidth = 286
  private sftpWidth = 430
  private booted = false

  constructor(api: HongSshApi) {
    this.api = api
  }

  async boot(): Promise<void> {
    const api = this.api
    document.documentElement.dataset.platform = api.platform
    const [state, info] = await Promise.all([api.loadState(), api.appInfo()])
    this.state = state
    this.info = info
    this.sidebarWidth = state.settings.sidebarWidth
    this.sftpWidth = state.settings.sftpWidth
    document.documentElement.dataset.theme = state.settings.theme

    this.buildLayout()
    this.applyState(state, true)
    this.bindIpcEvents()
    this.exposeDebugApi()
    this.booted = true

    window.addEventListener(
      'resize',
      debounce(() => this.refreshUi(), 120)
    )
  }

  private buildLayout(): void {
    const root = document.getElementById('app')
    if (!root) throw new Error('缺少 #app 容器')
    root.replaceChildren()
    root.className = 'app-shell'

    const modalRoot = el('div', { class: 'modal-root' })
    const toastRoot = el('div', { class: 'toast-root' })
    document.body.append(modalRoot, toastRoot)
    this.modal = new ModalHost(modalRoot)
    this.toast = new ToastHost(toastRoot)

    this.tabsEl = el('div', { class: 'tabs', role: 'tablist', 'aria-label': '会话标签页' })
    this.panesEl = el('div', { class: 'terminal-panes' })
    this.emptyState = new EmptyState({
      onNewConnection: () => this.newConnectionFromSelection(),
      onImport: () => void this.importXshell(),
      onOpenConnection: (connection) => void this.openConnection(connection)
    })

    this.sessions = new SessionManager({
      api: this.api,
      tabsContainer: this.tabsEl,
      panesContainer: this.panesEl,
      emptyState: this.emptyState.element,
      modal: this.modal,
      toast: this.toast,
      getState: () => this.state,
      getSettings: () => this.state.settings,
      onActiveChange: () => this.refreshUi(),
      onSessionsChange: () => this.refreshUi(),
      onTerminalResize: () => {
        if (this.sessions.active) {
          this.statusbar.update(this.sessions.active, this.sessions.count)
        }
      },
      onEditConnection: (connection) => this.editConnection(connection),
      onDuplicateConnection: (connection) => this.duplicateConnection(connection)
    })

    this.sidebar = new Sidebar({
      api: this.api,
      modal: this.modal,
      toast: this.toast,
      getState: () => this.state,
      onState: (next) => this.applyState(next),
      onOpenConnection: (connection) => void this.openConnection(connection),
      onEditConnection: (connection) => this.editConnection(connection),
      onNewConnection: (folderId) => this.newConnection(folderId),
      onNewRemoteConnection: (folderId) => this.newRemoteConnection(folderId),
      onDuplicateConnection: (connection) => this.duplicateConnection(connection),
      onTestConnection: (connection) => void this.testConnection(connection),
      onDeleteConnection: (connection) => void this.deleteConnection(connection),
      onImport: () => void this.importXshell(),
      isConnectionOpen: (connectionId) =>
        this.sessions.allSessions.some((session) => session.connection.id === connectionId),
      getActiveConnectionId: () => this.sessions.active?.connection.id ?? null
    })

    this.toolbar = new Toolbar({
      onNewConnection: () => this.newConnectionFromSelection(),
      onNewGroup: () => this.sidebar.createGroupFromSelection(),
      onImport: () => void this.importXshell(),
      onExport: () => void this.exportXshell(),
      onReconnect: () => this.sessions.reconnectActive(),
      onDisconnect: () => this.sessions.disconnectActive(),
      onCopy: () => this.sessions.copyActive(),
      onPaste: () => this.sessions.pasteActive(),
      onFind: () => this.sessions.findActive(),
      onClear: () => this.sessions.clearActive(),
      onInspection: () => this.openInspection(),
      onToggleFiles: () => this.toggleFilesPanel(),
      onQuickCommand: (command) => this.sessions.sendCommandToActive(command),
      onFontSize: (size) => this.changeFontSize(0, size),
      onSettings: () => this.openSettings(),
      onToggleTheme: () => this.toggleTheme(),
      onToggleRecording: () => void this.toggleRegionRecording(),
      onScreenshot: () => void this.takeScreenshot(),
      onToggleSidebar: () => this.toggleSidebar()
    })
    this.titlebar = new TitleBar(this.api)
    this.systemInfo = new SystemInfoBar()

    this.statusbar = new StatusBar(this.state, {
      onZoomOut: () => this.changeFontSize(-1),
      onZoomIn: () => this.changeFontSize(1)
    })
    this.sftp = new SftpPanel({
      api: this.api,
      modal: this.modal,
      toast: this.toast,
      onClose: () => {
        this.toolbar.setFilesActive(false)
        this.refreshUi()
      }
    })

    this.resizerEl = el('div', {
      class: 'sidebar-resizer',
      role: 'separator',
      'aria-label': '调整连接面板宽度',
      'aria-orientation': 'vertical',
      tabindex: '0',
      title: '拖动调整宽度，双击恢复默认'
    })
    this.filesResizerEl = el('div', {
      class: 'files-resizer',
      role: 'separator',
      'aria-label': '调整文件面板宽度',
      'aria-orientation': 'vertical',
      tabindex: '0',
      title: '拖动调整文件面板宽度，双击恢复默认',
      hidden: true
    })
    this.bindResizers()

    const newTabButton = el(
      'button',
      {
        class: 'tab-strip-new',
        type: 'button',
        title: '新建连接 (Ctrl+N)',
        'aria-label': '新建连接',
        html: icon('plus', 15),
        onclick: () => this.newConnectionFromSelection()
      },
      null
    )
    const tabStripInner = el('div', { class: 'tab-strip-inner' }, this.tabsEl)
    const tabStrip = el(
      'div',
      { class: 'tab-strip' },
      tabStripInner,
      newTabButton,
      el('div', { class: 'tab-strip-spacer' }),
      el(
        'div',
        { class: 'tab-strip-hint' },
        el('span', { class: 'tab-strip-hint-dot' }),
        el('span', { text: 'SSH' })
      )
    )

    const terminalArea = el(
      'div',
      { class: 'terminal-area' },
      this.panesEl,
      this.emptyState.element
    )
    const workspace = el('main', { class: 'workspace' }, tabStrip, terminalArea, this.systemInfo.element)
    const body = el(
      'div',
      { class: 'app-body' },
      this.sidebar.element,
      this.resizerEl,
      workspace,
      this.filesResizerEl,
      this.sftp.element
    )
    root.append(this.titlebar.element, this.toolbar.element, body, this.statusbar.element)
  }

  private bindIpcEvents(): void {
    this.api.onSshData((event: SshDataEvent) => this.sessions.handleData(event))
    this.api.onSshStatus((event: SshStatusEvent) => {
      this.sessions.handleStatus(event)
      this.sftp.handleStatus(event)
      this.refreshUi()
    })
    this.api.onSshClosed((event: SshClosedEvent) => {
      this.sessions.handleClosed(event)
      this.refreshUi()
    })
    this.api.onSystemInfo((event) => this.sessions.handleSystemInfo(event))
    this.api.onSystemStats((event) => {
      this.sessions.handleSystemStats(event)
      const active = this.sessions.active
      if (active?.id === event.sessionId) this.systemInfo.update(active)
    })
    this.api.onSftpProgress((event) => this.sftp.handleProgress(event))
    this.api.onConfirmQuit((event) => {
      void this.confirmQuit(event.active)
    })
    this.api.onRemoteStatus((status) => {
      if (status.error) {
        this.toast.error(status.error, { title: '远程控制' })
      }
    })
    this.api.onScreenRecordingStatus((status: ScreenRecordingStatus) => {
      this.recording = status.recording
      this.toolbar.setRecording(status.recording)
      if (status.error) {
        this.toast.error(status.error, { title: '区域录屏失败', duration: 7000 })
      } else if (status.path) {
        this.toast.success(`录屏已保存：${status.path}`, {
          title: '区域录屏',
          duration: 8000
        })
      }
    })
    this.api.onSftpDragDownload((event) => {
      this.toast.success(`已下载 ${event.name}`, { title: '拖放下载' })
    })
    this.api.onSftpDragError((event) => {
      this.toast.error(event.message, { title: `拖放下载失败：${event.name}`, duration: 7000 })
    })
    this.api.onSftpDragCancel((event) => {
      this.toast.info(`已取消下载 ${event.name}`, { title: '拖放下载' })
    })
    this.api.onSshHostKey((event: SshHostKeyEvent) => {
      if (event.status !== 'new') return
      this.toast.info(
        `已记录 ${event.hostKey} 的主机指纹\n${event.fingerprint}`,
        { title: '首次连接：主机密钥已保存', duration: 6500 }
      )
    })
    this.api.onMenuAction((action: MenuAction) => this.handleMenuAction(action))
  }

  private handleMenuAction(action: MenuAction): void {
    switch (action) {
      case 'new-connection':
        this.newConnectionFromSelection()
        break
      case 'import-xshell':
        void this.importXshell()
        break
      case 'export-config':
        void this.exportXshell()
        break
      case 'close-tab':
        void this.sessions.closeActive()
        break
      case 'copy':
        this.sessions.copyActive()
        break
      case 'paste':
        this.sessions.pasteActive()
        break
      case 'find':
        this.sessions.findActive()
        break
      case 'select-all':
        this.sessions.selectAllActive()
        break
      case 'clear':
        this.sessions.clearActive()
        break
      case 'zoom-in':
        this.changeFontSize(1)
        break
      case 'zoom-out':
        this.changeFontSize(-1)
        break
      case 'zoom-reset':
        this.changeFontSize(0, 14)
        break
      case 'toggle-sidebar':
        this.toggleSidebar()
        break
      case 'toggle-files':
        this.toggleFilesPanel()
        break
      case 'screenshot':
        void this.takeScreenshot()
        break
      case 'toggle-recording':
        void this.toggleRegionRecording()
        break
      case 'toggle-theme':
        this.toggleTheme()
        break
      case 'cycle-terminal-theme':
        this.cycleTerminalTheme()
        break
      case 'reconnect':
        this.sessions.reconnectActive()
        break
      case 'disconnect':
        this.sessions.disconnectActive()
        break
      case 'next-tab':
        this.sessions.next()
        break
      case 'previous-tab':
        this.sessions.previous()
        break
      case 'settings':
        this.openSettings()
        break
      case 'shortcuts':
        showShortcutsDialog(this.modal)
        break
      case 'about':
        this.showAbout()
        break
    }
  }

  private applyState(next: AppState, initial = false): void {
    const previousSettings = this.lastSettingsSignature
    const previousConnections = this.state?.connections
    const removedConnectionIds = previousConnections
      ? previousConnections
          .filter((connection) => !next.connections.some((item) => item.id === connection.id))
          .map((connection) => connection.id)
      : []
    this.state = next
    this.statusbar.setState(next)
    this.applyAppearance()
    this.sidebar.render()
    this.emptyState.render(next)
    if (!initial) {
      const signature = JSON.stringify(next.settings)
      if (signature !== previousSettings) this.sessions.applySettings()
    }
    this.lastSettingsSignature = JSON.stringify(next.settings)
    for (const connectionId of removedConnectionIds) {
      for (const session of this.sessions.getSessionByConnectionId(connectionId)) {
        void this.sessions.close(session.id, true)
      }
    }
    this.refreshUi()
  }

  private applyAppearance(): void {
    const settings = this.state.settings
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--sidebar-width', `${settings.sidebarWidth}px`)
    document.documentElement.style.setProperty('--sftp-width', `${settings.sftpWidth}px`)
    document.body.classList.toggle('sidebar-collapsed', !settings.sidebarVisible)
    document.body.classList.toggle(
      'show-sidebar-scrollbar',
      settings.hideSidebarScrollbar === false
    )
    if (this.statusbar) this.statusbar.element.hidden = !settings.showStatusBar
  }

  private refreshUi(): void {
    if (!this.sessions) return
    const active = this.sessions.active
    const count = this.sessions.count
    this.toolbar.update(this.state, active, count)
    this.statusbar.update(active, count)
    this.systemInfo.update(active)
    this.sidebar.refreshStatus()
    this.emptyState.element.hidden = count > 0
    if (count === 0) this.emptyState.render(this.state)
    this.sftp.setSession(active)
    this.toolbar.setFilesActive(this.sftp.isOpen)
    this.filesResizerEl.hidden = !this.sftp.isOpen
  }

  private toggleFilesPanel(): void {
    if (this.sftp.isOpen) {
      this.sftp.close()
      return
    }
    this.sftp.setSession(this.sessions.active)
    this.sftp.open()
    this.toolbar.setFilesActive(this.sftp.isOpen)
    this.filesResizerEl.hidden = !this.sftp.isOpen
  }

  private async openConnection(
    connection: Connection,
    provided?: {
      password?: string
      passphrase?: string
      rememberPassword?: boolean
      rememberPassphrase?: boolean
    }
  ): Promise<void> {
    const latest = this.state.connections.find((item) => item.id === connection.id) ?? connection
    if (latest.protocol === 'remoteDesktop') {
      try {
        await this.api.openRemoteWindow(latest.id)
      } catch (error) {
        this.toast.error(errorMessage(error), { title: '无法打开远程桌面' })
      }
      return
    }
    let password = provided?.password
    let passphrase = provided?.passphrase
    let rememberPassword = provided?.rememberPassword ?? false
    let rememberPassphrase = provided?.rememberPassphrase ?? false
    if (latest.authType === 'password' && !latest.hasPassword && !password) {
      const result = await askPassword({
        modal: this.modal,
        connection: latest,
        secretsEncrypted: this.state.secretsEncrypted
      })
      if (!result) return
      password = result.password
      rememberPassword = result.remember
    }
    try {
      await this.sessions.open(latest, {
        password,
        passphrase,
        rememberPassword,
        rememberPassphrase
      })
      this.refreshUi()
      if (rememberPassword || rememberPassphrase) {
        void this.api
          .loadState()
          .then((next) => this.applyState(next))
          .catch(() => {})
      }
    } catch (error) {
      this.toast.error(errorMessage(error), { title: '无法打开会话' })
    }
  }

  private newConnectionFromSelection(): void {
    this.newConnection(this.sidebar?.getNewConnectionFolderId() ?? null)
  }

  private newConnection(folderId: string | null = null): void {
    chooseConnectionType(this.modal, {
      folderLabel: folderId ? folderPathLabel(folderId, this.state.folders) : undefined,
      onSelect: (type) => {
        if (type === 'remoteDesktop') this.newRemoteConnection(folderId)
        else this.newSSHConnection(folderId)
      }
    })
  }

  private newSSHConnection(folderId: string | null = null): void {
    openConnectionDialog({
      modal: this.modal,
      api: this.api,
      settings: this.state.settings,
      folders: this.state.folders,
      secretsEncrypted: this.state.secretsEncrypted,
      defaultFolderId: folderId,
      onSaved: (next, connect, connectionId, secrets) => {
        this.applyState(next)
        this.toast.success('连接已保存')
        if (connect) {
          window.setTimeout(() => {
            const saved = this.state.connections.find((item) => item.id === connectionId)
            if (saved) void this.openConnection(saved, secrets)
          }, 220)
        }
      }
    })
  }

  private newRemoteConnection(folderId: string | null = null): void {
    openRemoteConnectionDialog({
      modal: this.modal,
      api: this.api,
      folders: this.state.folders,
      localDeviceCode: this.state.settings.relayDeviceId,
      defaultFolderId: folderId,
      onSaved: (next, connect, connectionId) => {
        this.applyState(next)
        this.toast.success('远程连接已保存')
        if (connect) {
          window.setTimeout(() => {
            const saved = this.state.connections.find((item) => item.id === connectionId)
            if (saved) void this.openConnection(saved)
          }, 220)
        }
      }
    })
  }

  private editConnection(connection: Connection): void {
    if (connection.protocol === 'remoteDesktop') {
      openRemoteConnectionDialog({
        modal: this.modal,
        api: this.api,
        folders: this.state.folders,
        localDeviceCode: this.state.settings.relayDeviceId,
        connection,
        onSaved: (next, connect, connectionId) => {
          this.applyState(next)
          this.toast.success('远程连接已更新')
          if (connect) {
            window.setTimeout(() => {
              const saved = next.connections.find((item) => item.id === connectionId)
              if (saved) void this.openConnection(saved)
            }, 220)
          }
        }
      })
      return
    }
    openConnectionDialog({
      modal: this.modal,
      api: this.api,
      settings: this.state.settings,
      folders: this.state.folders,
      secretsEncrypted: this.state.secretsEncrypted,
      connection,
      onSaved: (next, connect, connectionId, secrets) => {
        this.applyState(next)
        const saved = next.connections.find((item) => item.id === connectionId)
        if (saved) {
          const openSessions = this.sessions.getSessionByConnectionId(saved.id)
          for (const session of openSessions) {
            session.connection.name = saved.name
            session.connection.username = saved.username
            session.connection.host = saved.host
          }
          this.sessions.updateConnection(saved)
        }
        this.toast.success('连接已更新')
        if (connect && saved) {
          window.setTimeout(() => void this.openConnection(saved, secrets), 220)
        }
      }
    })
  }

  private duplicateConnection(connection: Connection): void {
    const clone: Connection = {
      ...connection,
      id: '',
      name: `${connection.name} 副本`,
      hasPassword: false,
      hasPassphrase: false,
      lastConnectedAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    openConnectionDialog({
      modal: this.modal,
      api: this.api,
      settings: this.state.settings,
      folders: this.state.folders,
      secretsEncrypted: this.state.secretsEncrypted,
      connection: clone,
      copy: true,
      onSaved: (next, connect, connectionId, secrets) => {
        this.applyState(next)
        this.toast.success('已创建连接副本')
        if (connect) {
          window.setTimeout(() => {
            const saved = this.state.connections.find((item) => item.id === connectionId)
            if (saved) void this.openConnection(saved, secrets)
          }, 220)
        }
      }
    })
  }

  private async deleteConnection(connection: Connection): Promise<void> {
    const openSessions = this.sessions.getSessionByConnectionId(connection.id)
    const confirmed = await this.modal.confirm({
      title: '删除连接',
      message: `确定删除连接“${connection.name}”吗？`,
      detail:
        openSessions.length > 0
          ? `该连接当前有 ${openSessions.length} 个打开的会话，删除前会先断开它们。此操作不可撤销。`
          : '连接配置和已保存的密码会被删除，此操作不可撤销。',
      confirmText: '删除',
      danger: true
    })
    if (!confirmed) return
    for (const session of openSessions) await this.sessions.close(session.id, true)
    try {
      const next = await this.api.deleteConnection(connection.id)
      this.applyState(next)
      this.toast.success('连接已删除')
    } catch (error) {
      this.toast.error(errorMessage(error))
    }
  }

  private async testConnection(connection: Connection): Promise<void> {
    let password: string | undefined
    if (connection.authType === 'password' && !connection.hasPassword) {
      const result = await askPassword({
        modal: this.modal,
        connection,
        secretsEncrypted: this.state.secretsEncrypted
      })
      if (!result) return
      password = result.password
    }

    const statusBody = el(
      'div',
      { class: 'connection-test-result is-loading' },
      el('span', { class: 'mini-spinner' }),
      el('span', { text: `正在连接 ${connection.username}@${connection.host}:${connection.port}…` })
    )
    const detail = el('div', { class: 'connection-test-detail' })
    const handle = this.modal.open({
      title: '测试连接',
      subtitle: connection.name,
      icon: 'plug',
      width: 500,
      body: el('div', { class: 'connection-test' }, statusBody, detail),
      footer: el(
        'div',
        { class: 'modal-actions' },
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            text: '关闭',
            onclick: () => handle.close()
          },
          null
        )
      )
    })

    try {
      const result: TestResult = await this.api.testConnection({ connection, password })
      statusBody.className = `connection-test-result ${result.ok ? 'is-success' : 'is-error'}`
      statusBody.replaceChildren(
        el('span', { html: icon(result.ok ? 'check' : 'warning', 20) }),
        el(
          'span',
          {},
          el('strong', { text: result.ok ? '连接成功' : '连接失败' }),
          el('span', { text: result.message })
        )
      )
      detail.replaceChildren(
        el('span', { text: `耗时 ${result.elapsed} ms` }),
        result.fingerprint
          ? el('code', { text: result.fingerprint, title: '服务器主机密钥指纹' })
          : el('span', {})
      )
    } catch (error) {
      statusBody.className = 'connection-test-result is-error'
      statusBody.replaceChildren(
        el('span', { html: icon('warning', 20) }),
        el('span', { text: errorMessage(error) })
      )
    }
  }

  private async exportXshell(): Promise<void> {
    try {
      const result = await this.api.exportXshell()
      if (!result) return
      if (result.connections === 0) {
        this.toast.info('当前没有可导出的连接')
      } else {
        const passwordNote = result.passwords > 0 ? `，包含 ${result.passwords} 个密码` : ''
        this.toast.success(
          `已导出 ${result.connections} 个连接${passwordNote}到 ${result.directory}，请妥善保管导出目录`,
          {
            title: '配置导出完成',
            duration: 6000
          }
        )
      }
    } catch (error) {
      this.toast.error(errorMessage(error), { title: '导出失败' })
    }
  }

  private async importXshell(): Promise<void> {
    try {
      const result = await this.api.importXshell()
      if (!result) return
      this.applyState(result.state)
      if (result.summary.imported > 0) {
        const passwordNote =
          result.summary.passwordsImported > 0
            ? `，恢复 ${result.summary.passwordsImported} 个密码`
            : ''
        this.toast.success(`已导入 ${result.summary.imported} 个连接${passwordNote}`)
      } else if (result.summary.passwordsImported > 0 || result.summary.passphrasesImported > 0) {
        const parts = []
        if (result.summary.passwordsImported > 0) parts.push(`${result.summary.passwordsImported} 个密码`)
        if (result.summary.passphrasesImported > 0) {
          parts.push(`${result.summary.passphrasesImported} 个私钥口令`)
        }
        this.toast.success(`已恢复 ${parts.join('、')}`)
      } else {
        this.toast.info('没有新增连接，可能已全部导入过')
      }
      showImportResult(this.modal, result)
    } catch (error) {
      this.toast.error(errorMessage(error), { title: '导入失败' })
    }
  }

  private async toggleRegionRecording(): Promise<void> {
    if (this.screenshotting) {
      this.toast.info('正在截图，请先完成或取消截图', { title: '区域录屏' })
      return
    }
    if (this.recording) {
      try {
        await this.api.stopScreenRecording()
      } catch (error) {
        this.toast.error(errorMessage(error), { title: '停止录屏失败' })
      }
      return
    }
    try {
      const result = await this.api.startScreenRecording()
      if (result.cancelled) return
      this.recording = true
      this.toolbar.setRecording(true)
      this.toast.info('已开始录制：拖动计时条可移动录制区域；点击红色按钮或按 Ctrl+Shift+F10 停止', {
        title: '区域录屏',
        duration: 6000
      })
    } catch (error) {
      this.toast.error(errorMessage(error), { title: '无法开始录屏' })
    }
  }

  private async takeScreenshot(): Promise<void> {
    if (this.recording) {
      this.toast.info('正在录屏，请先停止录屏后再截图', { title: '框选截图' })
      return
    }
    if (this.screenshotting) return
    this.screenshotting = true
    try {
      const result = await this.api.startScreenshot()
      if (result.cancelled || !result.action) return
      if (result.action === 'save' && result.path) {
        this.toast.success(`截图已保存：${result.path}`, {
          title: '截图',
          duration: 8000
        })
      } else if (result.action === 'pin') {
        this.toast.success('截图已贴到屏幕，双击贴图或按 Esc 可关闭', {
          title: '截图',
          duration: 3000
        })
      } else {
        this.toast.success('截图已复制到剪贴板', { title: '截图', duration: 2600 })
      }
    } catch (error) {
      this.toast.error(errorMessage(error), { title: '截图失败' })
    } finally {
      this.screenshotting = false
    }
  }

  private openSettings(): void {
    openSettingsDialog({
      modal: this.modal,
      api: this.api,
      state: this.state,
      toast: this.toast,
      onSaved: (next) => this.applyState(next)
    })
  }

  private openInspection(): void {
    openInspectionDialog({
      modal: this.modal,
      api: this.api,
      state: this.state,
      onThresholdChange: (value) => {
        if (this.state.settings.inspectionDiskThreshold === value) return
        this.queueSettings({ inspectionDiskThreshold: value })
      }
    })
  }

  private showAbout(): void {
    showAboutDialog(
      this.modal,
      this.info,
      () => {
        void this.api.openDataFolder()
      },
      () => {
        void this.api.checkForUpdates().catch((error) => {
          this.toast.error(errorMessage(error), { title: '检查更新失败' })
        })
      }
    )
  }

  private toggleSidebar(): void {
    this.queueSettings({ sidebarVisible: !this.state.settings.sidebarVisible })
  }

  private toggleTheme(): void {
    this.queueSettings({ theme: isDarkAppTheme(this.state.settings.theme) ? 'light' : 'dark' })
  }

  private async confirmQuit(active: number): Promise<void> {
    const hasActive = active > 0
    const confirmed = await this.modal.confirm({
      title: '退出 HongSSH',
      message: hasActive
        ? `还有 ${active} 个活动会话，确定要退出吗？`
        : '确定要退出 HongSSH 吗？',
      detail: hasActive
        ? '退出后所有 SSH 会话都会被断开。'
        : '退出后将关闭当前窗口，下次可以重新打开。',
      confirmText: '退出',
      cancelText: '取消',
      danger: hasActive
    })
    try {
      await this.api.confirmQuit(confirmed)
    } catch (error) {
      if (confirmed) this.toast.error(errorMessage(error), { title: '退出失败' })
    }
  }

  private cycleTerminalTheme(): void {
    const index = TERMINAL_THEME_ORDER.indexOf(this.state.settings.terminalTheme)
    const next = TERMINAL_THEME_ORDER[(index + 1) % TERMINAL_THEME_ORDER.length]
    this.queueSettings({ terminalTheme: next })
    this.toast.info(`终端配色：${TERMINAL_THEMES[next].label}`, { duration: 1800 })
  }

  private changeFontSize(delta: number, absolute?: number): void {
    const current = this.state.settings.fontSize
    const next = absolute ?? Math.min(32, Math.max(9, current + delta))
    if (next === current) return
    this.queueSettings({ fontSize: next })
  }

  private queueSettings(patch: Partial<Settings>): void {
    this.state.settings = { ...this.state.settings, ...patch }
    this.applyAppearance()
    this.sessions.applySettings()
    this.refreshUi()
    const snapshot = { ...patch }
    this.settingsQueue = this.settingsQueue
      .then(async () => {
        const next = await this.api.saveSettings(snapshot)
        this.state.settings = next.settings
        this.applyAppearance()
        this.statusbar.setState(this.state)
        this.sessions.applySettings()
        this.refreshUi()
      })
      .catch((error) => {
        this.toast.error(errorMessage(error), { title: '设置保存失败' })
      })
  }

  private bindResizers(): void {
    this.bindWidthResizer({
      handle: this.resizerEl,
      defaultWidth: 286,
      minWidth: 200,
      maxWidth: () => 520,
      currentWidth: () => this.sidebarWidth,
      applyWidth: (width) => {
        this.sidebarWidth = width
        this.state.settings.sidebarWidth = width
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
      },
      commitWidth: (width) => this.queueSettings({ sidebarWidth: width })
    })

    this.bindWidthResizer({
      handle: this.filesResizerEl,
      defaultWidth: 430,
      minWidth: 320,
      maxWidth: () => {
        const sidebarWidth = this.state.settings.sidebarVisible === false ? 0 : this.sidebarWidth
        return Math.max(360, Math.min(960, window.innerWidth - sidebarWidth - 340))
      },
      currentWidth: () => this.sftpWidth,
      renderedWidth: () => this.sftp.element.getBoundingClientRect().width,
      inverted: true,
      applyWidth: (width) => {
        this.sftpWidth = width
        this.state.settings.sftpWidth = width
        document.documentElement.style.setProperty('--sftp-width', `${width}px`)
      },
      commitWidth: (width) => this.queueSettings({ sftpWidth: width })
    })
  }

  private bindWidthResizer(options: {
    handle: HTMLElement
    defaultWidth: number
    minWidth: number
    maxWidth: () => number
    currentWidth: () => number
    /** Visible width, which may be smaller than the stored width on narrow windows. */
    renderedWidth?: () => number
    applyWidth: (width: number) => void
    commitWidth: (width: number) => void
    inverted?: boolean
  }): void {
    const clampWidth = (width: number) =>
      Math.round(Math.min(options.maxWidth(), Math.max(options.minWidth, width)))
    const syncAria = (width: number) => {
      options.handle.setAttribute('aria-valuemin', String(options.minWidth))
      options.handle.setAttribute('aria-valuemax', String(Math.round(options.maxWidth())))
      options.handle.setAttribute('aria-valuenow', String(width))
    }
    const apply = (width: number) => {
      options.applyWidth(width)
      syncAria(width)
    }

    let startX = 0
    let startWidth = options.currentWidth()
    let dragging = false

    const stopDragging = () => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('is-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    const onMove = (event: PointerEvent) => {
      if (!dragging) return
      const delta = options.inverted ? startX - event.clientX : event.clientX - startX
      apply(clampWidth(startWidth + delta))
    }
    const onUp = () => {
      if (!dragging) return
      const width = options.currentWidth()
      stopDragging()
      if (width !== startWidth) options.commitWidth(width)
    }

    options.handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      dragging = true
      startX = event.clientX
      startWidth = Math.round(options.renderedWidth?.() ?? options.currentWidth())
      syncAria(startWidth)
      document.body.classList.add('is-resizing')
      try {
        options.handle.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointer events have no active pointer to capture.
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      event.preventDefault()
    })

    options.handle.addEventListener('dblclick', () => {
      apply(clampWidth(options.defaultWidth))
      options.commitWidth(options.currentWidth())
    })

    options.handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 48 : 16
      const base = Math.round(options.renderedWidth?.() ?? options.currentWidth())
      let delta = 0
      if (event.key === 'ArrowLeft') delta = options.inverted ? step : -step
      else if (event.key === 'ArrowRight') delta = options.inverted ? -step : step
      else if (event.key === 'Home') {
        event.preventDefault()
        apply(clampWidth(options.defaultWidth))
        options.commitWidth(options.currentWidth())
        return
      } else {
        return
      }
      event.preventDefault()
      const width = clampWidth(base + delta)
      if (width === base) return
      apply(width)
      options.commitWidth(width)
    })

    syncAria(options.currentWidth())
  }

  private exposeDebugApi(): void {
    ;(window as unknown as Record<string, unknown>).__hongssh = {
      getState: () => this.state,
      getInfo: () => this.info,
      getSessions: () =>
        this.sessions.allSessions.map((session) => ({
          id: session.id,
          name: session.connection.name,
          status: session.getStatus(),
          connected: session.isConnected(),
          cols: session.getTerminal().cols,
          rows: session.getTerminal().rows,
          bufferType: session.getBufferType(),
          buffer: session.getBufferText(),
          colors: session.getColorCells()
        })),
      getActiveBuffer: () => this.sessions.active?.getBufferText() ?? '',
      getSessionColors: (id?: string) => {
        const session = id
          ? this.sessions.allSessions.find((item) => item.id === id)
          : this.sessions.active
        return session?.getColorCells() ?? []
      },
      getSessionState: () =>
        this.sessions.active
          ? {
              id: this.sessions.active.id,
              status: this.sessions.active.getStatus(),
              connected: this.sessions.active.isConnected(),
              cols: this.sessions.active.getTerminal().cols,
              rows: this.sessions.active.getTerminal().rows,
              bufferType: this.sessions.active.getBufferType()
            }
          : null,
      openConnection: (id: string) => {
        const connection = this.state.connections.find((item) => item.id === id)
        if (connection) void this.openConnection(connection)
      },
      createConnection: async (draft: ConnectionDraft) => {
        const next = await this.api.saveConnection(draft)
        this.applyState(next)
        const created = next.connections.find((item) => item.id === draft.id)
        return created?.id ?? ''
      },
      importXshellFrom: async (directory: string) => {
        const result = await this.api.importXshellFrom(directory)
        this.applyState(result.state)
        return result
      },
      sendCommand: (command: string) => this.sessions.sendCommandToActive(command),
      sendText: (text: string) => this.sessions.active?.sendText(text),
      focusTerminal: () => this.sessions.active?.focus()
    }
  }

  get isBooted(): boolean {
    return this.booted
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function renderFatal(title: string, message: string): void {
  const root = document.getElementById('app')
  if (!root) return
  root.replaceChildren(
    el(
      'div',
      { class: 'fatal-screen' },
      el('div', { class: 'fatal-logo', html: logo(56) }),
      el('h1', { text: title }),
      el('p', { text: message })
    )
  )
}

async function main(): Promise<void> {
  const api = window.hongssh
  if (!api) {
    renderFatal('无法访问桌面接口', '请通过 Electron 启动 HongSSH，而不是直接在浏览器中打开页面。')
    return
  }
  const app = new HongSshApp(api)
  try {
    await app.boot()
  } catch (error) {
    console.error(error)
    renderFatal('HongSSH 启动失败', errorMessage(error))
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main(), { once: true })
} else {
  void main()
}
