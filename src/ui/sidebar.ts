import type { AppState, Connection, Folder, HongSshApi } from '../types'
import { clear, el } from '../ui/dom'
import { icon } from '../ui/icons'
import type { ModalHost } from '../ui/modal'
import type { ToastHost } from '../ui/toast'
import { askFolderName, folderPathLabel, showShortcutsDialog } from '../dialogs/misc'
import { showContextMenu } from '../ui/context-menu'

interface SidebarOptions {
  api: HongSshApi
  modal: ModalHost
  toast: ToastHost
  getState: () => AppState
  onState: (state: AppState) => void
  onOpenConnection: (connection: Connection) => void
  onEditConnection: (connection: Connection) => void
  onNewConnection: (folderId: string | null) => void
  onNewRemoteConnection: (folderId: string | null) => void
  onDuplicateConnection: (connection: Connection) => void
  onTestConnection: (connection: Connection) => void
  onDeleteConnection: (connection: Connection) => void
  onImport: () => void
  isConnectionOpen: (connectionId: string) => boolean
  getActiveConnectionId: () => string | null
}

export class Sidebar {
  readonly element: HTMLElement
  private readonly options: SidebarOptions
  private readonly searchInput: HTMLInputElement
  private readonly treeContainer: HTMLElement
  private readonly footerCount: HTMLElement
  private query = ''
  private selectedFolderId: string | null = null
  private readonly selectedFolders = new Set<string>()
  private readonly selectedConnections = new Set<string>()
  private selectionAnchor: { kind: 'folder' | 'connection'; id: string } | null = null
  private dragSelection: { folderIds: string[]; connectionIds: string[] } | null = null
  private suppressClick = false

  constructor(options: SidebarOptions) {
    this.options = options
    this.element = el('aside', { class: 'sidebar', 'aria-label': '连接列表' })
    this.searchInput = el('input', {
      class: 'sidebar-search-input',
      type: 'search',
      placeholder: '搜索连接、主机或用户名',
      spellcheck: false,
      'aria-label': '搜索连接'
    })
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim().toLowerCase()
      this.clearSelection()
      this.renderTree()
    })
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.searchInput.value = ''
        this.query = ''
        this.clearSelection()
        this.renderTree()
        this.searchInput.blur()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        this.treeContainer.querySelector<HTMLElement>('.tree-row')?.focus()
      }
    })

    const search = el(
      'div',
      { class: 'sidebar-search' },
      el('span', { class: 'sidebar-search-icon', html: icon('search', 15) }),
      this.searchInput,
      el(
        'button',
        {
          class: 'sidebar-search-clear',
          type: 'button',
          title: '清除搜索',
          html: icon('close', 13),
          onclick: () => {
            this.searchInput.value = ''
            this.query = ''
            this.clearSelection()
            this.renderTree()
            this.searchInput.focus()
          }
        },
        null
      )
    )

    this.treeContainer = el('div', {
      class: 'connection-tree',
      role: 'tree',
      'aria-label': '连接',
      'aria-multiselectable': 'true',
      tabindex: '-1'
    })
    this.treeContainer.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.tree-row')) return
      this.clearSelection()
    })
    this.treeContainer.addEventListener('contextmenu', (event) => {
      if ((event.target as HTMLElement).closest('.tree-row')) return
      event.preventDefault()
      this.clearSelection()
      this.showBlankMenu(event.clientX, event.clientY)
    })
    this.bindRootDropTarget()
    this.treeContainer.addEventListener('dragover', (event) => this.autoScroll(event))
    this.treeContainer.addEventListener('mousedown', (event) => {
      if (event.button === 0) this.suppressClick = false
    })

    this.footerCount = el('span', { class: 'sidebar-footer-count' })
    const footer = el(
      'footer',
      { class: 'sidebar-footer' },
      this.footerCount,
      el(
        'button',
        {
          class: 'sidebar-footer-link',
          type: 'button',
          title: '快捷键 (F1)',
          html: `${icon('keyboard', 13)}<span>快捷键</span>`,
          onclick: () => showShortcutsDialog(this.options.modal)
        },
        null
      )
    )

    this.element.append(search, this.treeContainer, footer)
    this.render()
  }

  render(): void {
    this.renderTree()
    this.renderFooter()
  }

  setActiveConnection(_connectionId: string | null): void {
    const activeId = this.options.getActiveConnectionId()
    this.treeContainer.querySelectorAll<HTMLElement>('.tree-connection').forEach((row) => {
      row.classList.toggle('is-active', row.dataset.connectionId === activeId)
    })
  }

  getNewConnectionFolderId(): string | null {
    return this.newConnectionFolderId()
  }

  createGroupFromSelection(): void {
    void this.createFolder(this.newConnectionFolderId())
  }

  refreshStatus(): void {
    const activeId = this.options.getActiveConnectionId()
    this.treeContainer.querySelectorAll<HTMLElement>('.tree-connection').forEach((row) => {
      const connectionId = row.dataset.connectionId ?? ''
      row.classList.toggle('is-active', connectionId === activeId)
      row.classList.toggle('is-open', this.options.isConnectionOpen(connectionId))
    })
    this.renderFooter()
  }

  focusSearch(): void {
    this.searchInput.focus()
    this.searchInput.select()
  }

  private handleRowClick(
    event: MouseEvent,
    kind: 'folder' | 'connection',
    id: string
  ): void {
    if (this.suppressClick) {
      this.suppressClick = false
      return
    }
    if ((event.target as HTMLElement).closest('.tree-caret')) return
    if (event.shiftKey) {
      this.selectRange(kind, id)
      return
    }
    if (event.ctrlKey || event.metaKey) this.toggleSelection(kind, id)
    else this.selectOnly(kind, id)
  }

  private selectOnly(kind: 'folder' | 'connection', id: string): void {
    this.selectedFolders.clear()
    this.selectedConnections.clear()
    if (kind === 'folder') {
      this.selectedFolders.add(id)
      this.selectedFolderId = id
    } else {
      this.selectedConnections.add(id)
      this.selectedFolderId = null
    }
    this.selectionAnchor = { kind, id }
    this.applySelectionClasses()
  }

  private selectRange(kind: 'folder' | 'connection', id: string): void {
    const anchor = this.selectionAnchor
    if (!anchor) {
      this.selectOnly(kind, id)
      return
    }
    const rows = [...this.treeContainer.querySelectorAll<HTMLElement>('.tree-row')]
    const targetIndex = rows.findIndex((row) => this.rowMatches(row, kind, id))
    const anchorIndex = rows.findIndex((row) => this.rowMatches(row, anchor.kind, anchor.id))
    if (targetIndex < 0) return
    if (anchorIndex < 0) {
      this.selectOnly(kind, id)
      return
    }
    this.selectedFolders.clear()
    this.selectedConnections.clear()
    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)
    for (let index = start; index <= end; index += 1) {
      const row = rows[index]
      const folderId = row.dataset.folderId
      const connectionId = row.dataset.connectionId
      if (folderId) this.selectedFolders.add(folderId)
      else if (connectionId) this.selectedConnections.add(connectionId)
    }
    this.selectedFolderId = kind === 'folder' ? id : null
    this.applySelectionClasses()
  }

  private rowMatches(
    row: HTMLElement,
    kind: 'folder' | 'connection',
    id: string
  ): boolean {
    return kind === 'folder' ? row.dataset.folderId === id : row.dataset.connectionId === id
  }

  private toggleSelection(kind: 'folder' | 'connection', id: string): void {
    if (kind === 'folder') {
      if (this.selectedFolders.has(id)) {
        this.selectedFolders.delete(id)
        if (this.selectedFolderId === id) {
          this.selectedFolderId = [...this.selectedFolders].at(-1) ?? null
        }
      } else {
        this.selectedFolders.add(id)
        this.selectedFolderId = id
      }
    } else if (this.selectedConnections.has(id)) {
      this.selectedConnections.delete(id)
    } else {
      this.selectedConnections.add(id)
    }
    this.selectionAnchor = { kind, id }
    this.applySelectionClasses()
  }

  private clearSelection(): void {
    this.selectedFolders.clear()
    this.selectedConnections.clear()
    this.selectedFolderId = null
    this.selectionAnchor = null
    this.applySelectionClasses()
  }

  private applySelectionClasses(): void {
    this.treeContainer.querySelectorAll<HTMLElement>('.tree-row').forEach((row) => {
      const selected = row.dataset.folderId
        ? this.selectedFolders.has(row.dataset.folderId)
        : row.dataset.connectionId
          ? this.selectedConnections.has(row.dataset.connectionId)
          : false
      row.classList.toggle('is-selected', selected)
      row.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
  }

  private isSelected(kind: 'folder' | 'connection', id: string): boolean {
    return kind === 'folder' ? this.selectedFolders.has(id) : this.selectedConnections.has(id)
  }

  private pruneSelection(state: AppState): void {
    const folderIds = new Set(state.folders.map((folder) => folder.id))
    const connectionIds = new Set(state.connections.map((connection) => connection.id))
    for (const id of [...this.selectedFolders]) {
      if (!folderIds.has(id)) this.selectedFolders.delete(id)
    }
    for (const id of [...this.selectedConnections]) {
      if (!connectionIds.has(id)) this.selectedConnections.delete(id)
    }
    if (this.selectedFolderId && !this.selectedFolders.has(this.selectedFolderId)) {
      this.selectedFolderId = [...this.selectedFolders].at(-1) ?? null
    }
    if (this.selectionAnchor) {
      const exists =
        this.selectionAnchor.kind === 'folder'
          ? folderIds.has(this.selectionAnchor.id)
          : connectionIds.has(this.selectionAnchor.id)
      if (!exists) this.selectionAnchor = null
    }
  }

  private normalizedSelection(): { folderIds: string[]; connectionIds: string[] } {
    const state = this.options.getState()
    const byId = new Map(state.folders.map((folder) => [folder.id, folder]))
    const selectedFolders = state.folders.filter((folder) => this.selectedFolders.has(folder.id))
    const roots = selectedFolders.filter((folder) => {
      const guard = new Set<string>()
      let current = folder.parentId
      while (current && !guard.has(current)) {
        guard.add(current)
        if (this.selectedFolders.has(current)) return false
        current = byId.get(current)?.parentId ?? null
      }
      return true
    })
    const movingFolderIds = new Set(roots.map((folder) => folder.id))
    const connectionIds = state.connections
      .filter((connection) => this.selectedConnections.has(connection.id))
      .filter((connection) => {
        const guard = new Set<string>()
        let current = connection.folderId
        while (current && !guard.has(current)) {
          guard.add(current)
          if (movingFolderIds.has(current)) return false
          current = byId.get(current)?.parentId ?? null
        }
        return true
      })
      .map((connection) => connection.id)
    return { folderIds: roots.map((folder) => folder.id), connectionIds }
  }

  private bindRowDrag(
    row: HTMLElement,
    kind: 'folder' | 'connection',
    id: string
  ): void {
    row.addEventListener('dragstart', (event) => this.beginRowDrag(event, kind, id))
    row.addEventListener('dragend', () => this.finishDrag())
  }

  private beginRowDrag(
    event: DragEvent,
    kind: 'folder' | 'connection',
    id: string
  ): void {
    if ((event.target as HTMLElement).closest('.tree-caret')) {
      event.preventDefault()
      return
    }
    if (!this.isSelected(kind, id)) this.selectOnly(kind, id)
    const selection = this.normalizedSelection()
    if (selection.folderIds.length === 0 && selection.connectionIds.length === 0) {
      event.preventDefault()
      return
    }
    this.dragSelection = selection
    this.suppressClick = true
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', 'hongssh-tree-item')
    }
    this.treeContainer.classList.add('is-drag-active')
    this.treeContainer
      .querySelectorAll<HTMLElement>('.tree-row.is-selected')
      .forEach((row) => row.classList.add('is-dragging'))
  }

  private finishDrag(): void {
    this.dragSelection = null
    this.clearDropHints()
    this.treeContainer.classList.remove('is-drag-active')
    this.treeContainer
      .querySelectorAll<HTMLElement>('.is-dragging')
      .forEach((row) => row.classList.remove('is-dragging'))
  }

  private autoScroll(event: DragEvent): void {
    if (!this.dragSelection) return
    const rect = this.treeContainer.getBoundingClientRect()
    const edge = 36
    if (event.clientY < rect.top + edge) {
      this.treeContainer.scrollTop -= 14
    } else if (event.clientY > rect.bottom - edge) {
      this.treeContainer.scrollTop += 14
    }
  }

  private clearDropHints(): void {
    this.treeContainer.classList.remove('is-drop-root')
    this.treeContainer
      .querySelectorAll<HTMLElement>('.is-drop-target, .is-drop-before, .is-drop-after')
      .forEach((row) => row.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after'))
  }

  private bindFolderDropTarget(row: HTMLElement, folder: Folder): void {
    const positionFor = (event: DragEvent): 'before' | 'after' | 'into' => {
      const rect = row.getBoundingClientRect()
      const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
      const raw = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'into'
      // Connections cannot be placed between folders in this tree; dropping a
      // connection anywhere on a folder moves it into that folder.
      if (raw !== 'into' && (this.dragSelection?.folderIds.length ?? 0) === 0) return 'into'
      return raw
    }
    row.addEventListener('dragover', (event) => {
      if (!this.dragSelection) return
      const position = positionFor(event)
      if (!this.canDropOnFolder(folder, position)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      this.clearDropHints()
      row.classList.add(
        position === 'into'
          ? 'is-drop-target'
          : position === 'before'
            ? 'is-drop-before'
            : 'is-drop-after'
      )
    })
    row.addEventListener('dragleave', (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && row.contains(next)) return
      row.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after')
    })
    row.addEventListener('drop', (event) => {
      if (!this.dragSelection) return
      const position = positionFor(event)
      event.preventDefault()
      event.stopPropagation()
      row.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after')
      if (!this.canDropOnFolder(folder, position)) return
      const selection = this.dragSelection
      this.finishDrag()
      if (position === 'into') {
        void this.confirmMove(folder.id, selection)
      } else {
        void this.confirmMove(folder.parentId ?? null, selection, undefined, {
          folderId: folder.id,
          position
        })
      }
    })
  }

  private canDropOnFolder(folder: Folder, position: 'before' | 'after' | 'into'): boolean {
    const drag = this.dragSelection
    if (!drag) return false
    if (position === 'into') return this.canDropInto(folder.id)
    if (drag.folderIds.includes(folder.id)) return false
    return this.canDropInto(folder.parentId ?? null)
  }

  private bindConnectionDropTarget(row: HTMLElement, connection: Connection): void {
    const positionFor = (event: DragEvent): 'before' | 'after' => {
      const rect = row.getBoundingClientRect()
      return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    }
    row.addEventListener('dragover', (event) => {
      if (!this.dragSelection || !this.canDropAtConnection(connection)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      this.clearDropHints()
      row.classList.add(positionFor(event) === 'before' ? 'is-drop-before' : 'is-drop-after')
    })
    row.addEventListener('dragleave', (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && row.contains(next)) return
      row.classList.remove('is-drop-before', 'is-drop-after')
    })
    row.addEventListener('drop', (event) => {
      if (!this.dragSelection) return
      const position = positionFor(event)
      event.preventDefault()
      event.stopPropagation()
      row.classList.remove('is-drop-before', 'is-drop-after')
      if (!this.canDropAtConnection(connection)) return
      const selection = this.dragSelection
      this.finishDrag()
      void this.confirmMove(connection.folderId ?? null, selection, {
        connectionId: connection.id,
        position
      })
    })
  }

  private canDropAtConnection(connection: Connection): boolean {
    const drag = this.dragSelection
    if (!drag || drag.connectionIds.length === 0) return false
    if (drag.connectionIds.includes(connection.id)) return false
    return this.canDropInto(connection.folderId ?? null)
  }

  private bindRootDropTarget(): void {
    this.treeContainer.addEventListener('dragover', (event) => {
      if (!this.dragSelection) return
      if ((event.target as HTMLElement).closest('.tree-row')) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      this.clearDropHints()
      this.treeContainer.classList.add('is-drop-root')
    })
    this.treeContainer.addEventListener('dragleave', (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && this.treeContainer.contains(next)) return
      this.treeContainer.classList.remove('is-drop-root')
    })
    this.treeContainer.addEventListener('drop', (event) => {
      if (!this.dragSelection) return
      if ((event.target as HTMLElement).closest('.tree-row')) return
      event.preventDefault()
      this.treeContainer.classList.remove('is-drop-root')
      const selection = this.dragSelection
      this.finishDrag()
      void this.confirmMove(null, selection)
    })
  }

  private canDropInto(targetFolderId: string | null): boolean {
    const drag = this.dragSelection
    if (!drag) return false
    if (!targetFolderId) return true
    if (drag.folderIds.includes(targetFolderId)) return false
    const byId = new Map(this.options.getState().folders.map((folder) => [folder.id, folder]))
    for (const folderId of drag.folderIds) {
      const guard = new Set<string>()
      let current: string | null = targetFolderId
      while (current && !guard.has(current)) {
        if (current === folderId) return false
        guard.add(current)
        current = byId.get(current)?.parentId ?? null
      }
    }
    return true
  }

  private async confirmMove(
    targetFolderId: string | null,
    selection: { folderIds: string[]; connectionIds: string[] },
    anchor?: { connectionId: string; position: 'before' | 'after' },
    folderAnchor?: { folderId: string; position: 'before' | 'after' }
  ): Promise<void> {
    const state = this.options.getState()
    const folders = selection.folderIds
      .map((id) => state.folders.find((folder) => folder.id === id))
      .filter((folder): folder is Folder => Boolean(folder))
    const connections = selection.connectionIds
      .map((id) => state.connections.find((connection) => connection.id === id))
      .filter((connection): connection is Connection => Boolean(connection))
    const movingFolders = folders.filter(
      (folder) => (folder.parentId ?? null) !== targetFolderId || Boolean(folderAnchor)
    )
    const movingConnections = connections.filter(
      (connection) => (connection.folderId ?? null) !== targetFolderId || Boolean(anchor)
    )
    if (movingFolders.length === 0 && movingConnections.length === 0) {
      this.options.toast.info('所选项目已经在该目录中')
      return
    }

    const anchorConnection =
      anchor && movingConnections.length > 0
        ? state.connections.find((connection) => connection.id === anchor.connectionId) ?? null
        : null
    const anchorFolder =
      folderAnchor && movingFolders.length > 0
        ? state.folders.find((folder) => folder.id === folderAnchor.folderId) ?? null
        : null
    const destination = folderPathLabel(targetFolderId, state.folders)
    const parts: string[] = []
    if (movingFolders.length > 0) parts.push(`${movingFolders.length} 个分组`)
    if (movingConnections.length > 0) parts.push(`${movingConnections.length} 个连接`)
    const names = [
      ...movingFolders.map((folder) => folder.name),
      ...movingConnections.map((connection) => connection.name)
    ]
    const detail =
      names.length > 6
        ? `${names.slice(0, 6).join('、')} 等 ${names.length} 项`
        : names.join('、')
    const positionLabel = anchorFolder && folderAnchor
      ? `，并放在“${anchorFolder.name}”${folderAnchor.position === 'before' ? '之前' : '之后'}`
      : anchorConnection && anchor
        ? `，并放在“${anchorConnection.name}”${anchor.position === 'before' ? '之前' : '之后'}`
        : ''
    const confirmed = await this.options.modal.confirm({
      title: '移动项目',
      message: `将 ${parts.join(' 和 ')}移动到“${destination}”${positionLabel}？`,
      detail,
      confirmText: '移动',
      cancelText: '取消'
    })
    if (!confirmed) return

    try {
      const next = await this.options.api.moveItems({
        folderIds: movingFolders.map((folder) => folder.id),
        connectionIds: movingConnections.map((connection) => connection.id),
        targetFolderId,
        anchorConnectionId: anchorConnection?.id ?? null,
        anchorPosition: anchor?.position,
        anchorFolderId: anchorFolder?.id ?? null,
        anchorFolderPosition: folderAnchor?.position
      })
      this.clearSelection()
      this.options.onState(next)
      this.render()
      this.options.toast.success(`已移动到“${destination}”`)
    } catch (error) {
      this.options.toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  private renderTree(): void {
    const state = this.options.getState()
    this.pruneSelection(state)
    clear(this.treeContainer)
    const folders = state.folders
    const connections = state.connections
    if (folders.length === 0 && connections.length === 0) {
      this.treeContainer.appendChild(this.emptyTree())
      return
    }

    const childrenFolders = new Map<string, Folder[]>()
    for (const folder of folders) {
      const key = folder.parentId ?? ''
      if (!childrenFolders.has(key)) childrenFolders.set(key, [])
      childrenFolders.get(key)?.push(folder)
    }
    for (const list of childrenFolders.values()) {
      list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN'))
    }
    const childrenConnections = new Map<string, Connection[]>()
    for (const connection of connections) {
      const key = connection.folderId ?? ''
      if (!childrenConnections.has(key)) childrenConnections.set(key, [])
      childrenConnections.get(key)?.push(connection)
    }
    for (const list of childrenConnections.values()) {
      list.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'zh-CN'))
    }

    const filter = this.query
    const matchingConnectionIds = new Set<string>()
    const matchingFolderIds = new Set<string>()
    if (filter) {
      for (const connection of connections) {
        const haystack = `${connection.name} ${connection.host} ${connection.username} ${connection.description}`.toLowerCase()
        if (haystack.includes(filter)) matchingConnectionIds.add(connection.id)
      }
      for (const folder of folders) {
        if (folder.name.toLowerCase().includes(filter)) matchingFolderIds.add(folder.id)
      }
      // A matching folder reveals all of its descendants.
      const revealDescendants = (folderId: string) => {
        for (const child of childrenFolders.get(folderId) ?? []) {
          matchingFolderIds.add(child.id)
          revealDescendants(child.id)
        }
        for (const child of childrenConnections.get(folderId) ?? []) matchingConnectionIds.add(child.id)
      }
      for (const folderId of [...matchingFolderIds]) revealDescendants(folderId)

      // Keep ancestors of every visible item.
      const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentId]))
      const addAncestors = (folderId: string | null) => {
        let current = folderId
        while (current) {
          matchingFolderIds.add(current)
          current = parentOf.get(current) ?? null
        }
      }
      for (const connection of connections) {
        if (matchingConnectionIds.has(connection.id)) addAncestors(connection.folderId)
      }
      for (const folderId of [...matchingFolderIds]) addAncestors(folderId)
    }

    const visibleConnections = connections.filter(
      (connection) => !filter || matchingConnectionIds.has(connection.id)
    )

    if (filter && ![...matchingFolderIds].length && visibleConnections.length === 0) {
      this.treeContainer.appendChild(
        el(
          'div',
          { class: 'tree-empty' },
          el('span', { class: 'tree-empty-icon', html: icon('search', 24) }),
          el('span', { class: 'tree-empty-title', text: '没有匹配的连接' }),
          el('span', { class: 'tree-empty-hint', text: `没有找到“${this.searchInput.value}”` }),
          el(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              text: '清除搜索',
              onclick: () => {
                this.searchInput.value = ''
                this.query = ''
                this.renderTree()
              }
            },
            null
          )
        )
      )
      return
    }

    const root = el('div', { class: 'tree-root' })
    const renderFolder = (folder: Folder, depth: number) => {
      const childFolders = (childrenFolders.get(folder.id) ?? []).filter(
        (child) => !filter || matchingFolderIds.has(child.id)
      )
      const childConnections = (childrenConnections.get(folder.id) ?? []).filter(
        (child) => !filter || matchingConnectionIds.has(child.id)
      )
      const expanded = filter ? true : folder.expanded
      const total = countConnections(folder.id, childrenFolders, childrenConnections)
      const row = el(
        'div',
        {
          class: `tree-row tree-folder${this.selectedFolders.has(folder.id) ? ' is-selected' : ''}`,
          role: 'treeitem',
          tabindex: '0',
          draggable: 'true',
          'data-folder-id': folder.id,
          'aria-selected': this.selectedFolders.has(folder.id) ? 'true' : 'false',
          'aria-expanded': expanded ? 'true' : 'false',
          style: { paddingLeft: `${8 + depth * 14}px` }
        },
        el(
          'button',
          {
            class: `tree-caret${expanded ? ' is-expanded' : ''}`,
            type: 'button',
            tabindex: '-1',
            'aria-label': expanded ? '折叠' : '展开',
            html: icon('chevronRight', 13)
          },
          null
        ),
        el('span', { class: 'tree-folder-icon', html: icon(expanded ? 'folderOpen' : 'folder', 16) }),
        el('span', { class: 'tree-name', text: folder.name }),
        el('span', { class: 'tree-count', text: String(total) })
      )
      row.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('.tree-caret')) return
        this.handleRowClick(event, 'folder', folder.id)
      })
      row.addEventListener('dblclick', () => void this.toggleFolder(folder))
      row.querySelector('.tree-caret')?.addEventListener('click', (event) => {
        event.stopPropagation()
        void this.toggleFolder(folder)
      })
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.selectOnly('folder', folder.id)
        this.showFolderMenu(folder, event.clientX, event.clientY)
      })
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void this.toggleFolder(folder)
        } else if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault()
          void this.toggleFolder(folder)
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault()
          void this.toggleFolder(folder)
        }
      })
      this.bindRowDrag(row, 'folder', folder.id)
      this.bindFolderDropTarget(row, folder)
      root.appendChild(row)
      if (!expanded) return
      for (const child of childFolders) renderFolder(child, depth + 1)
      for (const connection of childConnections) renderConnection(connection, depth + 1)
    }

    const renderConnection = (connection: Connection, depth: number) => {
      const activeId = this.options.getActiveConnectionId()
      const open = this.options.isConnectionOpen(connection.id)
      const row = el(
        'div',
        {
          class: `tree-row tree-connection${activeId === connection.id ? ' is-active' : ''}${open ? ' is-open' : ''}${this.selectedConnections.has(connection.id) ? ' is-selected' : ''}`,
          role: 'treeitem',
          tabindex: '0',
          draggable: 'true',
          'data-connection-id': connection.id,
          'aria-selected': this.selectedConnections.has(connection.id) ? 'true' : 'false',
          title:
            connection.connectionMode === 'webrtc'
              ? `WebRTC 中继 · ${connection.relayDeviceId || ''}`
              : `${connection.username}@${connection.host}:${connection.port}`,
          style: { paddingLeft: `${8 + depth * 14}px` }
        },
        el('span', {
          class: 'tree-connection-icon',
          style: { color: connection.color },
          html: icon(connection.protocol === 'remoteDesktop' ? 'layout' : 'terminal', 15)
        }),
        el(
          'span',
          { class: 'tree-connection-main' },
          el('span', { class: 'tree-name', text: connection.name }),
          el('span', {
            class: 'tree-sub',
            text:
              connection.connectionMode === 'webrtc'
                ? `中继 · ${connection.relayDeviceId || '未设置设备码'}`
                : connection.protocol === 'remoteDesktop'
                  ? `${connection.host}:${connection.port}`
                  : `${connection.username}@${connection.host}${connection.port !== 22 ? `:${connection.port}` : ''}`
          })
        ),
        connection.protocol !== 'remoteDesktop' &&
        connection.authType === 'password' &&
        !connection.hasPassword
          ? el('span', { class: 'tree-lock', title: '尚未保存密码', html: icon('lock', 12) })
          : null,
        open ? el('span', { class: 'tree-open-dot', title: '会话已打开' }) : null
      )
      row.addEventListener('click', (event) => this.handleRowClick(event, 'connection', connection.id))
      row.addEventListener('dblclick', () => this.options.onOpenConnection(connection))
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          this.options.onOpenConnection(connection)
        }
      })
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.selectOnly('connection', connection.id)
        this.showConnectionMenu(connection, event.clientX, event.clientY)
      })
      this.bindRowDrag(row, 'connection', connection.id)
      this.bindConnectionDropTarget(row, connection)
      root.appendChild(row)
    }

    for (const folder of childrenFolders.get('') ?? []) {
      if (!filter || matchingFolderIds.has(folder.id)) renderFolder(folder, 0)
    }
    for (const connection of childrenConnections.get('') ?? []) {
      if (!filter || matchingConnectionIds.has(connection.id)) renderConnection(connection, 0)
    }
    this.treeContainer.appendChild(root)
  }

  private emptyTree(): HTMLElement {
    return el(
      'div',
      { class: 'tree-empty' },
      el('span', { class: 'tree-empty-icon', html: icon('server', 26) }),
      el('span', { class: 'tree-empty-title', text: '还没有连接' }),
      el('span', { class: 'tree-empty-hint', text: '新建一个 SSH 连接，或从配置文件导入现有会话。' }),
      el(
        'div',
        { class: 'tree-empty-actions' },
        el(
          'button',
          {
            class: 'btn btn-primary btn-sm',
            type: 'button',
            html: `${icon('plus', 14)}<span>新建连接</span>`,
            onclick: () => this.options.onNewConnection(null)
          },
          null
        ),
        el(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            html: `${icon('import', 14)}<span>导入配置</span>`,
            onclick: () => this.options.onImport()
          },
          null
        ),
        el(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            html: `${icon('layout', 14)}<span>远程桌面</span>`,
            onclick: () => this.options.onNewRemoteConnection(null)
          },
          null
        )
      )
    )
  }

  private async toggleFolder(folder: Folder): Promise<void> {
    folder.expanded = !folder.expanded
    this.renderTree()
    try {
      const state = await this.options.api.saveFolder({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        expanded: folder.expanded
      })
      this.options.onState(state)
    } catch (error) {
      this.options.toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  private async createFolder(parentId: string | null): Promise<void> {
    const name = await askFolderName(this.options.modal, {
      title: '新建分组',
      subtitle: '用分组整理不同环境或不同客户的连接。',
      parentLabel: parentId ? folderPathLabel(parentId, this.options.getState().folders) : undefined
    })
    if (!name) return
    try {
      const state = await this.options.api.saveFolder({ name, parentId })
      this.options.onState(state)
      this.render()
      this.options.toast.success(`已创建分组“${name}”`)
    } catch (error) {
      this.options.toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  private async renameFolder(folder: Folder): Promise<void> {
    const name = await askFolderName(this.options.modal, {
      title: '重命名分组',
      initial: folder.name,
      parentLabel: folder.parentId
        ? folderPathLabel(folder.parentId, this.options.getState().folders)
        : undefined
    })
    if (!name || name === folder.name) return
    try {
      const state = await this.options.api.saveFolder({
        id: folder.id,
        name,
        parentId: folder.parentId,
        expanded: folder.expanded
      })
      this.options.onState(state)
      this.render()
    } catch (error) {
      this.options.toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  private async deleteFolder(folder: Folder): Promise<void> {
    const state = this.options.getState()
    const count = countConnections(
      folder.id,
      groupFolders(state.folders),
      groupConnections(state.connections)
    )
    const confirmed = await this.options.modal.confirm({
      title: '删除分组',
      message: `确定删除分组“${folder.name}”吗？`,
      detail:
        count > 0
          ? `该分组及子分组中的 ${count} 个连接也会被删除，此操作不可撤销。`
          : '此操作不可撤销。',
      confirmText: '删除',
      danger: true
    })
    if (!confirmed) return
    try {
      const next = await this.options.api.deleteFolder(folder.id)
      this.options.onState(next)
      this.render()
      this.options.toast.success('分组已删除')
    } catch (error) {
      this.options.toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  private newConnectionFolderId(): string | null {
    const state = this.options.getState()
    if (
      this.selectedFolderId &&
      this.selectedFolders.has(this.selectedFolderId) &&
      state.folders.some((folder) => folder.id === this.selectedFolderId)
    ) {
      return this.selectedFolderId
    }
    if (this.selectedConnections.size === 1) {
      const [connectionId] = this.selectedConnections
      return state.connections.find((item) => item.id === connectionId)?.folderId ?? null
    }
    return null
  }

  private showBlankMenu(x: number, y: number): void {
    showContextMenu(
      [
        { label: '新建连接', icon: 'plus', action: () => this.options.onNewConnection(null) },
        { label: '新建分组', icon: 'folder', action: () => void this.createFolder(null) },
        {
          label: '新建远程桌面连接',
          icon: 'layout',
          action: () => this.options.onNewRemoteConnection(null)
        },
        { separator: true },
        { label: '导入配置…', icon: 'import', action: () => this.options.onImport() },
        {
          label: '展开全部分组',
          icon: 'folderOpen',
          action: () => {
            for (const folder of this.options.getState().folders) folder.expanded = true
            this.renderTree()
            void this.persistExpandedState()
          }
        },
        {
          label: '折叠全部分组',
          icon: 'folder',
          action: () => {
            for (const folder of this.options.getState().folders) folder.expanded = false
            this.renderTree()
            void this.persistExpandedState()
          }
        }
      ],
      x,
      y
    )
  }

  private showFolderMenu(folder: Folder, x: number, y: number): void {
    showContextMenu(
      [
        {
          label: '在此分组中新建连接',
          icon: 'plus',
          action: () => this.options.onNewConnection(folder.id)
        },
        {
          label: '在此分组中新建远程桌面',
          icon: 'layout',
          action: () => this.options.onNewRemoteConnection(folder.id)
        },
        { label: '新建子分组', icon: 'folder', action: () => void this.createFolder(folder.id) },
        { separator: true },
        { label: '重命名', icon: 'edit', action: () => void this.renameFolder(folder) },
        { label: '删除分组', icon: 'trash', danger: true, action: () => void this.deleteFolder(folder) }
      ],
      x,
      y
    )
  }

  private showConnectionMenu(connection: Connection, x: number, y: number): void {
    const remote = connection.protocol === 'remoteDesktop'
    showContextMenu(
      [
        {
          label: remote ? '打开远程桌面' : '打开会话',
          icon: remote ? 'layout' : 'terminal',
          action: () => this.options.onOpenConnection(connection)
        },
        { label: '编辑连接', icon: 'edit', action: () => this.options.onEditConnection(connection) },
        ...(remote
          ? []
          : [
              {
                label: '复制连接',
                icon: 'copy',
                action: () => this.options.onDuplicateConnection(connection)
              }
            ]),
        { separator: true },
        ...(remote
          ? []
          : [
              {
                label: '测试连接',
                icon: 'plug',
                action: () => this.options.onTestConnection(connection)
              }
            ]),
        {
          label: '复制主机地址',
          icon: 'clipboard',
          action: () => {
            this.options.api.clipboardWrite(connection.host)
            this.options.toast.success('主机地址已复制')
          }
        },
        { separator: true },
        {
          label: '删除连接',
          icon: 'trash',
          danger: true,
          action: () => this.options.onDeleteConnection(connection)
        }
      ],
      x,
      y
    )
  }

  private async persistExpandedState(): Promise<void> {
    for (const folder of this.options.getState().folders) {
      try {
        await this.options.api.saveFolder({
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId,
          expanded: folder.expanded
        })
      } catch {
        // Persisting expansion is best effort.
      }
    }
  }

  private renderFooter(): void {
    const state = this.options.getState()
    this.footerCount.textContent = `${state.connections.length} 个连接 · ${state.folders.length} 个分组`
  }
}

function groupFolders(folders: Folder[]): Map<string, Folder[]> {
  const map = new Map<string, Folder[]>()
  for (const folder of folders) {
    const key = folder.parentId ?? ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)?.push(folder)
  }
  return map
}

function groupConnections(connections: Connection[]): Map<string, Connection[]> {
  const map = new Map<string, Connection[]>()
  for (const connection of connections) {
    const key = connection.folderId ?? ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)?.push(connection)
  }
  return map
}

function countConnections(
  folderId: string,
  folders: Map<string, Folder[]>,
  connections: Map<string, Connection[]>
): number {
  let total = connections.get(folderId)?.length ?? 0
  for (const child of folders.get(folderId) ?? []) {
    total += countConnections(child.id, folders, connections)
  }
  return total
}
