import type { AppState, HongSshApi, Settings } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { el, formatRelativeTime } from '../ui/dom'
import { icon } from '../ui/icons'
import type { ModalHandle, ModalHost } from '../ui/modal'
import {
  button,
  checkboxRow,
  field,
  formCard,
  formGrid,
  numberInput,
  selectInput,
  textInput
} from '../ui/forms'
import { APP_THEMES } from '../ui-themes'
import { TERMINAL_THEMES, TERMINAL_THEME_ORDER } from '../terminal/themes'
import type { ToastHost } from '../ui/toast'

interface SettingsDialogOptions {
  modal: ModalHost
  api: HongSshApi
  state: AppState
  toast: ToastHost
  onSaved: (state: AppState) => void
}

export function openSettingsDialog(options: SettingsDialogOptions): void {
  const { modal, api, state, toast } = options
  let settings: Settings = { ...state.settings }
  let knownHosts = [...state.knownHosts]
  let saved = false

  const originalTheme = settings.theme
  const themeControl = selectInput(
    APP_THEMES.map((theme) => ({ value: theme.id, label: theme.label })),
    settings.theme,
    (value) => {
      settings.theme = value as Settings['theme']
      document.documentElement.dataset.theme = value
    }
  )

  const themeCards = el('div', { class: 'theme-cards', role: 'radiogroup' })
  for (const name of TERMINAL_THEME_ORDER) {
    const definition = TERMINAL_THEMES[name]
    const card = el(
      'button',
      {
        class: `theme-card${settings.terminalTheme === name ? ' is-active' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': settings.terminalTheme === name ? 'true' : 'false'
      },
      el(
        'span',
        {
          class: 'theme-preview',
          style: { backgroundColor: definition.background, color: definition.foreground }
        },
        el(
          'span',
          { class: 'theme-preview-text' },
          el('span', { text: 'root@host:~$ ' }),
          el('span', { style: { color: definition.palette[2] }, text: 'top' }),
          el('br'),
          el('span', { text: '  PID USER  %CPU  %MEM  COMMAND' }),
          el('br'),
          el('span', { style: { color: definition.palette[4] }, text: ' 1024 root   2.4   0.8  nginx' })
        )
      ),
      el(
        'span',
        { class: 'theme-meta' },
        el('span', { class: 'theme-name', text: definition.label }),
        el('span', { class: 'theme-desc', text: definition.description })
      )
    )
    card.addEventListener('click', () => {
      settings.terminalTheme = name
      themeCards.querySelectorAll('.theme-card').forEach((item) => item.classList.remove('is-active'))
      card.classList.add('is-active')
    })
    themeCards.appendChild(card)
  }

  const fontFamilies = [
    { value: '', label: '默认（Cascadia Mono / Consolas）' },
    { value: 'Consolas, "Microsoft YaHei UI", monospace', label: 'Consolas' },
    { value: '"Cascadia Mono", Consolas, monospace', label: 'Cascadia Mono' },
    { value: '"JetBrains Mono", Consolas, monospace', label: 'JetBrains Mono' },
    { value: '"Fira Code", Consolas, monospace', label: 'Fira Code' },
    { value: '"Microsoft YaHei UI", monospace', label: '微软雅黑等宽' },
    { value: 'monospace', label: '系统等宽字体' }
  ]
  if (!fontFamilies.some((item) => item.value === settings.fontFamily)) {
    fontFamilies.push({ value: settings.fontFamily, label: `自定义：${settings.fontFamily}` })
  }
  const fontSelect = selectInput(fontFamilies, settings.fontFamily, (value) => {
    settings.fontFamily = value
  })
  const fontSizeInput = numberInput({
    value: settings.fontSize,
    min: 9,
    max: 32,
    onInput: (value) => {
      if (value >= 9 && value <= 32) settings.fontSize = value
    }
  })
  const lineHeightInput = numberInput({
    value: settings.lineHeight,
    min: 1,
    max: 2.2,
    step: 0.05,
    onInput: (value) => {
      if (value >= 1 && value <= 2.2) settings.lineHeight = value
    }
  })
  const letterSpacingInput = numberInput({
    value: settings.letterSpacing,
    min: -2,
    max: 4,
    step: 0.5,
    onInput: (value) => {
      if (value >= -2 && value <= 4) settings.letterSpacing = value
    }
  })
  const cursorSelect = selectInput(
    [
      { value: 'block', label: '方块' },
      { value: 'underline', label: '下划线' },
      { value: 'bar', label: '竖线' }
    ],
    settings.cursorStyle,
    (value) => {
      settings.cursorStyle = value as Settings['cursorStyle']
    }
  )
  const scrollbackInput = numberInput({
    value: settings.scrollback,
    min: 1000,
    max: 100000,
    step: 1000,
    onInput: (value) => {
      if (value >= 1000 && value <= 100000) settings.scrollback = value
    }
  })
  const rightClickSelect = selectInput(
    [
      { value: 'contextMenu', label: '右键菜单（推荐）' },
      { value: 'paste', label: '右键粘贴（Xshell 习惯）' },
      { value: 'nothing', label: '不做任何操作' }
    ],
    settings.rightClick,
    (value) => {
      settings.rightClick = value as Settings['rightClick']
    }
  )
  const hostKeySelect = selectInput(
    [
      { value: 'accept-new', label: '接受新主机，密钥变更时阻止（推荐）' },
      { value: 'strict', label: '严格：只连接已信任主机' },
      { value: 'insecure', label: '宽松：接受所有主机密钥' }
    ],
    settings.hostKeyPolicy,
    (value) => {
      settings.hostKeyPolicy = value as Settings['hostKeyPolicy']
    }
  )
  const keepaliveInput = numberInput({
    value: settings.keepaliveInterval,
    min: 0,
    max: 300,
    onInput: (value) => {
      if (value >= 0 && value <= 300) settings.keepaliveInterval = value
    }
  })
  const attemptsInput = numberInput({
    value: settings.autoReconnectAttempts,
    min: 1,
    max: 10,
    onInput: (value) => {
      if (value >= 1 && value <= 10) settings.autoReconnectAttempts = value
    }
  })
  const checkbox = (
    label: string,
    key: keyof Settings,
    hint?: string
  ): HTMLElement =>
    checkboxRow(label, Boolean(settings[key]), {
      hint,
      onChange: (checked) => {
        ;(settings as unknown as Record<string, unknown>)[key] = checked
      }
    })

  const cursorBlink = checkbox('光标闪烁', 'cursorBlink')
  const copyOnSelect = checkbox('选中即复制', 'copyOnSelect', '松开鼠标时自动复制选中的文本')
  const confirmClose = checkbox('关闭会话前确认', 'confirmClose')
  const autoReconnect = checkbox('断线自动重连', 'autoReconnect', '仅对已经建立过的会话生效')
  const bell = checkbox('终端响铃提示', 'bell', '使用屏幕闪烁代替系统提示音')
  const sidebarVisible = checkbox('显示连接面板', 'sidebarVisible')
  const hideSidebarScrollbar = checkbox(
    '隐藏连接树滚动条',
    'hideSidebarScrollbar',
    '默认隐藏，仅保留滚轮/触控板滚动效果'
  )
  const showQuickCommands = checkbox('显示快捷命令', 'showQuickCommands')
  const showStatusBar = checkbox('显示状态栏', 'showStatusBar')
  const relayUrlInput = textInput({
    value: settings.relayUrl,
    placeholder: 'wss://relay.example.com',
    spellcheck: false
  })
  const relayDeviceInput = textInput({
    value: settings.relayDeviceId,
    placeholder: '9 位设备码',
    maxLength: 32,
    spellcheck: false
  })
  const relayTokenInput = textInput({
    value: settings.relayToken,
    placeholder: 'relay-server 的 HOST_TOKEN',
    type: 'password',
    spellcheck: false
  })
  const relayGenerateButton = button('生成', {
    kind: 'ghost',
    onClick: () => {
      const bytes = new Uint32Array(1)
      crypto.getRandomValues(bytes)
      relayDeviceInput.value = String(100000000 + (bytes[0] % 900000000))
    }
  })
  const relayCopyButton = button('复制', {
    kind: 'ghost',
    onClick: () => {
      const code = relayDeviceInput.value.trim()
      if (!code) return
      api.clipboardWrite(code)
      relayCopyButton.textContent = '已复制'
      window.setTimeout(() => {
        if (relayCopyButton.isConnected) relayCopyButton.textContent = '复制'
      }, 1500)
    }
  })
  const relayDeviceControl = el(
    'div',
    { class: 'remote-password-control' },
    relayDeviceInput,
    relayGenerateButton,
    relayCopyButton
  )

  const knownHostsContainer = el('div', { class: 'known-hosts' })
  const renderKnownHosts = () => {
    knownHostsContainer.replaceChildren()
    if (knownHosts.length === 0) {
      knownHostsContainer.appendChild(
        el('div', { class: 'known-hosts-empty', text: '暂无已信任主机。首次连接并接受指纹后会显示在这里。' })
      )
      return
    }
    for (const host of [...knownHosts].sort((a, b) => a.host.localeCompare(b.host))) {
      const remove = el(
        'button',
        {
          class: 'icon-btn small danger',
          type: 'button',
          title: `删除 ${host.host} 的主机密钥`,
          html: icon('trash', 14)
        },
        null
      )
      remove.addEventListener('click', async () => {
        try {
          const next = await api.deleteKnownHost(host.host)
          knownHosts = next.knownHosts
          options.onSaved(next)
          renderKnownHosts()
          toast.success(`已删除 ${host.host} 的主机密钥`)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error))
        }
      })
      knownHostsContainer.appendChild(
        el(
          'div',
          { class: 'known-host-row' },
          el('span', { class: 'known-host-icon', html: icon('shield', 16) }),
          el(
            'span',
            { class: 'known-host-main' },
            el('span', { class: 'known-host-name', text: host.host }),
            el('span', { class: 'known-host-fingerprint', text: host.fingerprint }),
            el('span', {
              class: 'known-host-meta',
              text: `${host.algorithm || 'SSH'} · 添加于 ${formatRelativeTime(host.addedAt)}`
            })
          ),
          remove
        )
      )
    }
  }
  renderKnownHosts()

  const clearHostsButton = button('清空已信任主机', {
    kind: 'ghost',
    icon: 'trash',
    onClick: async () => {
      if (clearHostsButton.dataset.confirm !== '1') {
        clearHostsButton.dataset.confirm = '1'
        clearHostsButton.textContent = '再次点击确认清空'
        setTimeout(() => {
          if (!clearHostsButton.isConnected) return
          clearHostsButton.dataset.confirm = '0'
          clearHostsButton.textContent = '清空已信任主机'
        }, 3500)
        return
      }
      try {
        const next = await api.clearKnownHosts()
        knownHosts = next.knownHosts
        options.onSaved(next)
        renderKnownHosts()
        toast.success('已清空所有主机密钥')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
      clearHostsButton.dataset.confirm = '0'
      clearHostsButton.textContent = '清空已信任主机'
    }
  })

  const resetButton = button('恢复默认', {
    kind: 'ghost',
    onClick: () => {
      settings = { ...DEFAULT_SETTINGS }
      themeControl.value = 'light'
      document.documentElement.dataset.theme = 'light'
      fontSizeInput.value = String(settings.fontSize)
      lineHeightInput.value = String(settings.lineHeight)
      letterSpacingInput.value = String(settings.letterSpacing)
      scrollbackInput.value = String(settings.scrollback)
      keepaliveInput.value = String(settings.keepaliveInterval)
      attemptsInput.value = String(settings.autoReconnectAttempts)
      relayUrlInput.value = settings.relayUrl
      relayDeviceInput.value = settings.relayDeviceId
      relayTokenInput.value = settings.relayToken
      fontSelect.value = settings.fontFamily
      cursorSelect.value = settings.cursorStyle
      rightClickSelect.value = settings.rightClick
      hostKeySelect.value = settings.hostKeyPolicy
      themeCards.querySelectorAll('.theme-card').forEach((item, index) => {
        item.classList.toggle('is-active', index === 0)
      })
      const boxes = [
        [cursorBlink, 'cursorBlink'],
        [copyOnSelect, 'copyOnSelect'],
        [confirmClose, 'confirmClose'],
        [autoReconnect, 'autoReconnect'],
        [bell, 'bell'],
        [sidebarVisible, 'sidebarVisible'],
        [hideSidebarScrollbar, 'hideSidebarScrollbar'],
        [showQuickCommands, 'showQuickCommands'],
        [showStatusBar, 'showStatusBar']
      ] as const
      for (const [row, key] of boxes) {
        const input = row.querySelector('input')
        if (input) input.checked = Boolean(settings[key])
      }
      document.documentElement.dataset.theme = settings.theme
    }
  })

  const saveButton = button('保存设置', { kind: 'primary' })
  const form = el(
    'div',
    { class: 'settings-form' },
    formCard(
      '外观',
      '界面主题与终端配色相互独立；终端颜色始终以服务器实际输出为准。',
      field('界面主题', themeControl, { wide: true }),
      el('div', { class: 'field-label-block' }, '终端配色'),
      themeCards,
      formGrid(
        field('字体', fontSelect, { wide: true }),
        field('字号', fontSizeInput),
        field('行高', lineHeightInput),
        field('字间距', letterSpacingInput),
        field('光标样式', cursorSelect),
        field('回滚行数', scrollbackInput)
      ),
      cursorBlink
    ),
    formCard(
      '交互',
      '',
      copyOnSelect,
      field('右键行为', rightClickSelect),
      confirmClose,
      bell
    ),
    formCard(
      '连接',
      '',
      formGrid(
        field('默认主机密钥策略', hostKeySelect),
        field('默认保活间隔（秒）', keepaliveInput)
      ),
      autoReconnect,
      field('最大重连次数', attemptsInput),
      sidebarVisible,
      hideSidebarScrollbar,
      showQuickCommands,
      showStatusBar
    ),
    formCard(
      '远程控制（WebRTC 中继）',
      '默认开启；关闭主窗口会隐藏到托盘并保持中继在线。设备码相当于本机连接入口，请勿随意泄露。',
      formGrid(
        field('中继地址', relayUrlInput, {
          wide: true,
          hint: '填写你自行部署的 relay 地址，留空则远程控制不连接中继'
        }),
        field('本机设备码', relayDeviceControl, {
          hint: '控制端输入这串设备码即可找到本机'
        }),
        field('HOST_TOKEN', relayTokenInput, {
          hint: '与公网 relay-server.js 的 HOST_TOKEN 一致'
        })
      )
    ),
    formCard(
      '安全',
      'HongSSH 会记录首次连接的主机指纹，并在指纹变化时阻止连接。',
      el(
        'div',
        { class: 'security-summary' },
        el('span', { html: icon(state.secretsEncrypted ? 'shield' : 'warning', 18) }),
        el(
          'div',
          {},
          el('strong', {
            text: state.secretsEncrypted ? '密码使用系统安全存储加密' : '当前系统不支持安全凭据存储'
          }),
          el('span', {
            text: state.secretsEncrypted
              ? '密码通过 Windows DPAPI 加密后保存在本机数据目录。'
              : '密码不会写入磁盘，每次连接都需要重新输入。'
          })
        )
      ),
      el(
        'div',
        { class: 'known-hosts-header' },
        el('span', { class: 'field-label-block', text: `已信任主机（${knownHosts.length}）` }),
        clearHostsButton
      ),
      knownHostsContainer
    ),
    formCard(
      '数据',
      '',
      el(
        'div',
        { class: 'data-folder-row' },
        el(
          'div',
          {},
          el('span', { class: 'field-label-block', text: '数据目录' }),
          el('code', { class: 'data-folder-path', text: state.dataDir })
        ),
        button('打开目录', {
          kind: 'ghost',
          icon: 'external',
          onClick: () => void api.openDataFolder()
        })
      )
    )
  )

  const footer = el(
    'div',
    { class: 'dialog-footer' },
    el('div', { class: 'dialog-footer-left' }, resetButton),
    el(
      'div',
      { class: 'dialog-footer-right' },
      button('取消', { kind: 'ghost', onClick: () => handle.close() }),
      saveButton
    )
  )

  const handle: ModalHandle = modal.open({
    title: '设置',
    subtitle: '所有设置保存在本机，不会同步到远端服务器。',
    icon: 'settings',
    width: 840,
    closeOnBackdrop: false,
    body: el('div', { class: 'dialog-scroll settings-scroll' }, form),
    footer,
    onClose: () => {
      if (!saved) document.documentElement.dataset.theme = originalTheme
    }
  })

  saveButton.addEventListener('click', async () => {
    settings.relayUrl = relayUrlInput.value.trim()
    settings.relayDeviceId = relayDeviceInput.value.trim()
    settings.relayToken = relayTokenInput.value.trim()
    settings.remoteEnabled = true
    if (!settings.relayUrl) {
      toast.error('请填写中继服务器地址')
      relayUrlInput.focus()
      return
    }
    if (!/^(wss?|https?):\/\//i.test(settings.relayUrl)) {
      toast.error('中继地址需要以 ws://、wss://、http:// 或 https:// 开头')
      relayUrlInput.focus()
      return
    }
    if (!/^[A-Za-z0-9-]{6,32}$/.test(settings.relayDeviceId)) {
      toast.error('设备码需要 6–32 位字母、数字或短横线')
      relayDeviceInput.focus()
      return
    }
    if (!settings.relayToken) {
      toast.error('请填写中继服务器的 HOST_TOKEN')
      relayTokenInput.focus()
      return
    }
    saveButton.disabled = true
    saveButton.textContent = '保存中…'
    try {
      const next = await api.saveSettings(settings)
      saved = true
      options.onSaved(next)
      handle.close()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      saveButton.disabled = false
      saveButton.textContent = '保存设置'
    }
  })
}

export function settingsSummary(state: AppState): string {
  return `${state.connections.length} 个连接 · ${state.folders.length} 个分组`
}
