import type {
  DragDownloadItem,
  HongSshApi,
  SftpEntry,
  SftpListResult,
  SftpProgressEvent,
  SftpStartResult,
  SftpTransferStatus,
  SshStatusEvent
} from '../types'
import type { TerminalSession } from '../terminal/session'
import { el, clear } from '../ui/dom'
import { icon } from '../ui/icons'
import type { ModalHost } from '../ui/modal'
import type { ToastHost } from '../ui/toast'
import { showContextMenu } from '../ui/context-menu'
import { askFolderName } from '../dialogs/misc'
import { createDragPreview } from '../ui/drag-preview'

interface SftpPanelOptions {
  api: HongSshApi
  modal: ModalHost
  toast: ToastHost
  onClose: () => void
}

interface TransferView {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  status: SftpTransferStatus
  transferred: number
  total: number
  percent: number
  resumed?: boolean
  remotePath: string
  localPath: string
  error?: string
}

const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export class SftpPanel {
  readonly element: HTMLElement
  private readonly options: SftpPanelOptions
  private readonly headerSession: HTMLElement
  private readonly headerStatus: HTMLElement
  private readonly pathInput: HTMLInputElement
  private readonly listHeader: HTMLElement
  private readonly listContainer: HTMLElement
  private readonly transferSection: HTMLElement
  private readonly transferList: HTMLElement
  private readonly transferCount: HTMLElement
  private readonly footer: HTMLElement
  private readonly uploadButton: HTMLButtonElement
  private readonly uploadFolderButton: HTMLButtonElement
  private readonly downloadButton: HTMLButtonElement
  private readonly mkdirButton: HTMLButtonElement
  private readonly renameButton: HTMLButtonElement
  private readonly deleteButton: HTMLButtonElement
  private readonly refreshButton: HTMLButtonElement
  private readonly upButton: HTMLButtonElement

  private session: TerminalSession | null = null
  private sessionId = ''
  private dragDepth = 0
  private readonly dropOverlay: HTMLElement
  private currentPath = ''
  private home = ''
  private entries: SftpEntry[] = []
  private selected = new Set<string>()
  private selectionAnchor = -1
  private loading = false
  private error = ''
  private connected = false
  private initialized = false
  private opening = false
  private requestToken = 0
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private readonly transfers = new Map<string, TransferView>()
  private readonly transferElements = new Map<string, TransferDom>()

  constructor(options: SftpPanelOptions) {
    this.options = options
    this.element = el('aside', {
      class: 'sftp-panel',
      'aria-label': '文件传输',
      tabindex: '-1',
      hidden: true
    })
    this.element.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, button, .sftp-row')) return
      this.element.focus({ preventScroll: true })
    })
    this.element.addEventListener('keydown', (event) => this.handlePanelKey(event))

    this.headerStatus = el('span', { class: 'sftp-session-status', text: '未连接' })
    this.headerSession = el('span', { class: 'sftp-session-name', text: '未选择会话' })
    const closeButton = el(
      'button',
      {
        class: 'icon-btn small sftp-close',
        type: 'button',
        title: '关闭文件面板',
        'aria-label': '关闭文件面板',
        html: icon('close', 16),
        onclick: () => this.close()
      },
      null
    )
    const header = el(
      'header',
      { class: 'sftp-header' },
      el('span', { class: 'sftp-header-icon', html: icon('folderOpen', 19) }),
      el(
        'div',
        { class: 'sftp-heading' },
        el('span', { class: 'sftp-title', text: '文件传输' }),
        el('span', { class: 'sftp-session' }, this.headerSession, this.headerStatus)
      ),
      closeButton
    )

    this.upButton = this.iconButton('上一级目录', 'arrowUp', () => void this.goUp())
    this.refreshButton = this.iconButton('刷新', 'refresh', () => void this.refresh())
    this.pathInput = el('input', {
      class: 'sftp-path-input',
      type: 'text',
      spellcheck: 'false',
      placeholder: '/home/user',
      'aria-label': '远端路径'
    })
    this.pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const target = this.pathInput.value.trim()
        if (target) void this.navigate(target)
      } else if (event.key === 'Escape') {
        this.pathInput.value = this.currentPath
        this.pathInput.blur()
      }
    })
    const pathBar = el(
      'div',
      { class: 'sftp-pathbar' },
      this.pathInput,
      this.refreshButton,
      this.upButton
    )

    this.uploadButton = this.actionButton('上传', 'upload', '上传文件（也可 Ctrl+V 或拖放）', () => void this.upload())
    this.uploadFolderButton = this.iconButton('上传文件夹（递归）', 'folderUp', () =>
      void this.uploadFolders()
    )
    this.downloadButton = this.actionButton('下载', 'download', '下载选中的文件或文件夹', () =>
      void this.download()
    )
    this.mkdirButton = this.iconButton('新建文件夹', 'folderPlus', () => void this.createFolder())
    this.renameButton = this.iconButton('重命名', 'edit', () => void this.renameSelected())
    this.deleteButton = this.iconButton('删除', 'trash', () => void this.deleteSelected())
    const actions = el(
      'div',
      { class: 'sftp-actions' },
      this.uploadButton,
      this.uploadFolderButton,
      this.downloadButton,
      el('span', { class: 'sftp-actions-separator' }),
      this.mkdirButton,
      this.renameButton,
      this.deleteButton
    )

    this.listHeader = el(
      'div',
      { class: 'sftp-list-header' },
      el('span', { class: 'sftp-col-icon' }),
      el('span', { class: 'sftp-col-name', text: '名称' }),
      el('span', { class: 'sftp-col-size', text: '大小' }),
      el('span', { class: 'sftp-col-time', text: '修改时间' })
    )
    this.listContainer = el('div', { class: 'sftp-list', role: 'listbox', 'aria-label': '远端文件列表' })
    this.listContainer.addEventListener('keydown', (event) => this.handleListKey(event))

    this.transferCount = el('span', { class: 'sftp-transfer-count' })
    const clearTransfers = el(
      'button',
      {
        class: 'sftp-link-button',
        type: 'button',
        text: '清除已完成',
        onclick: () => this.clearFinishedTransfers()
      },
      null
    )
    this.transferSection = el(
      'section',
      { class: 'sftp-transfers' },
      el(
        'header',
        { class: 'sftp-transfers-header' },
        el('span', { class: 'sftp-transfers-title' }, el('span', { html: icon('activity', 14) }), '传输任务'),
        this.transferCount,
        clearTransfers
      ),
      (this.transferList = el('div', { class: 'sftp-transfer-list' }))
    )

    this.footer = el('footer', { class: 'sftp-footer' })
    this.dropOverlay = el(
      'div',
      { class: 'sftp-drop-overlay', hidden: true },
      el(
        'div',
        { class: 'sftp-drop-card' },
        el('span', { class: 'sftp-drop-icon', html: icon('upload', 30) }),
        el('strong', { text: '松手上传到当前目录' }),
        el('span', { text: '支持多个文件和文件夹，自动递归上传' })
      )
    )
    this.element.append(
      header,
      pathBar,
      actions,
      this.listHeader,
      this.listContainer,
      this.transferSection,
      this.footer,
      this.dropOverlay
    )
    this.bindDropEvents()
    this.renderUnavailable('打开一个已连接的 SSH 会话后，可在这里浏览远端目录并上传、下载文件。')
    this.renderTransfers()
    this.updateActions()
  }

  get isOpen(): boolean {
    return !this.element.hidden
  }

  open(): void {
    if (this.isOpen) return
    this.element.hidden = false
    this.element.classList.add('is-open')
    this.renderTransfers()
    if (this.session && this.connected) {
      if (!this.initialized || this.entries.length === 0) void this.initialize()
      else this.renderList()
    } else {
      this.renderUnavailable(
        this.session ? '当前会话未连接，文件传输不可用。' : '打开一个已连接的 SSH 会话后，可在这里浏览远端目录并上传、下载文件。'
      )
    }
  }

  close(): void {
    if (!this.isOpen) return
    this.dragDepth = 0
    this.dropOverlay.hidden = true
    this.element.classList.remove('is-drag-over')
    this.element.hidden = true
    this.element.classList.remove('is-open')
    this.options.onClose()
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  setSession(session: TerminalSession | null): void {
    const nextId = session?.id ?? ''
    const nextConnected = Boolean(session?.isConnected())
    if (nextId === this.sessionId) {
      this.session = session
      this.connected = nextConnected
      this.updateSessionHeader()
      if (this.isOpen) {
        if (nextConnected && !this.initialized) void this.initialize()
        if (!nextConnected) {
          this.initialized = false
          this.loading = false
          this.requestToken += 1
          this.renderUnavailable('当前会话未连接，文件传输不可用。')
        }
      }
      this.updateActions()
      return
    }

    this.session = session
    this.sessionId = nextId
    this.connected = nextConnected
    this.initialized = false
    this.opening = false
    this.requestToken += 1
    this.currentPath = ''
    this.home = ''
    this.entries = []
    this.selected.clear()
    this.selectionAnchor = -1
    this.error = ''
    this.loading = false
    this.pathInput.value = ''
    this.updateSessionHeader()
    this.renderTransfers()
    if (!session) {
      this.renderUnavailable('打开一个已连接的 SSH 会话后，可在这里浏览远端目录并上传、下载文件。')
    } else if (!nextConnected) {
      this.renderUnavailable('当前会话未连接，文件传输不可用。')
    } else if (this.isOpen) {
      void this.initialize()
    } else {
      this.renderUnavailable('正在等待会话准备就绪…')
    }
    this.updateActions()
  }

  handleStatus(event: SshStatusEvent): void {
    if (event.sessionId !== this.sessionId) return
    if (event.status === 'connected') {
      this.connected = true
      this.updateSessionHeader()
      this.updateActions()
      if (this.isOpen && !this.initialized) void this.initialize()
      else if (this.isOpen && this.error) void this.refresh()
    } else if (event.status === 'disconnected' || event.status === 'error') {
      this.connected = false
      this.initialized = false
      this.loading = false
      this.requestToken += 1
      this.updateSessionHeader()
      this.updateActions()
      if (this.isOpen) this.renderUnavailable('会话已断开，重新连接后可继续传输文件。')
    }
  }

  handleProgress(event: SftpProgressEvent): void {
    const transfer: TransferView = {
      id: event.transferId,
      sessionId: event.sessionId,
      direction: event.direction,
      name: event.name,
      status: event.status,
      transferred: event.transferred,
      total: event.total,
      percent: event.percent,
      resumed: event.resumed,
      remotePath: event.remotePath,
      localPath: event.localPath,
      error: event.error
    }
    this.transfers.set(event.transferId, transfer)
    if (event.sessionId === this.sessionId) {
      this.updateTransferList()
      if (event.status === 'error' && !this.isOpen) {
        this.options.toast.error(`${event.name}：${event.error || '传输失败'}`)
      }
      if (event.status === 'done' && event.direction === 'upload') {
        if (parentRemote(event.remotePath) === this.currentPath) this.scheduleRefresh()
      }
    }
  }

  private updateSessionHeader(): void {
    if (!this.session) {
      this.headerSession.textContent = '未选择会话'
      this.headerStatus.textContent = '未连接'
      this.headerStatus.className = 'sftp-session-status is-idle'
      return
    }
    this.headerSession.textContent = this.session.connection.name
    this.headerSession.title = `${this.session.connection.username}@${this.session.connection.host}:${this.session.connection.port}`
    this.headerStatus.textContent = this.connected ? '已连接' : '已断开'
    this.headerStatus.className = `sftp-session-status ${this.connected ? 'is-connected' : 'is-disconnected'}`
  }

  private async initialize(): Promise<void> {
    if (!this.session || !this.connected || this.opening) return
    const sessionId = this.session.id
    this.opening = true
    this.loading = true
    this.error = ''
    this.renderLoading('正在读取远端主目录…')
    try {
      const home = await this.options.api.sftpHome(sessionId)
      if (this.sessionId !== sessionId || !this.connected) return
      this.home = home
      this.currentPath = home
      await this.load(home)
      if (this.sessionId === sessionId && this.connected) this.initialized = true
    } catch (error) {
      if (this.sessionId !== sessionId || !this.connected) return
      this.error = errorMessage(error)
      this.renderError(this.error)
    } finally {
      if (this.sessionId === sessionId) {
        this.opening = false
        this.loading = false
      }
    }
  }

  private async navigate(target: string): Promise<void> {
    if (!this.session || !this.connected) return
    const path = target.trim()
    if (!path) return
    this.selected.clear()
    this.selectionAnchor = -1
    await this.load(path)
  }

  private async refresh(): Promise<void> {
    if (!this.session || !this.connected) return
    await this.load(this.currentPath || this.home || '.')
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.connected) void this.refresh()
    }, 350)
  }

  private async load(path: string): Promise<void> {
    if (!this.session) return
    const sessionId = this.session.id
    const token = ++this.requestToken
    this.loading = true
    this.error = ''
    this.renderLoading('正在读取目录…')
    try {
      const result: SftpListResult = await this.options.api.sftpList(sessionId, path)
      if (token !== this.requestToken || this.sessionId !== sessionId || !this.connected) return
      this.currentPath = result.path
      this.home = result.home || this.home
      this.entries = result.entries
      this.selected.clear()
      this.selectionAnchor = -1
      this.pathInput.value = this.currentPath
      this.renderList()
    } catch (error) {
      if (token !== this.requestToken || this.sessionId !== sessionId) return
      this.error = errorMessage(error)
      this.renderError(this.error)
    } finally {
      if (token === this.requestToken) {
        this.loading = false
        this.updateActions()
      }
    }
  }

  private renderLoading(message: string): void {
    clear(this.listContainer)
    this.listContainer.appendChild(
      el(
        'div',
        { class: 'sftp-state sftp-state-loading' },
        el('span', { class: 'overlay-spinner' }),
        el('span', { text: message })
      )
    )
    this.listHeader.hidden = true
  }

  private renderError(message: string): void {
    clear(this.listContainer)
    this.listHeader.hidden = true
    this.listContainer.appendChild(
      el(
        'div',
        { class: 'sftp-state sftp-state-error' },
        el('span', { class: 'sftp-state-icon', html: icon('warning', 26) }),
        el('span', { class: 'sftp-state-title', text: '无法读取目录' }),
        el('span', { class: 'sftp-state-message', text: message }),
        el(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: '重试',
            onclick: () => void this.refresh()
          },
          null
        )
      )
    )
    this.updateActions()
  }

  private renderUnavailable(message: string): void {
    if (this.loading) return
    clear(this.listContainer)
    this.listHeader.hidden = true
    this.listContainer.appendChild(
      el(
        'div',
        { class: 'sftp-state' },
        el('span', { class: 'sftp-state-icon', html: icon('folderOpen', 28) }),
        el('span', { class: 'sftp-state-title', text: '文件传输' }),
        el('span', { class: 'sftp-state-message', text: message })
      )
    )
    this.footer.textContent = ''
    this.updateActions()
  }

  private renderList(): void {
    clear(this.listContainer)
    this.listHeader.hidden = this.entries.length === 0
    if (this.entries.length === 0) {
      this.listContainer.appendChild(
        el(
          'div',
          { class: 'sftp-state' },
          el('span', { class: 'sftp-state-icon', html: icon('folder', 26) }),
          el('span', { class: 'sftp-state-title', text: '空目录' }),
          el('span', { class: 'sftp-state-message', text: '这里还没有文件，可以上传文件或新建文件夹。' })
        )
      )
      this.updateFooter()
      return
    }

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]
      const row = el(
        'div',
        {
          class: `sftp-row sftp-row-${entry.type}${this.selected.has(entry.path) ? ' is-selected' : ''}`,
          role: 'option',
          tabindex: '0',
          draggable: 'true',
          title: `${entry.path}\n拖到资源管理器或桌面可下载`,
          dataset: { path: entry.path, index: String(index) },
          'aria-selected': this.selected.has(entry.path) ? 'true' : 'false'
        },
        el('span', {
          class: 'sftp-row-icon',
          html: icon(entry.type === 'directory' ? 'folder' : entry.type === 'symlink' ? 'external' : 'file', 16)
        }),
        el(
          'span',
          { class: 'sftp-row-main' },
          el('span', { class: 'sftp-row-name', text: entry.name }),
          entry.type === 'symlink' ? el('span', { class: 'sftp-row-badge', text: '链接' }) : null
        ),
        el('span', { class: 'sftp-col-size', text: entry.type === 'directory' ? '—' : formatSize(entry.size) }),
        el('span', { class: 'sftp-col-time', text: formatDate(entry.mtime) })
      )
      row.addEventListener('click', (event) => this.selectEntry(index, event as MouseEvent))
      row.addEventListener('dragstart', (event) => this.startDragOut(event, index))
      row.addEventListener('dblclick', () => {
        if (entry.type === 'directory' || entry.type === 'symlink') void this.navigate(entry.path)
        else {
          this.selectOnly(index)
          void this.download()
        }
      })
      row.addEventListener('keydown', (event) => this.handleRowKey(event, index))
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!this.selected.has(entry.path)) this.selectOnly(index)
        this.showEntryMenu(entry, event.clientX, event.clientY)
      })
      this.listContainer.appendChild(row)
    }
    this.updateFooter()
    this.updateActions()
  }

  private startDragOut(event: DragEvent, index: number): void {
    if (!this.session || !this.connected) {
      event.preventDefault()
      return
    }
    const entry = this.entries[index]
    if (!entry) {
      event.preventDefault()
      return
    }
    if (!this.selected.has(entry.path)) {
      this.selectOnly(index)
      this.updateSelection()
    }
    const entries = this.selectedEntries()
    if (entries.length === 0) {
      event.preventDefault()
      return
    }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData('text/plain', entries.map((value) => value.name).join('\n'))
    }
    event.preventDefault()
    const items: DragDownloadItem[] = entries.map((value) => ({
      path: value.path,
      name: value.name,
      isDirectory: value.type === 'directory'
    }))
    let dragImage = ''
    try {
      dragImage = createDragPreview(items)
    } catch {
      // Fall back to the app icon if canvas rendering is unavailable.
    }
    void this.options.api
      .startDragDownload(this.session.id, items, dragImage)
      .catch((error) => this.options.toast.error(errorMessage(error), { title: '拖放下载失败' }))
  }

  private selectEntry(index: number, event: MouseEvent): void {
    const entry = this.entries[index]
    if (!entry) return
    if (event.shiftKey && this.selectionAnchor >= 0) {
      const start = Math.min(this.selectionAnchor, index)
      const end = Math.max(this.selectionAnchor, index)
      this.selected.clear()
      for (let cursor = start; cursor <= end; cursor += 1) this.selected.add(this.entries[cursor].path)
    } else if (event.ctrlKey || event.metaKey) {
      if (this.selected.has(entry.path)) this.selected.delete(entry.path)
      else this.selected.add(entry.path)
      this.selectionAnchor = index
    } else {
      this.selectOnly(index)
    }
    this.updateSelection()
  }

  private selectOnly(index: number): void {
    const entry = this.entries[index]
    if (!entry) return
    this.selected.clear()
    this.selected.add(entry.path)
    this.selectionAnchor = index
    this.updateSelection()
  }

  private updateSelection(): void {
    this.listContainer.querySelectorAll<HTMLElement>('.sftp-row').forEach((row) => {
      const path = row.dataset.path || ''
      row.classList.toggle('is-selected', this.selected.has(path))
      row.setAttribute('aria-selected', this.selected.has(path) ? 'true' : 'false')
    })
    this.updateFooter()
    this.updateActions()
  }

  private updateFooter(): void {
    if (!this.session) {
      this.footer.textContent = ''
      return
    }
    const selected = this.selected.size
    this.footer.replaceChildren(
      el('span', { text: `${this.entries.length} 项` }),
      el('span', { class: 'sftp-footer-sep' }),
      el('span', { text: selected > 0 ? `已选 ${selected} 项` : '未选择文件' }),
      el('span', { class: 'sftp-paste-hint', text: 'Ctrl+V / 拖入上传 · 拖出下载' }),
      el('span', { class: 'sftp-footer-spacer' }),
      el('span', { class: 'sftp-footer-path', text: this.currentPath || this.home || '—' })
    )
  }

  private updateActions(): void {
    const enabled = Boolean(this.session && this.connected && !this.loading)
    const hasSelection = enabled && this.selected.size > 0
    const selectedEntries = this.selectedEntries()
    this.uploadButton.disabled = !enabled
    this.uploadFolderButton.disabled = !enabled
    this.downloadButton.disabled = !hasSelection
    this.mkdirButton.disabled = !enabled
    this.renameButton.disabled = !hasSelection || selectedEntries.length !== 1
    this.deleteButton.disabled = !hasSelection
    this.refreshButton.disabled = !enabled
    this.upButton.disabled = !enabled || this.currentPath === '/'
    this.pathInput.disabled = !enabled
  }

  private selectedEntries(): SftpEntry[] {
    return this.entries.filter((entry) => this.selected.has(entry.path))
  }

  private handleListKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const rows = [...this.listContainer.querySelectorAll<HTMLElement>('.sftp-row')]
      if (rows.length === 0) return
      const current = rows.findIndex((row) => row.classList.contains('is-selected'))
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(rows.length - 1, Math.max(0, current + delta))
      this.selectOnly(next)
      rows[next]?.focus()
    }
  }

  private handleRowKey(event: KeyboardEvent, index: number): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      const entry = this.entries[index]
      if (!entry) return
      if (entry.type === 'directory') void this.navigate(entry.path)
      else void this.download()
    } else if (event.key === 'Delete') {
      event.preventDefault()
      void this.deleteSelected()
    }
  }

  private async goUp(): Promise<void> {
    if (!this.currentPath) return
    await this.navigate(parentRemote(this.currentPath))
  }

  private bindDropEvents(): void {
    const hasFileDrag = (event: DragEvent): boolean => {
      const types = Array.from(event.dataTransfer?.types ?? [])
      return types.includes('Files') || types.includes('text/uri-list')
    }
    const showDrop = (show: boolean) => {
      this.dropOverlay.hidden = !show
      this.element.classList.toggle('is-drag-over', show)
    }

    this.element.addEventListener('dragenter', (event) => {
      if (!hasFileDrag(event)) return
      event.preventDefault()
      this.dragDepth += 1
      showDrop(true)
    })
    this.element.addEventListener('dragover', (event) => {
      if (!hasFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    })
    this.element.addEventListener('dragleave', (event) => {
      if (!hasFileDrag(event)) return
      this.dragDepth = Math.max(0, this.dragDepth - 1)
      if (this.dragDepth === 0) showDrop(false)
    })
    this.element.addEventListener('drop', (event) => {
      if (!hasFileDrag(event)) return
      event.preventDefault()
      this.dragDepth = 0
      showDrop(false)
      void this.uploadDropped(event)
    })
    window.addEventListener('dragend', () => {
      this.dragDepth = 0
      showDrop(false)
    })
  }

  private extractDropPaths(dataTransfer: DataTransfer): string[] {
    const paths: string[] = []
    const seen = new Set<string>()
    const add = (value: string) => {
      let candidate = String(value || '').replace(/\0/g, '').trim()
      if (candidate.length >= 2 && /^".*"$/.test(candidate)) candidate = candidate.slice(1, -1)
      if (!candidate) return
      const key = candidate.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      paths.push(candidate)
    }
    for (const file of Array.from(dataTransfer.files ?? [])) {
      try {
        const filePath = this.options.api.getPathForFile(file)
        if (filePath) add(filePath)
      } catch {
        // Fall through to URI/text paths.
      }
    }
    for (const line of (dataTransfer.getData('text/uri-list') || '').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      try {
        const url = new URL(line)
        if (url.protocol !== 'file:') continue
        let pathname = decodeURIComponent(url.pathname)
        if (/^\/[A-Za-z]:\//.test(pathname)) {
          add(pathname.slice(1).replace(/\//g, '\\'))
        } else if (url.host) {
          add(`\\\\${url.host}${pathname.replace(/\//g, '\\')}`)
        } else {
          add(pathname)
        }
      } catch {
        // Ignore malformed URI entries.
      }
    }
    for (const line of (dataTransfer.getData('text/plain') || '').split(/\r?\n/)) {
      add(line)
    }
    return paths
  }

  private async uploadDropped(event: DragEvent): Promise<void> {
    if (!this.session || !this.connected) {
      this.options.toast.warning('请先打开一个已连接的会话')
      return
    }
    const paths = this.extractDropPaths(event.dataTransfer as DataTransfer)
    if (paths.length === 0) {
      this.options.toast.warning('没有识别到可上传的文件或文件夹')
      return
    }
    try {
      await this.startUpload(paths, false)
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '拖放上传失败' })
    }
  }

  private handlePanelKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    if (event.key.toLowerCase() !== 'v') return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    event.preventDefault()
    void this.pasteFromClipboard()
  }

  private async pasteFromClipboard(): Promise<void> {
    if (!this.session || !this.connected) {
      this.options.toast.warning('请先打开一个已连接的会话')
      return
    }
    try {
      const paths = await this.options.api.readClipboardFiles()
      if (paths.length === 0) {
        this.options.toast.info('剪贴板中没有可上传的文件或文件夹')
        return
      }
      await this.startUpload(paths, false)
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '粘贴上传失败' })
    }
  }

  private async upload(): Promise<void> {
    if (!this.session || !this.connected) {
      this.options.toast.warning('请先打开一个已连接的会话')
      return
    }
    try {
      const files = await this.options.api.pickFiles()
      if (!files || files.length === 0) return
      await this.startUpload(files, false)
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '上传失败' })
    }
  }

  private async uploadFolders(): Promise<void> {
    if (!this.session || !this.connected) {
      this.options.toast.warning('请先打开一个已连接的会话')
      return
    }
    try {
      const folders = await this.options.api.pickUploadFolders()
      if (!folders || folders.length === 0) return
      await this.startUpload(folders, false)
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '上传文件夹失败' })
    }
  }

  private async startUpload(files: string[], overwrite: boolean): Promise<void> {
    if (!this.session) return
    const result: SftpStartResult = await this.options.api.sftpUpload({
      sessionId: this.session.id,
      localPaths: files,
      remoteDir: this.currentPath,
      overwrite
    })
    if (!result.started) {
      const confirmed = await this.options.modal.confirm({
        title: '覆盖同名文件',
        message: `远端目录已有 ${result.conflicts.length} 个同名文件，是否覆盖？`,
        detail: result.conflicts.slice(0, 10).join('、') + (result.conflicts.length > 10 ? ' …' : ''),
        confirmText: '覆盖并上传',
        danger: true
      })
      if (confirmed) await this.startUpload(files, true)
      return
    }
    if (result.transfers.length === 0) {
      this.options.toast.success('远端文件夹已创建')
    } else {
      this.options.toast.success(`已开始上传 ${result.transfers.length} 个文件`)
    }
    this.refresh()
  }

  private async download(): Promise<void> {
    if (!this.session || !this.connected) {
      this.options.toast.warning('请先打开一个已连接的会话')
      return
    }
    const entries = this.selectedEntries()
    if (entries.length === 0) {
      this.options.toast.warning('请先选择要下载的文件或文件夹')
      return
    }
    try {
      const localDir = await this.options.api.pickDownloadDirectory()
      if (!localDir) return
      await this.startDownload(entries.map((entry) => entry.path), localDir, false)
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '下载失败' })
    }
  }

  private async startDownload(remotePaths: string[], localDir: string, overwrite: boolean): Promise<void> {
    if (!this.session) return
    const result = await this.options.api.sftpDownload({
      sessionId: this.session.id,
      remotePaths,
      localDir,
      overwrite
    })
    if (!result.started) {
      const confirmed = await this.options.modal.confirm({
        title: '覆盖本地文件',
        message: `本地目录已有 ${result.conflicts.length} 个同名文件，是否覆盖？`,
        detail: result.conflicts.slice(0, 10).join('、') + (result.conflicts.length > 10 ? ' …' : ''),
        confirmText: '覆盖并下载',
        danger: true
      })
      if (confirmed) await this.startDownload(remotePaths, localDir, true)
      return
    }
    if (result.transfers.length === 0) {
      this.options.toast.success('本地文件夹已创建')
    } else {
      this.options.toast.success(`已开始下载 ${result.transfers.length} 个文件`)
    }
  }

  private async createFolder(): Promise<void> {
    if (!this.session || !this.connected) return
    const name = await askFolderName(this.options.modal, {
      title: '新建远端文件夹',
      subtitle: this.currentPath,
      initial: '',
      placeholder: '文件夹名称'
    })
    if (!name) return
    try {
      await this.options.api.sftpMkdir(this.session.id, joinRemote(this.currentPath, name))
      await this.refresh()
      this.options.toast.success(`已创建文件夹“${name}”`)
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '新建文件夹失败' })
    }
  }

  private async renameSelected(): Promise<void> {
    if (!this.session || !this.connected) return
    const entries = this.selectedEntries()
    if (entries.length !== 1) return
    const entry = entries[0]
    const name = await askFolderName(this.options.modal, {
      title: '重命名',
      subtitle: this.currentPath,
      initial: entry.name,
      placeholder: '新名称'
    })
    if (!name || name === entry.name) return
    try {
      await this.options.api.sftpRename(
        this.session.id,
        entry.path,
        joinRemote(parentRemote(entry.path), name)
      )
      await this.refresh()
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '重命名失败' })
    }
  }

  private async deleteSelected(): Promise<void> {
    if (!this.session || !this.connected) return
    const entries = this.selectedEntries()
    if (entries.length === 0) return
    const hasDirectory = entries.some((entry) => entry.type === 'directory')
    const confirmed = await this.options.modal.confirm({
      title: '删除远端项目',
      message: `确定删除选中的 ${entries.length} 项吗？`,
      detail:
        (entries.slice(0, 8).map((entry) => entry.name).join('、') +
          (entries.length > 8 ? ' …' : '')) +
        (hasDirectory
          ? '\n文件夹及其中的所有内容会被递归删除，此操作不可撤销。'
          : '\n此操作不可撤销。'),
      confirmText: hasDirectory ? '递归删除' : '删除',
      danger: true
    })
    if (!confirmed) return
    try {
      for (const entry of entries) {
        await this.options.api.sftpRemove(
          this.session.id,
          entry.path,
          entry.type === 'directory'
        )
      }
      await this.refresh()
      this.options.toast.success('已删除选中项')
    } catch (error) {
      this.options.toast.error(errorMessage(error), { title: '删除失败' })
    }
  }

  private showEntryMenu(entry: SftpEntry, x: number, y: number): void {
    const items = entry.type === 'directory'
      ? [
          {
            label: '打开文件夹',
            icon: 'folderOpen',
            action: () => void this.navigate(entry.path)
          },
          {
            label: '下载文件夹（递归）',
            icon: 'download',
            action: () => void this.download()
          }
        ]
      : [
          {
            label: '下载',
            icon: 'download',
            action: () => void this.download()
          }
        ]
    showContextMenu(
      [
        ...items,
        { separator: true },
        {
          label: '重命名',
          icon: 'edit',
          disabled: this.selected.size !== 1,
          action: () => void this.renameSelected()
        },
        {
          label: '删除',
          icon: 'trash',
          danger: true,
          action: () => void this.deleteSelected()
        },
        { separator: true },
        {
          label: '复制远端路径',
          icon: 'clipboard',
          action: () => {
            this.options.api.clipboardWrite(entry.path)
            this.options.toast.success('路径已复制')
          }
        }
      ],
      x,
      y
    )
  }

  private renderTransfers(): void {
    const visible = [...this.transfers.values()].filter(
      (transfer) => transfer.sessionId === this.sessionId
    )
    const active = visible.filter(
      (transfer) => transfer.status === 'queued' || transfer.status === 'running'
    )
    this.transferCount.textContent = active.length > 0 ? `${active.length} 个进行中` : ''
    this.transferSection.hidden = visible.length === 0
    clear(this.transferList)
    this.transferElements.clear()
    for (const transfer of visible.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      this.transferList.appendChild(this.createTransferElement(transfer))
    }
    if (visible.length === 0) {
      this.transferSection.hidden = true
    }
  }

  private createTransferElement(transfer: TransferView): HTMLElement {
    const progress = el('span', { class: 'sftp-transfer-progress' })
    const bar = el('span', { class: 'sftp-transfer-bar' })
    progress.appendChild(bar)
    const meta = el('span', { class: 'sftp-transfer-meta' })
    const percent = el('span', { class: 'sftp-transfer-percent' })
    const action = el('button', {
      class: 'icon-btn small',
      type: 'button',
      title: '取消传输',
      html: icon('close', 14)
    })
    const root = el(
      'div',
      { class: `sftp-transfer is-${transfer.status}`, dataset: { transferId: transfer.id } },
      el('span', { class: 'sftp-transfer-icon', html: icon(transfer.direction === 'upload' ? 'upload' : 'download', 15) }),
      el(
        'div',
        { class: 'sftp-transfer-main' },
        el(
          'div',
          { class: 'sftp-transfer-line' },
          el('span', { class: 'sftp-transfer-name', text: transfer.name, title: transfer.remotePath }),
          percent
        ),
        progress,
        meta
      ),
      action
    )
    action.addEventListener('click', () => {
      if (transfer.status === 'done' && transfer.direction === 'download') {
        void this.options.api.openLocalPath(transfer.localPath)
      } else if (transfer.status === 'queued' || transfer.status === 'running') {
        void this.options.api.sftpCancel(transfer.id)
      }
    })
    const dom: TransferDom = { root, bar, percent, meta, action, transfer }
    this.transferElements.set(transfer.id, dom)
    this.updateTransferElement(dom)
    return root
  }

  private updateTransferElement(dom: TransferDom): void {
    const { transfer } = dom
    const percent =
      transfer.status === 'queued'
        ? 0
        : transfer.total > 0
          ? transfer.percent
          : transfer.status === 'done'
            ? 100
            : 0
    dom.bar.style.width = `${Math.max(0, Math.min(100, percent))}%`
    dom.percent.textContent = `${Math.round(percent)}%`
    dom.root.className = `sftp-transfer is-${transfer.status}`
    if (transfer.status === 'queued') {
      dom.meta.textContent = `${transfer.resumed ? '续传排队' : '等待中'} · ${formatSize(transfer.total)}`
    } else if (transfer.status === 'running') {
      dom.meta.textContent = `${transfer.resumed ? '续传中' : '传输中'} · ${formatSize(
        transfer.transferred
      )} / ${formatSize(transfer.total)}`
    } else if (transfer.status === 'done') {
      dom.meta.textContent = `${transfer.resumed ? '续传完成' : '已完成'} · ${formatSize(transfer.total)}`
    } else if (transfer.status === 'error') {
      dom.meta.textContent = transfer.error || '传输失败'
    } else {
      dom.meta.textContent = transfer.resumed ? '已取消，断点已保留' : '已取消'
    }
    if (transfer.status === 'done' && transfer.direction === 'download') {
      dom.action.innerHTML = icon('external', 14)
      dom.action.title = '在文件夹中显示'
      dom.action.hidden = false
    } else if (transfer.status === 'queued' || transfer.status === 'running') {
      dom.action.innerHTML = icon('close', 14)
      dom.action.title = '取消传输'
      dom.action.hidden = false
    } else {
      dom.action.hidden = true
    }
  }

  private clearFinishedTransfers(): void {
    for (const [id, transfer] of this.transfers) {
      if (transfer.status === 'done' || transfer.status === 'error' || transfer.status === 'canceled') {
        this.transfers.delete(id)
      }
    }
    this.renderTransfers()
  }

  private updateTransferList(): void {
    const visible = [...this.transfers.values()].filter(
      (transfer) => transfer.sessionId === this.sessionId
    )
    this.transferSection.hidden = visible.length === 0
    const active = visible.filter(
      (transfer) => transfer.status === 'queued' || transfer.status === 'running'
    )
    this.transferCount.textContent = active.length > 0 ? `${active.length} 个进行中` : ''
    for (const transfer of visible) {
      let dom = this.transferElements.get(transfer.id)
      if (!dom) {
        this.transferList.appendChild(this.createTransferElement(transfer))
        dom = this.transferElements.get(transfer.id)
      }
      if (dom) {
        dom.transfer = transfer
        this.updateTransferElement(dom)
      }
    }
  }

  private iconButton(title: string, iconName: string, onClick: () => void): HTMLButtonElement {
    return el(
      'button',
      {
        class: 'icon-btn small sftp-icon-button',
        type: 'button',
        title,
        'aria-label': title,
        html: icon(iconName, 15),
        onclick: onClick
      },
      null
    )
  }

  private actionButton(
    label: string,
    iconName: string,
    title: string,
    onClick: () => void
  ): HTMLButtonElement {
    return el(
      'button',
      {
        class: 'sftp-action-button',
        type: 'button',
        title,
        onclick: onClick
      },
      el('span', { class: 'sftp-action-icon', html: icon(iconName, 15) }),
      el('span', { text: label })
    )
  }
}

interface TransferDom {
  root: HTMLElement
  bar: HTMLElement
  percent: HTMLElement
  meta: HTMLElement
  action: HTMLButtonElement
  transfer: TransferView
}

function parentRemote(path: string): string {
  if (!path || path === '/') return '/'
  const normalized = path.replace(/\/+$/g, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}

function joinRemote(directory: string, name: string): string {
  if (!directory || directory === '/') return `/${name}`
  return `${directory.replace(/\/+$/g, '')}/${name}`
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${FILE_SIZE_UNITS[unit]}`
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const pad = (value: number) => String(value).padStart(2, '0')
  if (sameYear) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
