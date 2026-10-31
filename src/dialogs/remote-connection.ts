import type { AppState, Connection, ConnectionDraft, Folder, HongSshApi } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { el, uid } from '../ui/dom'
import type { ModalHandle, ModalHost } from '../ui/modal'
import {
  button,
  colorSwatches,
  field,
  fieldsetMessage,
  formCard,
  formGrid,
  selectInput,
  textInput
} from '../ui/forms'

interface RemoteConnectionDialogOptions {
  modal: ModalHost
  api: HongSshApi
  folders: Folder[]
  connection?: Connection
  localDeviceCode?: string
  defaultFolderId?: string | null
  onSaved: (state: AppState, connect: boolean, connectionId: string) => void
}

const COLORS = ['#2f7fd8', '#0f9d8a', '#c26a1b', '#7d5bd6', '#bf3f6b', '#4b8b3b']

function folderOptions(folders: Folder[]): Array<{ value: string; label: string }> {
  const byParent = new Map<string, Folder[]>()
  for (const folder of folders) {
    const key = folder.parentId ?? ''
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)?.push(folder)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN'))
  }
  const result: Array<{ value: string; label: string }> = []
  const visit = (parentId: string, depth: number) => {
    for (const folder of byParent.get(parentId) ?? []) {
      result.push({ value: folder.id, label: `${'　'.repeat(depth)}${folder.name}` })
      visit(folder.id, depth + 1)
    }
  }
  visit('', 0)
  return result
}

export function openRemoteConnectionDialog(options: RemoteConnectionDialogOptions): void {
  const { modal, api, connection, folders } = options
  const isEdit = Boolean(connection)
  const draftId = connection?.id || `c_${uid().replace(/-/g, '').slice(0, 20)}`
  const nameInput = textInput({
    value: connection?.name ?? '',
    placeholder: '例如 办公室电脑',
    maxLength: 80,
    autofocus: true
  })
  const relayUrlInput = textInput({
    value: connection?.relayUrl || DEFAULT_SETTINGS.relayUrl,
    placeholder: DEFAULT_SETTINGS.relayUrl,
    spellcheck: false
  })
  const relayDeviceInput = textInput({
    value: connection?.relayDeviceId ?? '',
    placeholder: '对方设备码，例如 123456789',
    maxLength: 32,
    spellcheck: false
  })
  const localDeviceCode = options.localDeviceCode || ''
  const qualitySelect = selectInput(
    [
      { value: '40', label: '省流量（40）' },
      { value: '55', label: '均衡（55）' },
      { value: '62', label: '标准（62）' },
      { value: '75', label: '清晰（75）' },
      { value: '85', label: '高清（85）' }
    ],
    String(connection?.remoteQuality ?? 55)
  )
  const refreshSelect = selectInput(
    [
      { value: '100', label: '100 毫秒（约 10 帧/秒）' },
      { value: '125', label: '125 毫秒（约 8 帧/秒）' },
      { value: '150', label: '150 毫秒（约 6.7 帧/秒）' },
      { value: '200', label: '200 毫秒（默认，约 5 帧/秒）' },
      { value: '250', label: '250 毫秒（约 4 帧/秒）' },
      { value: '300', label: '300 毫秒（约 3.3 帧/秒）' },
      { value: '500', label: '500 毫秒（约 2 帧/秒）' }
    ],
    String(connection?.remoteRefreshMs ?? 200)
  )
  const folderSelect = selectInput(
    [{ value: '', label: '未分组' }, ...folderOptions(folders)],
    connection?.folderId ?? options.defaultFolderId ?? ''
  )
  const descriptionInput = el('textarea', {
    class: 'text-area',
    rows: 2,
    placeholder: '备注（可选）',
    value: connection?.description ?? ''
  })
  let color = connection?.color ?? '#2f7fd8'
  const colorPicker = colorSwatches(COLORS, color, (next) => {
    color = next
  })
  const localDeviceValue = el('code', {
    class: 'device-code-value',
    text: localDeviceCode || '未生成'
  })
  const copyLocalDeviceButton = button('复制', {
    kind: 'ghost',
    disabled: !localDeviceCode,
    onClick: () => {
      if (!localDeviceCode) return
      api.clipboardWrite(localDeviceCode)
      copyLocalDeviceButton.textContent = '已复制'
      window.setTimeout(() => {
        if (copyLocalDeviceButton.isConnected) copyLocalDeviceButton.textContent = '复制'
      }, 1500)
    }
  })
  const localDeviceControl = el(
    'div',
    { class: 'device-code-row' },
    localDeviceValue,
    copyLocalDeviceButton
  )

  const messageArea = el('div', { class: 'form-message', hidden: true })
  const cancelButton = button('取消', { kind: 'ghost', onClick: () => handle.close() })
  const saveButton = button('保存', { onClick: () => void submit(false) })
  const connectButton = button('保存并连接', {
    kind: 'primary',
    onClick: () => void submit(true)
  })

  const form = el(
    'form',
    {
      class: 'connection-form',
      onsubmit: (event: Event) => {
        event.preventDefault()
        void submit(false)
      }
    },
    messageArea,
    formCard(
      '远程电脑',
      '对方需要运行 HongSSH，并保持中继在线。',
      formGrid(
        field('连接名称', nameInput, { hint: '留空时使用对方设备码' }),
        field('分组', folderSelect),
        field('颜色标识', colorPicker),
        field('中继地址', relayUrlInput, {
          wide: true,
          hint: '填写对方（被控端）使用的中继地址，需与对方设置一致'
        }),
        field('对方设备码', relayDeviceInput, {
          hint: '对方在“设置 → 公网中继”中显示的本机设备码'
        }),
        field('我的设备码', localDeviceControl, {
          hint: '别人连接本机时填写这个，不是上方“对方设备码”'
        })
      ),
      field('备注', descriptionInput, { wide: true })
    ),
    formCard(
      '画面与流量',
      '默认只传变化区域；只有光标移动时只传坐标，画面不变时不传输。',
      formGrid(
        field('画面质量', qualitySelect, {
          hint: '越低越省流量，越高越清晰；修改后重新连接生效。'
        }),
        field('画面刷新间隔', refreshSelect, {
          hint: '默认 200 毫秒；数值越大越省流量，越小越流畅。修改后重新连接生效。'
        })
      )
    )
  )

  const footer = el(
    'div',
    { class: 'dialog-footer' },
    el('div', { class: 'dialog-footer-left' }),
    el('div', { class: 'dialog-footer-right' }, cancelButton, saveButton, connectButton)
  )

  const handle: ModalHandle = modal.open({
    title: isEdit ? '编辑远程连接' : '新建远程桌面连接',
    subtitle: isEdit ? '修改后保存' : '通过中继服务器连接另一台安装了 HongSSH 的电脑',
    icon: 'layout',
    width: 680,
    body: el('div', { class: 'dialog-scroll' }, form),
    footer
  })

  function showError(message: string): void {
    messageArea.hidden = false
    messageArea.replaceChildren(fieldsetMessage('error', message))
  }

  async function submit(connect: boolean): Promise<void> {
    const relayUrl = relayUrlInput.value.trim()
    const relayDeviceId = relayDeviceInput.value.trim()
    if (!/^(wss?|https?):\/\//i.test(relayUrl)) {
      showError('请填写有效的中继地址（wss:// 或 https://）')
      relayUrlInput.focus()
      return
    }
    if (!/^[A-Za-z0-9-]{6,32}$/.test(relayDeviceId)) {
      showError('请填写对方设备码（6–32 位）')
      relayDeviceInput.focus()
      return
    }
    const fallbackHost = (() => {
      try {
        return new URL(relayUrl).hostname || 'relay'
      } catch {
        return 'relay'
      }
    })()
    const draft: ConnectionDraft = {
      id: draftId,
      folderId: folderSelect.value || null,
      protocol: 'remoteDesktop',
      connectionMode: 'webrtc',
      relayUrl,
      relayDeviceId,
      name: nameInput.value.trim() || `中继 ${relayDeviceId}`,
      host: fallbackHost,
      port: 443,
      username: 'remote',
      authType: 'password',
      privateKeyPath: '',
      description: descriptionInput.value.trim(),
      color,
      terminalType: 'xterm-256color',
      initCommand: '',
      hostKeyPolicy: 'accept-new',
      keepaliveInterval: 0,
      remoteQuality: Number(qualitySelect.value) || 62,
      remoteRefreshMs: Number(refreshSelect.value) || 200,
      rememberPassword: false
    }
    saveButton.disabled = true
    connectButton.disabled = true
    try {
      const next = await api.saveConnection(draft)
      options.onSaved(next, connect, draftId)
      handle.close()
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
    } finally {
      saveButton.disabled = false
      connectButton.disabled = false
    }
  }
}
