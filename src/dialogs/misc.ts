import { el } from '../ui/dom'
import { icon, logo } from '../ui/icons'
import type { ModalHandle, ModalHost } from '../ui/modal'
import { button, field, fieldsetMessage } from '../ui/forms'

interface FolderPromptOptions {
  title: string
  subtitle?: string
  initial?: string
  parentLabel?: string
  placeholder?: string
}

export function askFolderName(
  modal: ModalHost,
  options: FolderPromptOptions
): Promise<string | null> {
  const input = el('input', {
    class: 'text-input',
    type: 'text',
    value: options.initial ?? '',
    placeholder: options.placeholder ?? '分组名称',
    autofocus: true,
    maxlength: 80
  })
  const errorArea = el('div', { class: 'form-message', hidden: true })
  let settled = false
  let handle: ModalHandle
  let resolve: (value: string | null) => void = () => {}

  const finish = (value: string | null) => {
    if (settled) return
    settled = true
    handle.close()
    resolve(value)
  }

  const submit = () => {
    const name = input.value.trim()
    if (!name) {
      errorArea.hidden = false
      errorArea.replaceChildren(fieldsetMessage('error', '请输入分组名称'))
      input.focus()
      return
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      errorArea.hidden = false
      errorArea.replaceChildren(fieldsetMessage('error', '名称不能包含 \\ / : * ? " < > | 字符'))
      input.focus()
      return
    }
    finish(name)
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  })

  const promise = new Promise<string | null>((res) => {
    resolve = res
  })

  handle = modal.open({
    title: options.title,
    subtitle: options.subtitle,
    icon: 'folder',
    width: 420,
    closeOnBackdrop: false,
    body: el(
      'div',
      { class: 'folder-dialog' },
      options.parentLabel
        ? el('div', { class: 'folder-parent' }, el('span', { text: '上级分组：' }), el('strong', { text: options.parentLabel }))
        : null,
      errorArea,
      field('名称', input)
    ),
    footer: el(
      'div',
      { class: 'modal-actions' },
      button('取消', { kind: 'ghost', onClick: () => finish(null) }),
      button(options.initial ? '保存' : '创建', { kind: 'primary', onClick: submit })
    ),
    onClose: () => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    }
  })

  return promise
}

export function folderPathLabel(folderId: string | null, folders: Array<{ id: string; name: string; parentId: string | null }>): string {
  if (!folderId) return '未分组'
  const parts: string[] = []
  let current = folders.find((folder) => folder.id === folderId)
  const guard = new Set<string>()
  while (current && !guard.has(current.id)) {
    guard.add(current.id)
    parts.unshift(current.name)
    const parentId: string | null = current.parentId
    current = parentId ? folders.find((folder) => folder.id === parentId) : undefined
  }
  return parts.join(' / ') || '未分组'
}

export function showAboutDialog(
  modal: ModalHost,
  info: {
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
    dataDir: string
  },
  openDataFolder: () => void,
  checkForUpdates?: () => void
): void {
  const handle = modal.open({
    title: '关于 HongSSH',
    icon: 'terminal',
    width: 520,
    body: el(
      'div',
      { class: 'about-dialog' },
      el(
        'div',
        { class: 'about-brand' },
        el('div', { class: 'about-logo', html: logo(56) }),
        el(
          'div',
          {},
          el('h2', { text: 'HongSSH' }),
          el('p', { text: '快速、安全、还原真实配色的 SSH 终端' })
        )
      ),
      el(
        'div',
        { class: 'about-versions' },
        versionRow('版本', info.version),
        versionRow('Electron', info.electron),
        versionRow('Chromium', info.chrome),
        versionRow('Node.js', info.node),
        versionRow('系统', `${info.platform} ${info.arch}`)
      ),
      el(
        'div',
        { class: 'about-features' },
        el('span', { html: icon('check', 15) }),
        el('span', {
          text: '基于 SSH PTY 的交互式终端，完整支持 top、vi、htop、less 等全屏程序，并保留服务器输出的 ANSI / 256 / TrueColor 颜色。'
        })
      ),
      el(
        'div',
        { class: 'about-data' },
        el('span', { class: 'about-data-label', text: '数据目录' }),
        el('code', { text: info.dataDir })
      )
    ),
    footer: el(
      'div',
      { class: 'modal-actions spread' },
      el(
        'div',
        { class: 'modal-actions' },
        checkForUpdates
          ? button('检查更新', { kind: 'ghost', icon: 'refresh', onClick: checkForUpdates })
          : null,
        button('打开数据目录', { kind: 'ghost', icon: 'external', onClick: openDataFolder })
      ),
      button('关闭', { kind: 'primary', onClick: () => handle.close() })
    )
  })
}

function versionRow(label: string, value: string): HTMLElement {
  return el(
    'div',
    { class: 'version-row' },
    el('span', { text: label }),
    el('code', { text: value })
  )
}

export function showShortcutsDialog(modal: ModalHost): void {
  const rows: Array<[string, string]> = [
    ['新建连接', 'Ctrl + N'],
    ['关闭当前会话', 'Ctrl + W'],
    ['下一个 / 上一个标签页', 'Ctrl + Tab / Ctrl + Shift + Tab'],
    ['复制 / 粘贴', 'Ctrl + Shift + C / Ctrl + Shift + V'],
    ['查找终端内容', 'Ctrl + F'],
    ['全选终端内容', 'Ctrl + Shift + A'],
    ['放大 / 缩小 / 重置字体', 'Ctrl + = / Ctrl + - / Ctrl + 0'],
    ['显示 / 隐藏连接面板', 'Ctrl + B'],
    ['文件传输面板', 'Ctrl + Shift + E'],
    ['框选截图', 'Ctrl + Shift + X'],
    ['开始 / 停止录屏', 'Ctrl + Shift + F10'],
    ['重新连接当前会话', 'Ctrl + R'],
    ['打开设置', 'Ctrl + ,'],
    ['全屏', 'F11'],
    ['快捷键帮助', 'F1']
  ]
  const handle = modal.open({
    title: '快捷键',
    subtitle: '终端获得焦点时，Ctrl+C 等按键会原样发送给远端。',
    icon: 'keyboard',
    width: 520,
    body: el(
      'div',
      { class: 'shortcuts-table' },
      ...rows.map(([label, shortcut]) =>
        el(
          'div',
          { class: 'shortcut-row' },
          el('span', { text: label }),
          el('kbd', { text: shortcut })
        )
      )
    ),
    footer: el(
      'div',
      { class: 'modal-actions' },
      button('关闭', { kind: 'primary', onClick: () => handle.close() })
    )
  })
}

export function showImportResult(
  modal: ModalHost,
  result: {
    root: string
    summary: {
      files: number
      sessions: number
      unique: number
      duplicates: number
      folders: number
      withPassword: number
      portablePasswords: number
      xshellPasswords: number
      imported: number
      skippedExisting: number
      passwordsImported: number
      passphrasesImported: number
    }
  }
): void {
  const summary = result.summary
  const passwordNote =
    summary.passwordsImported > 0
      ? `已恢复 ${summary.passwordsImported} 个登录密码${
          summary.passphrasesImported > 0 ? `、${summary.passphrasesImported} 个私钥口令` : ''
        }，并使用系统安全存储加密保存。`
      : summary.xshellPasswords > 0
        ? `检测到 ${summary.xshellPasswords} 个 Xshell 自带密码，因与本机账户绑定，无法迁移；首次连接时请输入一次密码。`
        : '本次配置未包含可迁移的密码。'
  modal.open({
    title: '配置导入完成',
    subtitle: result.root,
    icon: 'import',
    width: 520,
    body: el(
      'div',
      { class: 'import-result' },
      el(
        'div',
        { class: 'import-stats' },
        statCard('新增连接', summary.imported),
        statCard('分组', summary.folders),
        statCard('跳过重复', summary.skippedExisting + summary.duplicates)
      ),
      el(
        'div',
        { class: 'import-note' },
        el('span', { html: icon('info', 17) }),
        el('span', { text: passwordNote })
      ),
      el(
        'div',
        { class: 'import-detail' },
        `扫描 ${summary.files} 个配置文件，识别 ${summary.sessions} 个连接，去重后 ${summary.unique} 个。`
      )
    ),
    footer: el(
      'div',
      { class: 'modal-actions' },
      button('知道了', { kind: 'primary', onClick: () => modal.close() })
    )
  })
}

function statCard(label: string, value: number): HTMLElement {
  return el(
    'div',
    { class: 'stat-card' },
    el('span', { class: 'stat-value', text: String(value) }),
    el('span', { class: 'stat-label', text: label })
  )
}
