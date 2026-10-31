import type {
  AppState,
  AuthType,
  Connection,
  ConnectionDraft,
  Folder,
  HongSshApi,
  HostKeyPolicy,
  Settings,
  TestResult
} from '../types'
import { el, uid } from '../ui/dom'
import { icon } from '../ui/icons'
import type { ModalHandle, ModalHost } from '../ui/modal'
import {
  button,
  checkboxRow,
  colorSwatches,
  field,
  fieldsetMessage,
  formCard,
  formGrid,
  numberInput,
  selectInput,
  setInvalid,
  textInput
} from '../ui/forms'

interface ConnectionDialogOptions {
  modal: ModalHost
  api: HongSshApi
  settings: Settings
  folders: Folder[]
  secretsEncrypted: boolean
  connection?: Connection
  copy?: boolean
  defaultFolderId?: string | null
  onSaved: (
    state: AppState,
    connect: boolean,
    connectionId: string,
    secrets: { password?: string; passphrase?: string; rememberPassword: boolean; rememberPassphrase: boolean }
  ) => void
}

const COLORS = ['#2f7fd8', '#0f9d8a', '#c26a1b', '#7d5bd6', '#bf3f6b', '#4b8b3b', '#a0522d', '#5b6b7c']

const AUTH_OPTIONS: Array<{ value: AuthType; title: string; description: string; icon: string }> = [
  { value: 'password', title: '密码', description: '使用账号密码登录', icon: 'key' },
  { value: 'privateKey', title: '私钥', description: '使用 OpenSSH / PEM 私钥', icon: 'shield' },
  { value: 'agent', title: 'SSH Agent', description: '使用 Pageant 或系统 Agent', icon: 'lock' }
]

export function openConnectionDialog(options: ConnectionDialogOptions): void {
  const { modal, api, connection, folders, settings } = options
  const isEdit = Boolean(connection) && options.copy !== true
  const draftId = (isEdit ? connection?.id : undefined) || `c_${uid().replace(/-/g, '').slice(0, 20)}`
  const hostInput = textInput({
    value: connection?.host ?? '',
    placeholder: '例如 192.0.2.10 或 server.example.com',
    autofocus: !isEdit,
    spellcheck: false
  })
  const portInput = numberInput({ value: connection?.port ?? 22, min: 1, max: 65535 })
  const userInput = textInput({
    value: connection?.username ?? '',
    placeholder: 'root',
    autofocus: isEdit
  })
  const nameInput = textInput({
    value: connection?.name ?? '',
    placeholder: '不填则使用主机地址',
    maxLength: 80
  })
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

  let authType: AuthType = connection?.authType ?? 'password'
  let color = connection?.color ?? '#2f7fd8'

  const passwordInput = textInput({
    type: 'password',
    placeholder: connection?.hasPassword ? '已保存密码，留空则不修改' : '登录密码',
    spellcheck: false
  })
  const showPasswordButton = el(
    'button',
    {
      class: 'input-addon-button',
      type: 'button',
      title: '显示/隐藏密码',
      html: icon('eye', 16)
    },
    null
  )
  showPasswordButton.addEventListener('click', () => {
    const visible = passwordInput.type === 'text'
    passwordInput.type = visible ? 'password' : 'text'
    showPasswordButton.innerHTML = icon(visible ? 'eye' : 'eyeOff', 16)
  })
  const passwordGroup = el(
    'div',
    { class: 'input-with-addon' },
    passwordInput,
    showPasswordButton
  )
  const rememberPassword = checkboxRow(
    '记住密码',
    isEdit ? connection?.hasPassword ?? false : options.secretsEncrypted,
    {
      hint: options.secretsEncrypted
        ? '密码通过 Windows DPAPI 加密后保存在本机，不会写入项目文件。'
        : '当前系统不支持安全凭据存储，密码只在本次会话中使用。',
      disabled: !options.secretsEncrypted
    }
  )
  const clearPassword = checkboxRow('清除已保存的密码', false, {
    hint: '勾选后，下次连接需要重新输入密码。'
  })
  const passwordFields = el(
    'div',
    { class: 'auth-fields' },
    field('登录密码', passwordGroup, { hint: connection?.hasPassword ? '已保存密码；填写新密码可覆盖。' : '' }),
    rememberPassword,
    connection?.hasPassword ? clearPassword : null
  )

  const keyPathInput = textInput({
    value: connection?.privateKeyPath ?? '',
    placeholder: 'C:\\Users\\你\\.ssh\\id_ed25519',
    spellcheck: false
  })
  const browseKeyButton = el(
    'button',
    { class: 'input-addon-button text-addon', type: 'button', text: '浏览…' },
    null
  )
  const keyPathGroup = el('div', { class: 'input-with-addon' }, keyPathInput, browseKeyButton)
  const passphraseInput = textInput({
    type: 'password',
    placeholder: connection?.hasPassphrase ? '已保存口令，留空则不修改' : '私钥口令（没有可留空）',
    spellcheck: false
  })
  const rememberPassphrase = checkboxRow(
    '记住私钥口令',
    connection?.hasPassphrase ?? options.secretsEncrypted,
    {
      hint: '私钥口令同样使用系统安全存储加密。',
      disabled: !options.secretsEncrypted
    }
  )
  const clearPassphrase = checkboxRow('清除已保存的私钥口令', false, {
    hint: '下次连接时需要重新输入私钥口令。'
  })
  const privateKeyFields = el(
    'div',
    { class: 'auth-fields' },
    field('私钥文件', keyPathGroup, { hint: '支持 OpenSSH、RSA、ECDSA、Ed25519 私钥（不支持 PuTTY .ppk）。' }),
    field('私钥口令', passphraseInput),
    rememberPassphrase,
    connection?.hasPassphrase ? clearPassphrase : null
  )

  const agentFields = el(
    'div',
    { class: 'auth-fields' },
    el(
      'div',
      { class: 'auth-agent-note' },
      el('span', { class: 'auth-agent-icon', html: icon('info', 18) }),
      el(
        'div',
        {},
        el('strong', { text: '使用 SSH Agent 认证' }),
        el('p', {
          text: 'Windows 下将尝试连接 Pageant；其他平台使用 SSH_AUTH_SOCK。请确保对应 Agent 已启动并加载了私钥。'
        })
      )
    )
  )

  const authChoices = el('div', { class: 'auth-choices', role: 'radiogroup' })
  const authFieldsMap: Record<AuthType, HTMLElement> = {
    password: passwordFields,
    privateKey: privateKeyFields,
    agent: agentFields
  }
  for (const option of AUTH_OPTIONS) {
    const radio = el('input', {
      type: 'radio',
      name: 'authType',
      value: option.value,
      checked: authType === option.value
    })
    const card = el(
      'label',
      { class: `auth-choice${authType === option.value ? ' is-active' : ''}` },
      radio,
      el('span', { class: 'auth-choice-icon', html: icon(option.icon, 19) }),
      el(
        'span',
        { class: 'auth-choice-text' },
        el('span', { class: 'auth-choice-title', text: option.title }),
        el('span', { class: 'auth-choice-desc', text: option.description })
      )
    )
    radio.addEventListener('change', () => {
      if (!radio.checked) return
      authType = option.value
      authChoices.querySelectorAll('.auth-choice').forEach((item) => item.classList.remove('is-active'))
      card.classList.add('is-active')
      updateAuthFields()
    })
    authChoices.appendChild(card)
  }
  authFieldsMap[authType].classList.add('is-active')

  function updateAuthFields(): void {
    for (const [key, element] of Object.entries(authFieldsMap)) {
      element.classList.toggle('is-active', key === authType)
    }
  }

  browseKeyButton.addEventListener('click', async () => {
    try {
      const selected = await api.pickPrivateKey()
      if (selected) keyPathInput.value = selected
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
    }
  })

  const terminalTypeSelect = selectInput(
    [
      { value: 'xterm-256color', label: 'xterm-256color（推荐，支持 256 色）' },
      { value: 'xterm', label: 'xterm' },
      { value: 'screen-256color', label: 'screen-256color' },
      { value: 'vt100', label: 'vt100' },
      { value: 'linux', label: 'linux' }
    ],
    connection?.terminalType ?? settings.terminalType
  )
  const initCommandInput = textInput({
    value: connection?.initCommand ?? '',
    placeholder: '例如 cd /data/app && ls',
    maxLength: 500
  })
  const hostKeySelect = selectInput(
    [
      { value: 'accept-new', label: '接受新主机，密钥变更时阻止（推荐）' },
      { value: 'strict', label: '严格：只连接已信任的主机' },
      { value: 'insecure', label: '宽松：接受所有主机密钥（不推荐）' }
    ],
    connection?.hostKeyPolicy ?? settings.hostKeyPolicy
  )
  const keepaliveInput = numberInput({
    value: connection?.keepaliveInterval ?? settings.keepaliveInterval,
    min: 0,
    max: 300
  })
  const colorPicker = colorSwatches(COLORS, color, (next) => {
    color = next
  })

  const messageArea = el('div', { class: 'form-message', hidden: true })
  const testResult = el('div', { class: 'test-result', hidden: true })
  const testButton = button('测试连接', { icon: 'plug', onClick: () => void runTest() })
  const cancelButton = button('取消', { kind: 'ghost', onClick: () => handle.close() })
  const saveButton = button('保存', { onClick: () => void submit(false) })
  const saveConnectButton = button('保存并连接', { kind: 'primary', onClick: () => void submit(true) })

  const form = el(
    'form',
    { class: 'connection-form', onsubmit: (event: Event) => { event.preventDefault(); void submit(false) } },
    messageArea,
    formCard(
      '基本信息',
      '连接名称只影响本机显示，可随时修改。',
      formGrid(
        field('连接名称', nameInput, { hint: '留空时使用主机地址' }),
        field('分组', folderSelect),
        field('主机', hostInput, { required: true, wide: false }),
        field('端口', portInput, { required: true }),
        field('用户名', userInput, { required: true }),
        field('颜色标识', colorPicker)
      ),
      field('备注', descriptionInput, { wide: true })
    ),
    formCard('认证方式', '密码与私钥口令只会交给本机 SSH 进程。', authChoices, ...Object.values(authFieldsMap)),
    formCard(
      '终端',
      'TERM 类型会影响远端 top、vi 等全屏程序的显示效果。',
      formGrid(
        field('终端类型', terminalTypeSelect),
        field('连接保活（秒）', keepaliveInput, { hint: '0 表示关闭；建议 15–60 秒' })
      ),
      field('登录后执行', initCommandInput, {
        hint: '终端就绪后自动输入该命令（可留空），例如 cd /data/app。'
      })
    ),
    formCard(
      '安全',
      '首次连接会记录服务器指纹，防止中间人攻击。',
      field('主机密钥策略', hostKeySelect, { wide: true })
    )
  )

  const footer = el(
    'div',
    { class: 'dialog-footer' },
    el('div', { class: 'dialog-footer-left' }, testButton),
    el('div', { class: 'dialog-footer-right' }, cancelButton, saveButton, saveConnectButton)
  )

  const handle: ModalHandle = modal.open({
    title: isEdit ? '编辑连接' : options.copy ? '复制连接' : '新建连接',
    subtitle: isEdit
      ? '修改后保存，已打开的会话不会自动断开'
      : options.copy
        ? '基于现有连接创建一个新的连接；密码不会被复制'
        : '创建一个 SSH 会话',
    icon: 'terminal',
    width: 760,
    body: el('div', { class: 'dialog-scroll' }, form, testResult),
    footer
  })

  function collectDraft(): ConnectionDraft {
    const password = passwordInput.value
    const passphrase = passphraseInput.value
    const draft: ConnectionDraft = {
      id: draftId,
      folderId: folderSelect.value || null,
      name: nameInput.value.trim() || hostInput.value.trim(),
      host: hostInput.value.trim(),
      port: Number(portInput.value) || 22,
      username: userInput.value.trim(),
      authType,
      privateKeyPath: keyPathInput.value.trim(),
      description: descriptionInput.value.trim(),
      color,
      terminalType: terminalTypeSelect.value,
      initCommand: initCommandInput.value.trim(),
      hostKeyPolicy: hostKeySelect.value as HostKeyPolicy,
      keepaliveInterval: Number(keepaliveInput.value) || 0
    }
    if (authType === 'password' && password) draft.password = password
    if (authType === 'privateKey' && passphrase) draft.passphrase = passphrase
    const rememberPasswordInput = rememberPassword.querySelector('input') as HTMLInputElement | null
    const rememberPassphraseInput = rememberPassphrase.querySelector('input') as HTMLInputElement | null
    draft.rememberPassword = rememberPasswordInput?.checked ?? false
    draft.rememberPassphrase = rememberPassphraseInput?.checked ?? false
    if ((clearPassword.querySelector('input') as HTMLInputElement | null)?.checked) {
      draft.clearPassword = true
    }
    if (connection?.hasPassword && !draft.rememberPassword) {
      draft.clearPassword = true
    }
    if ((clearPassphrase.querySelector('input') as HTMLInputElement | null)?.checked) {
      draft.clearPassphrase = true
    }
    if (connection?.hasPassphrase && !draft.rememberPassphrase) {
      draft.clearPassphrase = true
    }
    return draft
  }

  function validate(draft: ConnectionDraft): boolean {
    const errors: HTMLElement[] = []
    const hostField = hostInput.closest('.form-field') as HTMLElement
    const userField = userInput.closest('.form-field') as HTMLElement
    const portField = portInput.closest('.form-field') as HTMLElement
    const keyField = keyPathInput.closest('.form-field') as HTMLElement
    setInvalid(hostField, !draft.host)
    setInvalid(userField, !draft.username)
    setInvalid(portField, !draft.port || draft.port < 1 || draft.port > 65535)
    setInvalid(keyField, draft.authType === 'privateKey' && !draft.privateKeyPath)
    if (!draft.host) errors.push(hostInput)
    if (!draft.username) errors.push(userInput)
    if (!draft.port || draft.port < 1 || draft.port > 65535) errors.push(portInput)
    if (draft.authType === 'privateKey' && !draft.privateKeyPath) errors.push(keyPathInput)
    if (errors.length > 0) {
      showError('请填写必填项：主机、用户名、端口，以及私钥认证所需的私钥文件。')
      errors[0].focus()
      return false
    }
    clearMessage()
    return true
  }

  function showError(message: string): void {
    messageArea.hidden = false
    messageArea.replaceChildren(fieldsetMessage('error', message))
  }

  function clearMessage(): void {
    messageArea.hidden = true
    messageArea.replaceChildren()
  }

  let saving = false
  async function submit(connect: boolean): Promise<void> {
    if (saving) return
    const draft = collectDraft()
    if (!validate(draft)) return
    saving = true
    saveButton.disabled = true
    saveConnectButton.disabled = true
    saveButton.textContent = '保存中…'
    try {
      const state = await api.saveConnection(draft)
      options.onSaved(state, connect, draftId, {
        password: passwordInput.value || undefined,
        passphrase: passphraseInput.value || undefined,
        rememberPassword: draft.rememberPassword === true,
        rememberPassphrase: draft.rememberPassphrase === true
      })
      handle.close()
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
    } finally {
      saving = false
      saveButton.disabled = false
      saveConnectButton.disabled = false
      saveButton.textContent = '保存'
    }
  }

  let testing = false
  async function runTest(): Promise<void> {
    if (testing) return
    const draft = collectDraft()
    if (!validate(draft)) return
    testing = true
    testButton.disabled = true
    testResult.hidden = false
    testResult.className = 'test-result is-loading'
    testResult.replaceChildren(
      el('span', { class: 'mini-spinner', 'aria-hidden': 'true' }),
      el('span', { text: `正在连接 ${draft.host}:${draft.port}…` })
    )
    try {
      const result: TestResult = await api.testConnection({
        connection: draft,
        password: passwordInput.value,
        passphrase: passphraseInput.value
      })
      testResult.className = `test-result ${result.ok ? 'is-success' : 'is-error'}`
      testResult.replaceChildren(
        el('span', { html: icon(result.ok ? 'check' : 'warning', 16) }),
        el(
          'span',
          { class: 'test-result-text' },
          el('strong', { text: result.ok ? '连接成功' : '连接失败' }),
          el('span', {
            text: `${result.message}${result.elapsed ? ` · ${result.elapsed} ms` : ''}${
              result.fingerprint ? `\n${result.fingerprint}` : ''
            }`
          })
        )
      )
    } catch (error) {
      testResult.className = 'test-result is-error'
      testResult.replaceChildren(
        el('span', { html: icon('warning', 16) }),
        el('span', { text: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      testing = false
      testButton.disabled = false
    }
  }
}

function folderOptions(folders: Folder[]): Array<{ value: string; label: string }> {
  const byParent = new Map<string, Folder[]>()
  for (const folder of folders) {
    const key = folder.parentId ?? ''
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)?.push(folder)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN'))
  const result: Array<{ value: string; label: string }> = []
  const walk = (parentId: string, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      result.push({
        value: folder.id,
        label: `${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${folder.name}`
      })
      walk(folder.id, depth + 1)
    }
  }
  walk('', 0)
  return result
}
