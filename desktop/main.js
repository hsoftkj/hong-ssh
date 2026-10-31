'use strict'

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  shell,
  session,
  clipboard,
  nativeImage,
  globalShortcut
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const { Store } = require('./store')
const { Logger } = require('./logger')
const { SshManager, testConnection } = require('./ssh-manager')
const { DragDownloadService } = require('./drag-download')
const { RemoteHost } = require('./remote-host')
const { RemoteClient } = require('./remote-client')
const { WebRtcHostAgent, WebRtcController } = require('./webrtc-transport')
const { ScreenRecorder } = require('./screen-recorder')
const { ScreenshotCapture } = require('./screenshot-capture')
const { scanXshellFolder } = require('./xshell-import')
const { exportXshellSessions } = require('./xshell-export')
const { AppUpdater } = require('./app-update')

const APP_NAME = 'HongSSH'
const MIN_WINDOW_WIDTH = 980
const MIN_WINDOW_HEIGHT = 620
const IS_DEV = Boolean(process.env.VITE_DEV_SERVER_URL)
const IS_E2E = process.env.HONGSSH_E2E === '1'
const NO_CONFIRM = process.env.HONGSSH_NO_CONFIRM === '1'
const ROOT = path.join(__dirname, '..')
const execFileAsync = promisify(execFile)

app.commandLine.appendSwitch('force-color-profile', 'srgb')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.env.HONGSSH_DISABLE_GPU === '1') app.disableHardwareAcceleration()

const userDataOverride = process.env.HONGSSH_DATA_DIR
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride))
}
app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId('com.hong.hongssh')

// One process owns the tray and the global shortcuts. A second launch focuses
// the existing window instead of creating another tray icon. Set
// HONGSSH_SINGLE_INSTANCE=0 only when intentionally running isolated instances.
// The NSIS installer terminates every HongSSH.exe process before replacing
// files, so an upgrade closes all open windows first.
const singleInstance = process.env.HONGSSH_SINGLE_INSTANCE !== '0'
const primaryInstance = singleInstance ? app.requestSingleInstanceLock() : true
if (!primaryInstance) {
  app.quit()
}

let mainWindow = null
let store = null
let manager = null
let dragDownload = null
let logger = null
let remoteHost = null
let relayAgent = null
let screenRecorder = null
let screenshotCapture = null
let remoteSharedDir = ''
const remoteSessions = new Map()
let remoteRestartChain = Promise.resolve()
let tray = null
let trayNotified = false
let remoteStatus = { running: false, port: 0, clients: 0 }
let quitting = false
let allowClose = false
let quitPromptOpen = false
let rendererReady = false
let windowStateTimer = null
let dataDir = ''
let updater = null

function logPath() {
  return path.join(dataDir, 'logs')
}

function readWindowState() {
  try {
    const file = path.join(dataDir, 'window-state.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (
      Number.isFinite(data.width) &&
      Number.isFinite(data.height) &&
      data.width >= MIN_WINDOW_WIDTH &&
      data.height >= MIN_WINDOW_HEIGHT
    ) {
      return {
        width: Math.min(3200, Math.round(data.width)),
        height: Math.min(2000, Math.round(data.height)),
        x: Number.isFinite(data.x) ? Math.round(data.x) : undefined,
        y: Number.isFinite(data.y) ? Math.round(data.y) : undefined,
        maximized: Boolean(data.maximized)
      }
    }
  } catch {
    // First launch.
  }
  return { width: 1000, height: 800, maximized: false }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !dataDir) return
  try {
    const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(dataDir, 'window-state.json'),
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }, null, 2),
      'utf8'
    )
  } catch {
    // Window geometry is a convenience only.
  }
}

function scheduleWindowStateSave() {
  clearTimeout(windowStateTimer)
  windowStateTimer = setTimeout(saveWindowState, 350)
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function trayImage() {
  const png = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
  if (!png.isEmpty()) return png.resize({ width: 16, height: 16 })
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'))
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  saveWindowState()
  mainWindow.hide()
  if (!trayNotified && tray) {
    trayNotified = true
    try {
      tray.displayBalloon({
        title: 'HongSSH 仍在运行',
        content: remoteStatus.running
          ? '远程控制正在通过中继服务器运行，窗口已隐藏到托盘。'
          : '窗口已隐藏到托盘；在设置中启用远程控制后可被连接。'
      })
    } catch {
      // Balloon notifications can be disabled by the OS.
    }
  }
  updateTrayMenu()
}

function updateTrayMenu(status) {
  if (status) remoteStatus = { ...remoteStatus, ...status }
  if (!tray) return
  const enabled = Boolean(store?.data.settings.remoteEnabled)
  const statusLabel = remoteStatus.running
    ? '远程控制：中继已启用'
    : enabled
      ? '远程控制：未连接中继'
      : '远程控制：未启用'
  const template = [
    { label: '显示 HongSSH', click: () => showMainWindow() },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    ...(remoteStatus.clients > 0
      ? [{ label: `已连接 ${remoteStatus.clients} 个控制端`, enabled: false }]
      : []),
    { type: 'separator' },
    { label: '检查更新…', click: () => { if (updater) void updater.checkForUpdates({ interactive: true }) } },
    { type: 'separator' },
    { label: '退出 HongSSH', click: () => app.quit() }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.setToolTip(`HongSSH - ${statusLabel}`)
}

function createTray() {
  if (tray || IS_E2E) return
  try {
    const image = trayImage()
    if (image.isEmpty()) {
      logger?.warn('tray icon is empty')
      return
    }
    tray = new Tray(image)
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
    updateTrayMenu()
  } catch (error) {
    logger?.warn('could not create tray', error)
    tray = null
  }
}

function stopRelayHost() {
  if (!relayAgent) return
  try {
    relayAgent.stop()
  } catch {}
  relayAgent = null
}

function restartRelayHost() {
  stopRelayHost()
  if (!remoteHost || !store || !remoteHost.isRunning()) return
  const settings = store.data.settings
  if (!settings.relayEnabled) return
  if (!settings.relayUrl || !settings.relayToken || !settings.relayDeviceId) {
    logger?.warn('webrtc relay is enabled but not fully configured')
    return
  }
  relayAgent = new WebRtcHostAgent({
    url: settings.relayUrl,
    token: settings.relayToken,
    deviceId: settings.relayDeviceId,
    host: remoteHost,
    logger,
    onStatus: (status) => sendToRenderer('relay:status', status)
  })
  relayAgent.start()
}

async function restartRemoteHost() {
  if (!remoteHost || !store) return
  try {
    await remoteHost.startRelayOnly()
    restartRelayHost()
  } catch (error) {
    stopRelayHost()
    logger?.error('remote host start failed', error)
    sendToRenderer('remote:status', {
      running: false,
      port: 0,
      clients: 0,
      error: error.message
    })
  }
}

function scheduleRemoteRestart() {
  remoteRestartChain = remoteRestartChain
    .catch(() => {})
    .then(() => restartRemoteHost())
    .catch((error) => logger?.error('remote restart failed', error))
  return remoteRestartChain
}

// Ask the renderer to show the themed quit confirmation. The window stays
// open until the user answers; `allowClose` is only set after confirmation.
function requestQuitConfirmation() {
  if (quitPromptOpen) return
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  if (!rendererReady) return
  const active = manager ? manager.activeCount() : 0
  quitPromptOpen = true
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('app:confirm-quit', { active })
}

function sendMenuAction(action) {
  sendToRenderer('app:menu-action', action)
}

function registerGlobalShortcuts() {
  const shortcuts = [
    ['CommandOrControl+Shift+X', 'screenshot', '截图'],
    ['CommandOrControl+Shift+F10', 'toggle-recording', '录屏']
  ]
  for (const [accelerator, action, label] of shortcuts) {
    try {
      const click =
        action === 'toggle-recording'
          ? () => {
              if (screenRecorder?.active) void screenRecorder.stop()
              else sendMenuAction('toggle-recording')
            }
          : () => sendMenuAction(action)
      const ok = globalShortcut.register(accelerator, click)
      if (!ok) logger?.warn(`global shortcut unavailable: ${label} (${accelerator})`)
    } catch (error) {
      logger?.warn(`could not register global shortcut: ${label}`, error)
    }
  }
}

function sendWindowMaximized(maximized) {
  sendToRenderer('window:maximized', Boolean(maximized))
}

async function readClipboardFilePaths() {
  const paths = []
  const seen = new Set()
  const addPath = (value) => {
    let candidate = String(value || '').replace(/\0/g, '').replace(/^\uFEFF/, '').trim()
    if (candidate.length >= 2 && /^".*"$/.test(candidate)) candidate = candidate.slice(1, -1)
    if (!candidate || !path.isAbsolute(candidate)) return
    let exists = false
    try {
      exists = fs.existsSync(candidate)
    } catch {
      exists = false
    }
    if (!exists) return
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return
    seen.add(key)
    paths.push(candidate)
  }

  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '$list = [System.Windows.Forms.Clipboard]::GetFileDropList()',
      'foreach ($item in $list) { [Console]::Out.WriteLine($item) }'
    ].join('; ')
    const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    try {
      const { stdout } = await execFileAsync(
        powershell,
        ['-NoProfile', '-STA', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }
      )
      for (const line of String(stdout || '').split(/\r?\n/)) addPath(line)
    } catch {
      // Fall through to Electron clipboard formats.
    }
  }

  if (paths.length === 0) {
    try {
      if (clipboard.has('FileNameW')) {
        const buffer = clipboard.readBuffer('FileNameW')
        let offset = 0
        if (
          buffer.length >= 20 &&
          buffer.readUInt32LE(0) === 20 &&
          buffer.readUInt32LE(16) === 1
        ) {
          offset = 20
        }
        for (const part of buffer.subarray(offset).toString('utf16le').split('\0')) addPath(part)
      }
    } catch {
      // Fall back to text paths below.
    }
  }

  if (paths.length === 0) {
    try {
      if (clipboard.has('FileName')) {
        for (const part of clipboard.readBuffer('FileName').toString('latin1').split('\0')) {
          addPath(part)
        }
      }
    } catch {
      // Ignore and try plain text.
    }
  }

  if (paths.length === 0) {
    try {
      for (const line of clipboard.readText().split(/\r?\n/)) addPath(line)
    } catch {
      // Ignore.
    }
  }

  return paths
}

function handleAppShortcut(event, input) {
  if (!mainWindow || mainWindow.isDestroyed() || input.type !== 'keyDown') return
  const key = String(input.key || '').toLowerCase()
  const ctrl = Boolean(input.control)
  const shift = Boolean(input.shift)
  const alt = Boolean(input.alt)
  let handled = true

  if (ctrl && !alt) {
    if (key === 'tab') {
      sendMenuAction(shift ? 'previous-tab' : 'next-tab')
    } else if (key === '=' || key === '+') {
      sendMenuAction('zoom-in')
    } else if (key === '-') {
      sendMenuAction('zoom-out')
    } else if (key === '0') {
      sendMenuAction('zoom-reset')
    } else if (shift) {
      switch (key) {
        case 'c':
          sendMenuAction('copy')
          break
        case 'v':
          sendMenuAction('paste')
          break
        case 'a':
          sendMenuAction('select-all')
          break
        case 'e':
          sendMenuAction('toggle-files')
          break
        case 'x':
          sendMenuAction('screenshot')
          break
        case 'w':
          sendMenuAction('close-tab')
          break
        case 'i':
          if (IS_DEV) mainWindow.webContents.toggleDevTools()
          else handled = false
          break
        default:
          handled = false
      }
    } else {
      switch (key) {
        case 'n':
          sendMenuAction('new-connection')
          break
        case 'w':
          sendMenuAction('close-tab')
          break
        case 'f':
          sendMenuAction('find')
          break
        case 'r':
          sendMenuAction('reconnect')
          break
        case 'b':
          sendMenuAction('toggle-sidebar')
          break
        case ',':
          sendMenuAction('settings')
          break
        default:
          handled = false
      }
    }
  } else if (!ctrl && !shift && !alt) {
    if (key === 'f1') sendMenuAction('shortcuts')
    else if (key === 'f11') mainWindow.setFullScreen(!mainWindow.isFullScreen())
    else if (key === 'f12' && IS_DEV) mainWindow.webContents.toggleDevTools()
    else handled = false
  } else if (alt && key === 'f4') {
    mainWindow.close()
  } else {
    handled = false
  }

  if (handled) event.preventDefault()
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建连接',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-connection')
        },
        {
          label: '导入配置…',
          click: () => sendMenuAction('import-xshell')
        },
        {
          label: '导出配置…',
          click: () => sendMenuAction('export-config')
        },
        {
          label: '截图',
          accelerator: 'CmdOrCtrl+Shift+X',
          click: () => sendMenuAction('screenshot')
        },
        { type: 'separator' },
        {
          label: '关闭当前会话',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendMenuAction('close-tab')
        },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(dataDir) },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        {
          label: '复制',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => sendMenuAction('copy')
        },
        {
          label: '粘贴',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => sendMenuAction('paste')
        },
        { type: 'separator' },
        {
          label: '查找',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendMenuAction('find')
        },
        {
          label: '全选',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => sendMenuAction('select-all')
        },
        { type: 'separator' },
        { label: '清屏', click: () => sendMenuAction('clear') }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '放大字体',
          accelerator: 'CmdOrCtrl+=',
          click: () => sendMenuAction('zoom-in')
        },
        {
          label: '缩小字体',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendMenuAction('zoom-out')
        },
        {
          label: '重置字体大小',
          accelerator: 'CmdOrCtrl+0',
          click: () => sendMenuAction('zoom-reset')
        },
        { type: 'separator' },
        {
          label: '显示/隐藏连接面板',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggle-sidebar')
        },
        {
          label: '文件传输面板',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => sendMenuAction('toggle-files')
        },
        {
          label: '切换深色模式',
          click: () => sendMenuAction('toggle-theme')
        },
        {
          label: '切换终端配色',
          click: () => sendMenuAction('cycle-terminal-theme')
        },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        ...(IS_DEV
          ? [{ label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' }]
          : [])
      ]
    },
    {
      label: '会话',
      submenu: [
        {
          label: '重新连接',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendMenuAction('reconnect')
        },
        {
          label: '断开连接',
          click: () => sendMenuAction('disconnect')
        },
        { type: 'separator' },
        {
          label: '下一个标签页',
          accelerator: 'Ctrl+Tab',
          click: () => sendMenuAction('next-tab')
        },
        {
          label: '上一个标签页',
          accelerator: 'Ctrl+Shift+Tab',
          click: () => sendMenuAction('previous-tab')
        },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => sendMenuAction('close-tab')
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '快捷键',
          accelerator: 'F1',
          click: () => sendMenuAction('shortcuts')
        },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('settings')
        },
        { type: 'separator' },
        {
          label: '关于 HongSSH',
          click: () => sendMenuAction('about')
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const state = readWindowState()
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: APP_NAME,
    frame: false,
    thickFrame: true,
    backgroundColor: '#f2f3f5',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      contextMenu: false
    }
  })

  if (state.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.show()
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' })
    screenshotCapture?.warmup()
  })

  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('move', scheduleWindowStateSave)
  mainWindow.on('maximize', () => {
    scheduleWindowStateSave()
    sendWindowMaximized(true)
  })
  mainWindow.on('unmaximize', () => {
    scheduleWindowStateSave()
    sendWindowMaximized(false)
  })

  mainWindow.on('close', (event) => {
    if (allowClose || NO_CONFIRM || IS_E2E || !rendererReady) {
      saveWindowState()
      return
    }
    event.preventDefault()
    if (!tray) {
      requestQuitConfirmation()
      return
    }
    hideMainWindowToTray()
  })

  mainWindow.on('closed', () => {
    screenshotCapture?.destroyWarmOverlays()
    mainWindow = null
  })

  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true
    quitPromptOpen = false
  })

  mainWindow.webContents.on('render-process-gone', () => {
    rendererReady = false
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url)
    if (IS_DEV) {
      if (target.origin !== new URL(process.env.VITE_DEV_SERVER_URL).origin) event.preventDefault()
    } else if (target.protocol !== 'file:') {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    handleAppShortcut(event, input)
  })

  if (IS_DEV) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(ROOT, 'dist', 'index.html'))
  }
}

function openRemoteWindow(connection) {
  return Promise.resolve().then(() => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 860,
      minHeight: 540,
      show: false,
      backgroundColor: '#05080d',
      title: `HongSSH 远程 - ${connection.name}`,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'remote-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        webviewTag: false
      }
    })
    const webContentsId = win.webContents.id
    const session = { win, connection, password: '', client: null, webrtcController: null }
    remoteSessions.set(webContentsId, session)

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show()
    })
    win.on('closed', () => {
      session.webrtcController?.close()
      session.client?.close()
      remoteSessions.delete(webContentsId)
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file:')) event.preventDefault()
    })
    win.loadFile(path.join(__dirname, 'remote-viewer.html')).catch((error) => {
      logger?.error('could not load remote viewer', error)
    })
    return true
  })
}

function remoteSessionFor(event) {
  const session = remoteSessions.get(event.sender.id)
  if (!session || session.win.isDestroyed()) throw new Error('远程窗口已关闭')
  return session
}

function closeAllRemoteWindows() {
  for (const session of [...remoteSessions.values()]) {
    try {
      session.webrtcController?.close()
    } catch {}
    try {
      session.client?.close()
    } catch {}
    try {
      if (!session.win.isDestroyed()) session.win.destroy()
    } catch {}
  }
  remoteSessions.clear()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForRemoteMessage(client, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('远程文件操作超时'))
    }, timeout)
    const cleanup = () => {
      clearTimeout(timer)
      client.off('message', handler)
    }
    const handler = (message, payload) => {
      if (!predicate(message)) return
      cleanup()
      if (message.type === 'file-error') reject(new Error(message.message || '文件操作失败'))
      else resolve({ message, payload })
    }
    client.on('message', handler)
  })
}

function sendFileProgress(session, event) {
  if (session.win.isDestroyed()) return
  session.win.webContents.send('remote:file-progress', event)
}

async function listRemoteFiles(session) {
  if (!session.client) throw new Error('远程桌面尚未连接')
  const requestId = crypto.randomUUID()
  const waiter = waitForRemoteMessage(
    session.client,
    (message) =>
      (message.type === 'file-list' && message.requestId === requestId) ||
      (message.type === 'file-error' && message.id === requestId),
    10000
  )
  session.client.send({ type: 'file-list', requestId })
  const { message } = await waiter
  return { dir: message.dir, entries: message.entries || [] }
}

async function uploadLocalFile(session, localPath) {
  const client = session.client
  if (!client) throw new Error('远程桌面尚未连接')
  const stat = fs.statSync(localPath)
  if (!stat.isFile()) throw new Error('只能上传文件')
  const name = path.basename(localPath)
  const id = crypto.randomUUID()
  sendFileProgress(session, {
    direction: 'upload',
    name,
    transferred: 0,
    total: stat.size,
    status: 'running'
  })
  const readyPromise = waitForRemoteMessage(
    client,
    (message) =>
      message.id === id &&
      ['file-upload-ready', 'file-upload-complete', 'file-error'].includes(message.type),
    15000
  )
  client.send({ type: 'file-upload-start', id, name, size: stat.size })
  const { message: ready } = await readyPromise
  if (ready.type === 'file-error') throw new Error(ready.message)
  if (ready.type === 'file-upload-complete') {
    sendFileProgress(session, {
      direction: 'upload',
      name,
      transferred: stat.size,
      total: stat.size,
      status: 'done'
    })
    return
  }
  const offset = Number(ready.offset) || 0
  if (offset > stat.size) throw new Error('远端已有分片大于本地文件，无法续传')
  if (offset >= stat.size) {
    sendFileProgress(session, {
      direction: 'upload',
      name,
      transferred: stat.size,
      total: stat.size,
      status: 'done'
    })
    return
  }
  const donePromise = waitForRemoteMessage(
    client,
    (message) =>
      message.id === id &&
      ['file-upload-complete', 'file-error'].includes(message.type),
    30 * 60 * 1000
  )
  let sent = offset
  if (offset < stat.size) {
    const stream = fs.createReadStream(localPath, { start: offset, highWaterMark: 64 * 1024 })
    for await (const chunk of stream) {
      if (session.win.isDestroyed() || !client.send({ type: 'file-upload-chunk', id }, chunk)) {
        throw new Error('远程连接已断开')
      }
      sent += chunk.length
      if (sent - offset < 1024 * 1024 || sent >= stat.size) {
        sendFileProgress(session, {
          direction: 'upload',
          name,
          transferred: sent,
          total: stat.size,
          status: 'running'
        })
      }
      while (client.ws?.bufferedAmount > 4 * 1024 * 1024) await delay(20)
    }
  }
  client.send({ type: 'file-upload-end', id })
  const { message: done } = await donePromise
  if (done.type === 'file-error') throw new Error(done.message)
  sendFileProgress(session, {
    direction: 'upload',
    name,
    transferred: stat.size,
    total: stat.size,
    status: 'done'
  })
}

async function uploadLocalFiles(session, paths) {
  for (const localPath of paths) {
    try {
      await uploadLocalFile(session, localPath)
    } catch (error) {
      sendFileProgress(session, {
        direction: 'upload',
        name: path.basename(localPath),
        transferred: 0,
        total: 0,
        status: 'error',
        message: error.message || String(error)
      })
    }
  }
}

function downloadRemoteFile(session, name, directory) {
  const client = session.client
  if (!client) throw new Error('远程桌面尚未连接')
  const safeName = path.basename(String(name || ''))
  if (!safeName) throw new Error('文件名无效')
  const finalPath = path.join(directory, safeName)
  const partPath = `${finalPath}.part`
  let localOffset = 0
  try {
    localOffset = fs.statSync(partPath).size
  } catch {
    localOffset = 0
  }
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let stream = null
    let received = 0
    let total = 0
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      client.off('message', handler)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        stream?.destroy()
      } catch {}
      sendFileProgress(session, {
        direction: 'download',
        name: safeName,
        transferred: received,
        total,
        status: 'error',
        message: error.message || String(error)
      })
      reject(error)
    }
    const finish = () => {
      if (settled) return
      const complete = () => {
        if (settled) return
        try {
          if (received < total) throw new Error('下载数据不完整')
          if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true })
          fs.renameSync(partPath, finalPath)
          settled = true
          cleanup()
          sendFileProgress(session, {
            direction: 'download',
            name: safeName,
            transferred: received,
            total,
            status: 'done'
          })
          resolve(finalPath)
        } catch (error) {
          settled = false
          fail(error)
        }
      }
      if (stream) stream.end(complete)
      else complete()
    }
    const handler = (message, payload) => {
      if (message.id !== id) return
      if (message.type === 'file-error') {
        fail(new Error(message.message || '下载失败'))
        return
      }
      if (message.type === 'file-download-start') {
        try {
          total = Number(message.size) || 0
          received = Number(message.offset) || 0
          fs.mkdirSync(directory, { recursive: true })
          if (localOffset > received) fs.truncateSync(partPath, received)
          stream = fs.createWriteStream(
            partPath,
            received > 0 ? { flags: 'r+', start: received } : { flags: 'w' }
          )
          stream.on('error', fail)
          sendFileProgress(session, {
            direction: 'download',
            name: safeName,
            transferred: received,
            total,
            status: 'running'
          })
        } catch (error) {
          fail(error)
        }
        return
      }
      if (message.type === 'file-download-chunk') {
        if (!stream || !payload) return
        stream.write(payload)
        received += payload.length
        if (received < total || received === total) {
          sendFileProgress(session, {
            direction: 'download',
            name: safeName,
            transferred: received,
            total,
            status: 'running'
          })
        }
        return
      }
      if (message.type === 'file-download-complete') {
        finish()
      }
    }
    timer = setTimeout(() => fail(new Error('下载超时')), 30 * 60 * 1000)
    client.on('message', handler)
    sendFileProgress(session, {
      direction: 'download',
      name: safeName,
      transferred: localOffset,
      total: 0,
      status: 'running'
    })
    client.send({
      type: 'file-download-start',
      id,
      name: safeName,
      offset: localOffset
    })
  })
}


function requireMainWindow(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('非法调用来源')
  }
}

function registerIpc() {
  ipcMain.handle('app:info', (event) => {
    requireMainWindow(event)
    return {
      name: APP_NAME,
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      dataDir,
      isDev: IS_DEV
    }
  })

  ipcMain.handle('update:check', (event) => {
    requireMainWindow(event)
    return updater ? updater.checkForUpdates({ interactive: true }) : { phase: 'idle' }
  })

  ipcMain.handle('update:state', (event) => {
    requireMainWindow(event)
    return updater ? updater.getState() : null
  })

  ipcMain.handle('update:info', (event) => {
    requireMainWindow(event)
    return updater ? updater.info() : null
  })

  ipcMain.handle('state:load', (event) => {
    requireMainWindow(event)
    return store.publicState()
  })

  ipcMain.handle('settings:save', (event, patch) => {
    requireMainWindow(event)
    const next = store.saveSettings(patch)
    updateTrayMenu()
    void scheduleRemoteRestart()
    return next
  })

  ipcMain.handle('remote:open-window', (event, id) => {
    requireMainWindow(event)
    const connection = store.getConnection(String(id))
    if (!connection || connection.protocol !== 'remoteDesktop') {
      throw new Error('远程桌面连接不存在')
    }
    return openRemoteWindow(connection)
  })

  ipcMain.handle('remote:info', (event) => {
    const session = remoteSessionFor(event)
    return {
      name: session.connection.name,
      host: session.connection.host,
      port: session.connection.port,
      relay: true,
      relayDeviceId: session.connection.relayDeviceId || '',
      relayUrl: session.connection.relayUrl || '',
      quality: Number(session.connection.remoteQuality) || 62,
      refreshMs: Number(session.connection.remoteRefreshMs) || 200
    }
  })

  ipcMain.handle('remote:connect', async (event) => {
    const session = remoteSessionFor(event)
    if (session.client) {
      session.client.close()
      session.client = null
    }
    session.webrtcController?.close()
    session.webrtcController = null
    let socket = null
    if (!session.connection.relayUrl || !session.connection.relayDeviceId) {
      throw new Error('请先编辑远程连接，填写对方设备码')
    }
    const controller = new WebRtcController({
      url: session.connection.relayUrl,
      deviceId: session.connection.relayDeviceId,
      logger
    })
    session.webrtcController = controller
    try {
      socket = await controller.connect()
      logger?.info('webrtc controller transport ready', {
        deviceId: session.connection.relayDeviceId
      })
    } catch (error) {
      session.webrtcController = null
      throw new Error(`中继连接失败：${error.message || error}`)
    }
    const client = new RemoteClient()
    session.client = client
    client.on('frame', (header, data) => {
      if (session.client !== client) return
      if (!session.win.isDestroyed()) {
        session.win.webContents.send('remote:frame', header, data)
      }
    })
    client.on('cursor', (cursor) => {
      if (session.client !== client) return
      if (!session.win.isDestroyed()) {
        session.win.webContents.send('remote:cursor', cursor)
      }
    })
    client.on('welcome', (welcome) => {
      if (session.client !== client) return
      if (!session.win.isDestroyed()) {
        session.win.webContents.send('remote:welcome', welcome)
      }
    })
    client.on('status', (status) => {
      if (session.client !== client) return
      if (!session.win.isDestroyed()) {
        session.win.webContents.send('remote:status', status)
      }
    })
    client.on('message', (message) => {
      if (session.client !== client) return
      if (message.type === 'display-changed' && !session.win.isDestroyed()) {
        session.win.webContents.send('remote:display', message.display)
      }
    })
    client.on('remote-error', (message) => {
      if (session.client !== client) return
      if (!session.win.isDestroyed()) {
        session.win.webContents.send('remote:error', message)
      }
    })
    client.on('error', (error) => {
      if (session.client !== client) return
      if (!session.win.isDestroyed()) {
        session.win.webContents.send('remote:error', error.message || String(error))
      }
    })
    try {
      return await client.connect({
        socket,
        host: session.connection.host,
        port: session.connection.port,
        password: session.password,
        refreshMs: Number(session.connection.remoteRefreshMs) || 200,
        quality: Number(session.connection.remoteQuality) || 62
      })
    } catch (error) {
      if (session.client === client) session.client = null
      session.webrtcController?.close()
      session.webrtcController = null
      client.close()
      throw new Error(error.message || String(error))
    }
  })

  ipcMain.on('remote:input', (event, message) => {
    const session = remoteSessions.get(event.sender.id)
    if (!session?.client || !message || typeof message !== 'object') return
    if (message.type === 'mouse') session.client.mouse(message)
    else if (message.type === 'key') session.client.key(message)
  })

  ipcMain.on('remote:stream', (event, options) => {
    const session = remoteSessions.get(event.sender.id)
    if (!session?.client) return
    const refreshMs = Math.min(2000, Math.max(50, Number(options?.refreshMs) || 200))
    const quality = Math.min(85, Math.max(30, Number(options?.quality) || 62))
    session.client.setStream(refreshMs, quality)
  })

  ipcMain.on('remote:request-full', (event) => {
    const session = remoteSessions.get(event.sender.id)
    if (!session?.client) return
    session.client.send({ type: 'request-full' })
  })

  ipcMain.on('remote:display', (event, displayId) => {
    const session = remoteSessions.get(event.sender.id)
    if (!session?.client) return
    session.client.setDisplay(String(displayId))
  })

  ipcMain.on('remote:close-window', (event) => {
    const session = remoteSessions.get(event.sender.id)
    session?.win.close()
  })

  ipcMain.handle('remote:list-files', async (event) => {
    const session = remoteSessionFor(event)
    return listRemoteFiles(session)
  })

  ipcMain.handle('remote:upload', async (event) => {
    const session = remoteSessionFor(event)
    if (!session.client) throw new Error('远程桌面尚未连接')
    const result = await dialog.showOpenDialog(session.win, {
      title: '选择要上传到远程共享文件夹的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return 0
    void uploadLocalFiles(session, result.filePaths)
    return result.filePaths.length
  })

  ipcMain.handle('remote:download', async (event, name) => {
    const session = remoteSessionFor(event)
    if (!session.client) throw new Error('远程桌面尚未连接')
    const result = await dialog.showOpenDialog(session.win, {
      title: '选择下载保存目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return downloadRemoteFile(session, String(name || ''), result.filePaths[0])
  })

  ipcMain.handle('connection:save', (event, payload) => {
    requireMainWindow(event)
    return store.saveConnection(payload)
  })

  ipcMain.handle('connection:delete', (event, id) => {
    requireMainWindow(event)
    return store.deleteConnection(String(id))
  })

  ipcMain.handle('folder:save', (event, payload) => {
    requireMainWindow(event)
    return store.saveFolder(payload)
  })

  ipcMain.handle('folder:delete', (event, id) => {
    requireMainWindow(event)
    return store.deleteFolder(String(id))
  })

  ipcMain.handle('state:move', (event, payload) => {
    requireMainWindow(event)
    return store.moveItems(payload)
  })

  ipcMain.handle('dialog:private-key', async (event) => {
    requireMainWindow(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 SSH 私钥',
      properties: ['openFile'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? '' : result.filePaths[0]
  })

  ipcMain.handle('dialog:folder', async (event) => {
    requireMainWindow(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件夹',
      properties: ['openDirectory']
    })
    return result.canceled ? '' : result.filePaths[0]
  })

  ipcMain.handle('dialog:pick-files', async (event) => {
    requireMainWindow(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件',
      buttonLabel: '上传',
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:pick-upload-folder', async (event) => {
    requireMainWindow(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件夹',
      buttonLabel: '上传',
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:pick-directory', async (event) => {
    requireMainWindow(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载保存目录',
      buttonLabel: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? '' : result.filePaths[0]
  })

  ipcMain.handle('xshell:import', async (event) => {
    requireMainWindow(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择配置文件夹',
      buttonLabel: '导入',
      properties: ['openDirectory'],
      message: '选择 HongSSH 配置文件夹或解压后的 Xshell Sessions 文件夹'
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importFromDirectory(result.filePaths[0])
  })

  ipcMain.handle('xshell:import-path', (event, directory) => {
    requireMainWindow(event)
    if (typeof directory !== 'string' || !directory) throw new Error('文件夹路径无效')
    return importFromDirectory(directory)
  })

  ipcMain.handle('xshell:export', async (event) => {
    requireMainWindow(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择配置导出位置',
      buttonLabel: '导出到此处',
      properties: ['openDirectory', 'createDirectory'],
      message: '会在所选目录下创建 HongSSH-配置 文件夹，包含连接和密码，请妥善保管'
    })
    if (result.canceled || !result.filePaths[0]) return null
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 15)
    let target = path.join(result.filePaths[0], `HongSSH-配置-${stamp}`)
    let suffix = 2
    while (fs.existsSync(target)) {
      target = path.join(result.filePaths[0], `HongSSH-配置-${stamp}-${suffix}`)
      suffix += 1
    }
    const publicState = store.publicState()
    const exportState = {
      ...publicState,
      connections: publicState.connections.map((connection) => ({
        ...connection,
        password: store.getSecret(connection.id, 'password'),
        passphrase: store.getSecret(connection.id, 'passphrase')
      }))
    }
    const summary = exportXshellSessions(exportState, target)
    logger?.info('config export', {
      directory: target,
      connections: summary.connections,
      folders: summary.folders,
      passwords: summary.passwords
    })
    return { directory: target, ...summary }
  })

  ipcMain.handle('ssh:test', async (event, payload) => {
    requireMainWindow(event)
    const config = payload?.connection
    if (!config || typeof config !== 'object') throw new Error('连接配置无效')
    if (!config.host || !config.username) throw new Error('请填写主机和用户名')
    const password =
      typeof payload.password === 'string' && payload.password
        ? payload.password
        : config.id
          ? store.getSecret(config.id, 'password')
          : ''
    const passphrase =
      typeof payload.passphrase === 'string' && payload.passphrase
        ? payload.passphrase
        : config.id
          ? store.getSecret(config.id, 'passphrase')
          : ''
    return testConnection(config, { password, passphrase })
  })

  ipcMain.handle('inspection:run', (event, payload) => {
    requireMainWindow(event)
    return manager.runInspection(payload || {})
  })

  ipcMain.handle('inspection:cancel', (event, runId) => {
    requireMainWindow(event)
    return manager.cancelInspection(String(runId || ''))
  })

  ipcMain.handle('ssh:open', (event, payload) => {
    requireMainWindow(event)
    const connectionId = payload?.connectionId
    const connection = store.getConnection(String(connectionId))
    if (!connection) throw new Error('连接不存在，可能已被删除')
    let password =
      typeof payload.password === 'string' && payload.password
        ? payload.password
        : store.getSecret(connection.id, 'password')
    let passphrase =
      typeof payload.passphrase === 'string' && payload.passphrase
        ? payload.passphrase
        : store.getSecret(connection.id, 'passphrase')
    let secretsChanged = false
    if (payload.rememberPassword && typeof payload.password === 'string' && payload.password) {
      try {
        store.setSecret(connection.id, 'password', payload.password)
        secretsChanged = true
      } catch (error) {
        logger?.warn('could not remember password', error.message)
      }
    }
    if (payload.rememberPassphrase && typeof payload.passphrase === 'string' && payload.passphrase) {
      try {
        store.setSecret(connection.id, 'passphrase', payload.passphrase)
        secretsChanged = true
      } catch (error) {
        logger?.warn('could not remember passphrase', error.message)
      }
    }
    if (secretsChanged) {
      try {
        store.persist()
      } catch (error) {
        logger?.warn('could not persist remembered secret', error.message)
      }
    }
    if (connection.authType === 'password' && !password) {
      const error = new Error('请输入登录密码')
      error.code = 'PASSWORD_REQUIRED'
      throw error
    }
    return manager.open({
      id: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      connection,
      password,
      passphrase,
      cols: payload.cols,
      rows: payload.rows
    })
  })

  ipcMain.handle('ssh:write', (event, payload) => {
    requireMainWindow(event)
    return manager.write(String(payload?.sessionId), String(payload?.data ?? ''))
  })

  ipcMain.handle('ssh:resize', (event, payload) => {
    requireMainWindow(event)
    return manager.resize(String(payload?.sessionId), payload?.cols, payload?.rows)
  })

  ipcMain.handle('ssh:reconnect', (event, sessionId) => {
    requireMainWindow(event)
    return manager.reconnect(String(sessionId))
  })

  ipcMain.handle('ssh:disconnect', (event, payload) => {
    requireMainWindow(event)
    const sessionId = String(payload?.sessionId || '')
    if (!sessionId) return false
    manager.disconnect(sessionId, { destroy: payload?.destroy === true })
    return true
  })

  ipcMain.handle('sftp:home', (event, sessionId) => {
    requireMainWindow(event)
    return manager.sftp.home(String(sessionId))
  })

  ipcMain.handle('sftp:list', (event, payload) => {
    requireMainWindow(event)
    return manager.sftp.list(String(payload?.sessionId || ''), String(payload?.path || '.'))
  })

  ipcMain.handle('sftp:mkdir', (event, payload) => {
    requireMainWindow(event)
    return manager.sftp.mkdir(String(payload?.sessionId || ''), String(payload?.path || ''))
  })

  ipcMain.handle('sftp:rename', (event, payload) => {
    requireMainWindow(event)
    return manager.sftp.rename(
      String(payload?.sessionId || ''),
      String(payload?.from || ''),
      String(payload?.to || '')
    )
  })

  ipcMain.handle('sftp:remove', (event, payload) => {
    requireMainWindow(event)
    return manager.sftp.remove(
      String(payload?.sessionId || ''),
      String(payload?.path || ''),
      Boolean(payload?.recursive)
    )
  })

  ipcMain.handle('sftp:drag-start', (event, payload) => {
    requireMainWindow(event)
    if (!dragDownload) throw new Error('拖放下载服务不可用')
    return dragDownload.start(
      String(payload?.sessionId || ''),
      Array.isArray(payload?.items) ? payload.items : [],
      typeof payload?.dragImage === 'string' ? payload.dragImage : ''
    )
  })

  ipcMain.handle('sftp:upload', (event, payload) => {
    requireMainWindow(event)
    return manager.sftp.upload(
      String(payload?.sessionId || ''),
      Array.isArray(payload?.localPaths) ? payload.localPaths.map(String) : [],
      String(payload?.remoteDir || '.'),
      payload?.overwrite === true
    )
  })

  ipcMain.handle('sftp:download', (event, payload) => {
    requireMainWindow(event)
    return manager.sftp.download(
      String(payload?.sessionId || ''),
      Array.isArray(payload?.remotePaths) ? payload.remotePaths.map(String) : [],
      String(payload?.localDir || ''),
      payload?.overwrite === true
    )
  })

  ipcMain.handle('sftp:cancel', (event, transferId) => {
    requireMainWindow(event)
    return manager.sftp.cancel(String(transferId))
  })

  ipcMain.handle('sftp:open-local', (event, targetPath) => {
    requireMainWindow(event)
    if (typeof targetPath !== 'string' || !targetPath) return false
    try {
      if (!fs.existsSync(targetPath)) return false
      if (fs.statSync(targetPath).isDirectory()) shell.openPath(targetPath)
      else shell.showItemInFolder(targetPath)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('knownhosts:delete', (event, hostKey) => {
    requireMainWindow(event)
    return store.deleteKnownHost(String(hostKey))
  })

  ipcMain.handle('knownhosts:clear', (event) => {
    requireMainWindow(event)
    return store.clearKnownHosts()
  })

  ipcMain.handle('app:open-external', (event, url) => {
    requireMainWindow(event)
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    shell.openExternal(url)
    return true
  })

  ipcMain.handle('app:open-data-folder', (event) => {
    requireMainWindow(event)
    shell.openPath(dataDir)
    return true
  })

  ipcMain.on('clipboard:read-text', (event) => {
    const allowed = mainWindow && event.sender === mainWindow.webContents
    event.returnValue = allowed ? clipboard.readText() : ''
  })

  ipcMain.on('clipboard:write-text', (event, text) => {
    const allowed = mainWindow && event.sender === mainWindow.webContents
    if (allowed && typeof text === 'string') clipboard.writeText(text)
    event.returnValue = true
  })

  ipcMain.handle('clipboard:read-files', async (event) => {
    requireMainWindow(event)
    return readClipboardFilePaths()
  })

  ipcMain.handle('window:set-title', (event, title) => {
    requireMainWindow(event)
    if (!mainWindow) return
    const clean = String(title || '').replace(/[\r\n]/g, ' ').slice(0, 120)
    mainWindow.setTitle(clean ? `${APP_NAME} - ${clean}` : APP_NAME)
  })

  ipcMain.handle('window:minimize', (event) => {
    requireMainWindow(event)
    mainWindow?.minimize()
  })

  ipcMain.handle('window:toggle-maximize', (event) => {
    requireMainWindow(event)
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })

  ipcMain.handle('window:is-maximized', (event) => {
    requireMainWindow(event)
    return Boolean(mainWindow?.isMaximized())
  })

  ipcMain.handle('app:confirm-quit-response', (event, confirmed) => {
    requireMainWindow(event)
    quitPromptOpen = false
    if (confirmed !== true) return false
    allowClose = true
    manager?.closeAll()
    closeAllRemoteWindows()
    saveWindowState()
    mainWindow?.destroy()
    return true
  })

  ipcMain.handle('window:close', (event) => {
    requireMainWindow(event)
    mainWindow?.close()
  })
}

function importFromDirectory(directory) {
  const scanned = scanXshellFolder(directory)
  const merged = store.mergeImport(scanned)
  logger?.info('config import', { directory, ...scanned.summary, imported: merged.imported })
  return {
    root: scanned.root,
    summary: {
      ...scanned.summary,
      imported: merged.imported,
      skippedExisting: merged.skipped,
      passwordsImported: merged.passwordsImported,
      passphrasesImported: merged.passphrasesImported
    },
    state: merged.state
  }
}

async function bootstrap() {
  dataDir = app.getPath('userData')
  fs.mkdirSync(dataDir, { recursive: true })
  logger = new Logger(logPath())
  logger.info('starting HongSSH', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    dataDir
  })

  store = new Store(dataDir, logger)
  manager = new SshManager({
    store,
    logger,
    send: (channel, payload) => sendToRenderer(channel, payload)
  })
  dragDownload = new DragDownloadService({
    getWindow: () => mainWindow,
    sftp: manager.sftp,
    send: (channel, payload) => sendToRenderer(channel, payload),
    logger,
    dialog,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({
      width: 64,
      height: 64,
      quality: 'best'
    }),
    createDragImage: (dataUrl) => {
      const image = nativeImage.createFromDataURL(dataUrl)
      if (image.isEmpty()) return image
      const size = image.getSize()
      if (size.width <= 480) return image
      return image.resize({
        width: Math.round(size.width / 2),
        height: Math.round(size.height / 2),
        quality: 'best'
      })
    }
  })

  registerIpc()
  screenRecorder = new ScreenRecorder({
    getMainWindow: () => mainWindow,
    logger
  })
  screenshotCapture = new ScreenshotCapture({
    getMainWindow: () => mainWindow,
    logger
  })
  remoteSharedDir =
    process.env.HONGSSH_REMOTE_SHARED_DIR || path.join(app.getPath('downloads'), 'HongSSH')
  fs.mkdirSync(remoteSharedDir, { recursive: true })
  remoteHost = new RemoteHost({
    sharedDir: remoteSharedDir,
    logger,
    onStatus: (status) => {
      updateTrayMenu(status)
      sendToRenderer('remote:status', status)
    }
  })
  updater = new AppUpdater({
    programCode: 'hong-ssh',
    serverUrl: process.env.HONG_UPDATE_SERVER || 'http://127.0.0.1:9188',
    stateDir: dataDir,
    getWindow: () => mainWindow,
    log: (message) => logger.info(message),
    onBeforeInstall: async () => {
      allowClose = true
      quitting = true
      dragDownload?.cleanup()
      manager?.closeAll()
      closeAllRemoteWindows()
      stopRelayHost()
      await screenRecorder?.stop()
      await remoteHost?.stop()
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
  })
  // The frameless window uses a custom title bar; keep no native application menu.
  Menu.setApplicationMenu(null)

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  createWindow()
  createTray()
  registerGlobalShortcuts()
  void scheduleRemoteRestart()
  updater.start()

  const autoImport = process.env.HONGSSH_AUTO_IMPORT
  if (autoImport && store.data.connections.length === 0) {
    try {
      importFromDirectory(autoImport)
      logger.info('auto import complete', { autoImport })
    } catch (error) {
      logger.error('auto import failed', error)
    }
  }
}

if (primaryInstance) {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error)
    dialog.showErrorBox('HongSSH 启动失败', String(error?.stack || error))
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow()
  })

  app.on('before-quit', (event) => {
    if (allowClose || NO_CONFIRM || !mainWindow || mainWindow.isDestroyed() || !rendererReady) {
      allowClose = true
      quitting = true
      dragDownload?.cleanup()
      manager?.closeAll()
      closeAllRemoteWindows()
      stopRelayHost()
      void screenRecorder?.stop()
      void remoteHost?.stop()
      return
    }
    // Menu "退出" / app.quit() would otherwise disconnect every session before
    // the renderer has a chance to show the confirmation dialog.
    event.preventDefault()
    requestQuitConfirmation()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (allowClose || !tray)) app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (tray) {
      tray.destroy()
      tray = null
    }
  })
}
