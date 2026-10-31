'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen
} = require('electron')

const RECORD_FPS = 30
const MAX_RECORD_MS = 60 * 60 * 1000
const CONTROL_WIDTH = 308
const CONTROL_HEIGHT = 76
const OVERLAY_SHOW_SETTLE_MS = 300
const CONTROL_GAP = 10
const BORDER_SIZE = 3
const SAVE_DIALOG_ENABLED =
  process.env.HONGSSH_SAVE_DIALOG === '1' || process.env.HONGSSH_E2E !== '1'

function timestampName() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `HongSSH-录屏-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function uniqueFilePath(directory, base) {
  let candidate = path.join(directory, `${base}.webm`)
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${index}.webm`)
    index += 1
  }
  return candidate
}

function moveFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(source, target)
    return
  } catch (error) {
    if (error.code === 'EXDEV') {
      fs.copyFileSync(source, target)
      fs.unlinkSync(source)
      return
    }
    if (error.code === 'EEXIST' || error.code === 'EPERM') {
      fs.rmSync(target, { force: true })
      fs.renameSync(source, target)
      return
    }
    throw error
  }
}

function recordingDirectory() {
  if (process.env.HONGSSH_RECORDINGS_DIR) {
    fs.mkdirSync(process.env.HONGSSH_RECORDINGS_DIR, { recursive: true })
    return process.env.HONGSSH_RECORDINGS_DIR
  }

  const bases = []
  // Portable builds extract Electron into a temporary directory; the
  // electron-builder environment variable points at the real portable folder.
  if (process.env.PORTABLE_EXECUTABLE_DIR) bases.push(process.env.PORTABLE_EXECUTABLE_DIR)
  if (app.isPackaged) {
    try {
      bases.push(path.dirname(app.getPath('exe')))
    } catch {}
  }
  try {
    bases.push(app.getPath('userData'))
  } catch {}

  let lastError = null
  for (const base of bases) {
    if (!base) continue
    const directory = path.join(base, 'HongSSH 录屏')
    try {
      fs.mkdirSync(directory, { recursive: true })
      return directory
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `无法创建录屏目录：${lastError?.message || '安装目录和用户数据目录均不可写'}`
  )
}

class ScreenRecorder {
  constructor(options) {
    this.getMainWindow = options.getMainWindow
    this.logger = options.logger
    this.active = false
    this.starting = false
    this.stopping = false
    this.overlays = []
    this.overlayRevealTimer = null
    this.overlayOpacityTimer = null
    this.overlayArmedAt = 0
    this.overlaysRevealed = false
    this.border = null
    this.worker = null
    this.control = null
    this.recordingDisplay = null
    this.recordingRegion = null
    this.controlOffset = null
    this.controlDrag = null
    this.pendingSelection = null
    this.resolveWorkerReady = null
    this.rejectWorkerReady = null
    this.finishPromise = null
    this.resolveFinish = null
    this.writeStream = null
    this.output = null
    this.startedAt = 0
    this.shortcutRegistered = false
    this.registerIpc()
  }

  registerIpc() {
    ipcMain.handle('screen:start-recording', (event) => {
      this.assertMain(event)
      return this.start()
    })
    ipcMain.handle('screen:stop-recording', (event) => {
      this.assertMain(event)
      return this.stop()
    })
    ipcMain.on('screen:selection', (event, rect) => {
      const entry = this.overlayEntry(event.sender)
      if (!entry) return
      this.acceptSelection(entry, rect)
    })
    ipcMain.on('screen:selection-cancel', (event) => {
      if (!this.overlayEntry(event.sender)) return
      this.cancelSelection()
    })
    ipcMain.on('screen:worker-ready', (event) => {
      if (!this.worker || event.sender.id !== this.worker.webContents.id) return
      this.onWorkerReady()
    })
    ipcMain.on('screen:worker-chunk', (event, data) => {
      if (!this.worker || event.sender.id !== this.worker.webContents.id) return
      if (!this.active || this.stopping || !this.writeStream) return
      try {
        this.writeStream.write(Buffer.from(data))
      } catch (error) {
        this.logger?.warn('screen recording chunk failed', error)
      }
    })
    ipcMain.on('screen:worker-finished', (event) => {
      if (!this.worker || event.sender.id !== this.worker.webContents.id) return
      void this.finalize()
    })
    ipcMain.on('screen:worker-error', (event, message) => {
      if (!this.worker || event.sender.id !== this.worker.webContents.id) return
      this.abort(String(message || '录制进程启动失败'))
    })
    ipcMain.on('screen:control-stop', (event) => {
      if (!this.control || event.sender.id !== this.control.webContents.id) return
      void this.stop()
    })
    ipcMain.on('screen:control-drag-start', (event) => {
      if (!this.control || event.sender.id !== this.control.webContents.id) return
      if (!this.active || this.stopping || !this.recordingRegion) return
      this.controlDrag = { region: { ...this.recordingRegion } }
    })
    ipcMain.on('screen:control-drag-move', (event, payload) => {
      if (!this.control || event.sender.id !== this.control.webContents.id) return
      if (!this.active || this.stopping || !this.controlDrag) return
      this.moveRecordingRegion(Number(payload?.dx) || 0, Number(payload?.dy) || 0)
    })
    ipcMain.on('screen:control-drag-end', (event) => {
      if (!this.control || event.sender.id !== this.control.webContents.id) return
      this.controlDrag = null
    })
  }

  assertMain(event) {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) {
      throw new Error('无效的录屏请求')
    }
  }

  async start() {
    if (this.active || this.starting) throw new Error('当前已经在录屏')
    this.starting = true
    try {
      const selection = await this.selectRegion()
      if (!selection) return { started: false, cancelled: true }
      await this.begin(selection)
      return { started: true }
    } catch (error) {
      this.abort(error.message || String(error))
      throw error
    } finally {
      this.starting = false
    }
  }

  overlayEntry(sender) {
    return (
      this.overlays.find((entry) => {
        if (!entry.window || entry.window.isDestroyed()) return false
        return entry.window.webContents.id === sender.id
      }) || null
    )
  }

  async selectRegion() {
    const displays = screen.getAllDisplays()
    const cursorDisplay =
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()
    let maxWidth = 1
    let maxHeight = 1
    for (const display of displays) {
      const scale = Number(display.scaleFactor) || 1
      maxWidth = Math.max(maxWidth, Math.round(display.bounds.width * scale))
      maxHeight = Math.max(maxHeight, Math.round(display.bounds.height * scale))
    }

    let sources
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        // One request for every display; Electron scales each thumbnail to fit.
        thumbnailSize: {
          width: Math.min(4096, maxWidth),
          height: Math.min(4096, maxHeight)
        },
        fetchWindowIcons: false
      })
    } catch (error) {
      throw new Error(`无法读取屏幕内容：${error.message || error}`)
    }
    if (!sources.length) throw new Error('没有可录制的屏幕')

    const entries = []
    for (const [index, display] of displays.entries()) {
      const source =
        sources.find((item) => String(item.display_id) === String(display.id)) ||
        (sources.every((item) => !item.display_id) ? sources[index] : null)
      if (!source || source.thumbnail.isEmpty()) continue
      const image = source.thumbnail.toDataURL()
      if (!image) continue
      entries.push({
        display,
        source,
        image,
        scaleFactor: Number(display.scaleFactor) || 1,
        isCursor: String(display.id) === String(cursorDisplay.id)
      })
    }
    if (!entries.length) throw new Error('没有可录制的屏幕')

    const selection = new Promise((resolve) => {
      this.pendingSelection = { resolve }
    })
    this.overlaysRevealed = false
    this.overlayArmedAt = Date.now()
    for (const entry of entries) this.createOverlay(entry)
    clearTimeout(this.overlayRevealTimer)
    this.overlayRevealTimer = setTimeout(() => this.revealOverlays(), 1600)
    this.revealOverlaysIfReady()
    return selection
  }

  createOverlay(entry) {
    const { display } = entry
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'screen-recorder-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    })
    entry.window = overlay
    entry.ready = false
    this.overlays.push(entry)
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Windows clamps a freshly created window to the primary work area, so set
    // the real display bounds explicitly. Show it transparent and click-through
    // now so its initial show animation finishes before the selector is visible.
    overlay.setBounds(display.bounds)
    try {
      overlay.setOpacity(0)
    } catch {}
    overlay.setIgnoreMouseEvents(true, { forward: true })
    overlay.showInactive()

    overlay.on('closed', () => {
      this.overlays = this.overlays.filter((item) => item !== entry)
      if (this.pendingSelection) this.cancelSelection()
    })

    overlay.webContents.on('ipc-message', (_event, channel) => {
      if (channel !== 'screen:overlay-ready') return
      entry.ready = true
      this.revealOverlaysIfReady()
    })

    overlay.webContents.on('did-finish-load', () => {
      if (overlay.isDestroyed()) return
      overlay.webContents.send('screen:overlay-init', {
        image: entry.image,
        display: {
          width: display.bounds.width,
          height: display.bounds.height,
          scaleFactor: entry.scaleFactor
        },
        sourceId: entry.source.id,
        displayId: String(display.id),
        displayLabel: display.label || ''
      })
      overlay.setBounds(display.bounds)
    })

    overlay.loadFile(path.join(__dirname, 'region-select.html')).catch((error) => {
      this.logger?.warn('could not load region selector', error)
      this.abort(`无法打开区域选择界面：${error.message || error}`)
    })
  }

  revealOverlaysIfReady() {
    if (!this.overlays.length) return
    if (this.overlays.every((entry) => entry.ready)) this.revealOverlays()
  }

  revealOverlays() {
    if (this.overlaysRevealed || !this.pendingSelection) return
    if (!this.overlays.length) return
    this.overlaysRevealed = true
    clearTimeout(this.overlayRevealTimer)
    this.overlayRevealTimer = null
    const focused = this.overlays.find((entry) => entry.isCursor) || this.overlays[0]
    const shown = []
    for (const entry of this.overlays) {
      const win = entry.window
      if (!win || win.isDestroyed()) continue
      win.setBounds(entry.display.bounds)
      shown.push(win)
    }
    // The selectors were shown transparent when created. Let Windows finish
    // its initial show animation before making the whole mask visible in one
    // batch; this avoids both the zoom-in and per-monitor reveal sequence.
    const elapsed = Date.now() - (this.overlayArmedAt || 0)
    const wait = Math.max(0, OVERLAY_SHOW_SETTLE_MS - elapsed)
    clearTimeout(this.overlayOpacityTimer)
    this.overlayOpacityTimer = setTimeout(() => {
      this.overlayOpacityTimer = null
      for (const win of shown) {
        if (win.isDestroyed()) continue
        win.setIgnoreMouseEvents(false)
        try {
          win.setOpacity(1)
        } catch {}
      }
      if (focused?.window && !focused.window.isDestroyed()) {
        focused.window.focus()
      }
    }, wait)
  }

  acceptSelection(entry, rect) {
    const pending = this.pendingSelection
    if (!pending) return
    const bounds = entry.display.bounds
    const width = Number(rect?.width)
    const height = Number(rect?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) {
      return
    }
    const x = clamp(Number(rect?.x) || 0, 0, bounds.width - 1)
    const y = clamp(Number(rect?.y) || 0, 0, bounds.height - 1)
    const region = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(Math.min(width, bounds.width - x)),
      height: Math.round(Math.min(height, bounds.height - y))
    }
    if (region.width < 16 || region.height < 16) return
    this.pendingSelection = null
    pending.resolve({
      sourceId: entry.source.id,
      display: entry.display,
      scaleFactor: entry.scaleFactor,
      region
    })
  }

  cancelSelection() {
    if (!this.pendingSelection) return
    const pending = this.pendingSelection
    this.pendingSelection = null
    this.closeOverlays()
    pending.resolve(null)
  }

  closeOverlays() {
    clearTimeout(this.overlayRevealTimer)
    this.overlayRevealTimer = null
    clearTimeout(this.overlayOpacityTimer)
    this.overlayOpacityTimer = null
    this.overlaysRevealed = false
    const overlays = this.overlays
    this.overlays = []
    for (const entry of overlays) {
      try {
        if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
      } catch {}
    }
  }

  async begin(selection) {
    const directory = recordingDirectory()
    const finalPath = uniqueFilePath(directory, timestampName())
    const partPath = `${finalPath}.part`
    const stream = fs.createWriteStream(partPath)
    this.writeStream = stream
    this.output = { directory, finalPath, partPath }
    this.startedAt = Date.now()
    this.active = true
    this.stopping = false
    this.recordingDisplay = selection.display
    this.recordingRegion = { ...selection.region }
    this.controlDrag = null
    this.finishPromise = new Promise((resolve) => {
      this.resolveFinish = resolve
    })

    // Show the recording frame above the selection overlay first. Only then
    // remove the old selector, so the red frame never disappears between modes.
    await this.createBorder(selection)
    if (!this.active) throw new Error('录制已停止')
    // Give the composition a couple of frames to present the new frame before
    // removing the selector, otherwise Windows can show a one-frame gap.
    await new Promise((resolve) => setTimeout(resolve, 80))
    this.closeOverlays()

    const worker = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      webPreferences: {
        preload: path.join(__dirname, 'screen-recorder-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
        partition: 'screen-recorder'
      }
    })
    this.worker = worker
    worker.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media' || permission === 'display-capture')
    })
    worker.on('closed', () => {
      if (this.worker === worker) this.worker = null
      if (this.active && !this.stopping) this.abort('录制进程意外关闭')
    })
    worker.webContents.on('did-finish-load', () => {
      if (worker.isDestroyed()) return
      worker.webContents.send('screen:worker-start', {
        sourceId: selection.sourceId,
        region: selection.region,
        display: {
          width: selection.display.bounds.width,
          height: selection.display.bounds.height,
          scaleFactor: selection.scaleFactor
        },
        fps: RECORD_FPS,
        bitrate: 8_000_000
      })
    })
    worker.loadFile(path.join(__dirname, 'record-worker.html')).catch((error) => {
      this.abort(`无法加载录制组件：${error.message || error}`)
    })

    await new Promise((resolve, reject) => {
      this.resolveWorkerReady = resolve
      this.rejectWorkerReady = reject
      setTimeout(() => {
        if (this.active && !this.stopping && !this.control) {
          reject(new Error('录制组件启动超时'))
        }
      }, 20000)
    })

    if (!this.active) throw new Error('录制已停止')
    await this.createControl(selection)
    this.registerShortcut()
    this.sendStatus({
      recording: true,
      startedAt: this.startedAt
    })
    this.logger?.info('screen recording started', {
      region: selection.region,
      path: finalPath
    })
    setTimeout(() => {
      if (this.active) void this.stop('达到单次录屏时长上限')
    }, MAX_RECORD_MS).unref?.()
  }

  onWorkerReady() {
    if (!this.active) return
    const resolve = this.resolveWorkerReady
    this.resolveWorkerReady = null
    this.rejectWorkerReady = null
    resolve?.()
  }

  createControl(selection) {
    const width = CONTROL_WIDTH
    const height = CONTROL_HEIGHT
    const position = this.placeControl(selection, width, height)
    const regionX = selection.display.bounds.x + selection.region.x
    const regionY = selection.display.bounds.y + selection.region.y
    this.controlOffset = { x: position.x - regionX, y: position.y - regionY }
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const control = new BrowserWindow({
        x: position.x,
        y: position.y,
        width,
        height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: path.join(__dirname, 'screen-recorder-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false
        }
      })
      this.control = control
      control.setAlwaysOnTop(true, 'screen-saver')
      control.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      control.setBounds(position)
      try {
        control.setOpacity(0)
      } catch {}
      control.setIgnoreMouseEvents(true, { forward: true })
      control.showInactive()
      const controlShownAt = Date.now()
      control.on('closed', () => {
        if (this.control === control) this.control = null
        done()
      })
      control.webContents.on('did-finish-load', () => {
        if (control.isDestroyed()) {
          done()
          return
        }
        control.setBounds(position)
        control.webContents.send('screen:control-init', { startedAt: this.startedAt })
        const wait = Math.max(0, OVERLAY_SHOW_SETTLE_MS - (Date.now() - controlShownAt))
        setTimeout(() => {
          if (!control.isDestroyed()) {
            control.setIgnoreMouseEvents(false)
            try {
              control.setOpacity(1)
            } catch {}
          }
          done()
        }, wait)
      })
      control.loadFile(path.join(__dirname, 'record-control.html')).catch((error) => {
        this.logger?.warn('could not load recording control', error)
        done()
      })
      setTimeout(done, 2000)
    })
  }

  createBorder(selection) {
    const target = this.regionBounds(selection)
    const bounds = {
      x: target.x - BORDER_SIZE,
      y: target.y - BORDER_SIZE,
      width: target.width + BORDER_SIZE * 2,
      height: target.height + BORDER_SIZE * 2
    }
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const border = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        hasShadow: false,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: path.join(__dirname, 'screen-recorder-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false
        }
      })
      this.border = border
      border.setAlwaysOnTop(true, 'screen-saver')
      border.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      border.setIgnoreMouseEvents(true, { forward: true })
      border.setBounds(bounds)
      try {
        border.setOpacity(0)
      } catch {}
      border.showInactive()
      border.moveTop()
      const borderShownAt = Date.now()
      border.on('closed', () => {
        if (this.border === border) this.border = null
        done()
      })
      border.webContents.on('did-finish-load', () => {
        if (border.isDestroyed()) {
          done()
          return
        }
        border.setBounds(bounds)
        const wait = Math.max(0, OVERLAY_SHOW_SETTLE_MS - (Date.now() - borderShownAt))
        setTimeout(() => {
          if (!border.isDestroyed()) {
            try {
              border.setOpacity(1)
            } catch {}
          }
          done()
        }, wait)
      })
      border.loadFile(path.join(__dirname, 'record-border.html')).catch((error) => {
        this.logger?.warn('could not load recording border', error)
        done()
      })
      setTimeout(done, 2000)
    })
  }

  regionBounds(selection) {
    return {
      x: selection.display.bounds.x + selection.region.x,
      y: selection.display.bounds.y + selection.region.y,
      width: selection.region.width,
      height: selection.region.height
    }
  }

  placeControl(selection, width, height) {
    const area = selection.display.workArea
    const target = this.regionBounds(selection)
    // Right edges align, just below the recorded frame; fall back above it.
    let x = target.x + target.width - width
    let y = target.y + target.height + CONTROL_GAP
    if (y + height > area.y + area.height) y = target.y - CONTROL_GAP - height
    x = Math.max(area.x, Math.min(area.x + area.width - width, x))
    y = Math.max(area.y, Math.min(area.y + area.height - height, y))
    return { x: Math.round(x), y: Math.round(y), width, height }
  }

  moveRecordingRegion(dx, dy) {
    const origin = this.controlDrag?.region
    const display = this.recordingDisplay
    const region = this.recordingRegion
    if (!origin || !display || !region) return
    const x = Math.round(clamp(origin.x + dx, 0, display.bounds.width - region.width))
    const y = Math.round(clamp(origin.y + dy, 0, display.bounds.height - region.height))
    if (x === region.x && y === region.y) return
    region.x = x
    region.y = y
    this.applyRecordingRegion()
  }

  applyRecordingRegion() {
    const display = this.recordingDisplay
    const region = this.recordingRegion
    if (!display || !region) return
    if (this.border && !this.border.isDestroyed()) {
      this.border.setBounds({
        x: display.bounds.x + region.x - BORDER_SIZE,
        y: display.bounds.y + region.y - BORDER_SIZE,
        width: region.width + BORDER_SIZE * 2,
        height: region.height + BORDER_SIZE * 2
      })
    }
    if (this.worker && !this.worker.isDestroyed()) {
      this.worker.webContents.send('screen:worker-region', { x: region.x, y: region.y })
    }
    if (this.control && !this.control.isDestroyed() && this.controlOffset) {
      const area = display.workArea
      const x = clamp(
        display.bounds.x + region.x + this.controlOffset.x,
        area.x,
        area.x + area.width - CONTROL_WIDTH
      )
      const y = clamp(
        display.bounds.y + region.y + this.controlOffset.y,
        area.y,
        area.y + area.height - CONTROL_HEIGHT
      )
      this.control.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: CONTROL_WIDTH,
        height: CONTROL_HEIGHT
      })
    }
  }

  registerShortcut() {
    if (this.shortcutRegistered) return
    try {
      this.shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+F10', () => {
        void this.stop()
      })
    } catch (error) {
      this.logger?.warn('could not register recording stop shortcut', error)
    }
  }

  async chooseSavePath(defaultPath) {
    if (!SAVE_DIALOG_ENABLED) return defaultPath
    const win = this.getMainWindow()
    const options = {
      title: '保存录屏',
      defaultPath,
      filters: [{ name: 'WebM 视频', extensions: ['webm'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    try {
      const result =
        win && !win.isDestroyed() && win.isVisible()
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return defaultPath
      return result.filePath.toLowerCase().endsWith('.webm')
        ? result.filePath
        : `${result.filePath}.webm`
    } catch (error) {
      this.logger?.warn('could not show recording save dialog', error)
      return defaultPath
    }
  }

  async stop(reason) {
    if (!this.active || this.stopping) return { path: this.output?.finalPath }
    if (!this.worker || this.worker.isDestroyed()) {
      this.abort(reason || '录制组件已关闭')
      return { path: null }
    }
    this.stopping = true
    try {
      this.worker.webContents.send('screen:worker-stop')
    } catch (error) {
      this.abort(error.message || '停止录制失败')
      return { path: null }
    }
    await Promise.race([
      this.finishPromise,
      new Promise((resolve) => setTimeout(resolve, 5000))
    ])
    if (this.active) this.abort('停止录制超时')
    return { path: this.output?.finalPath }
  }

  async finalize() {
    if (!this.active) return
    this.active = false
    this.stopping = false
    this.controlDrag = null
    this.unregisterShortcut()
    this.closeWorker()
    this.closeBorder()
    this.closeControl()
    const output = this.output
    const stream = this.writeStream
    this.writeStream = null
    if (!output || !stream) {
      this.finish()
      return
    }
    try {
      await new Promise((resolve) => stream.end(resolve))
      const stat = fs.statSync(output.partPath)
      if (stat.size < 128) throw new Error('没有录到有效画面')
      let chosenPath = await this.chooseSavePath(output.finalPath)
      try {
        moveFile(output.partPath, chosenPath)
      } catch (error) {
        if (path.resolve(chosenPath) !== path.resolve(output.finalPath)) {
          this.logger?.warn('could not save recording to chosen path, using default', error)
          chosenPath = output.finalPath
          moveFile(output.partPath, chosenPath)
        } else {
          throw error
        }
      }
      output.finalPath = chosenPath
      this.sendStatus({ recording: false, path: output.finalPath })
      this.logger?.info('screen recording saved', { path: output.finalPath, bytes: stat.size })
    } catch (error) {
      this.removePart()
      this.sendStatus({ recording: false, error: `保存录屏失败：${error.message || error}` })
      this.logger?.warn('screen recording save failed', error)
    } finally {
      this.output = null
      this.finish()
    }
  }

  abort(message) {
    if (!this.active && !this.starting && this.overlays.length === 0 && !this.border) {
      if (this.rejectWorkerReady) {
        const reject = this.rejectWorkerReady
        this.resolveWorkerReady = null
        this.rejectWorkerReady = null
        reject(new Error(message || '录制已取消'))
      }
      return
    }
    const wasActive = this.active
    this.active = false
    this.stopping = false
    this.controlDrag = null
    this.unregisterShortcut()
    const pending = this.pendingSelection
    this.pendingSelection = null
    this.closeOverlays()
    this.closeWorker()
    this.closeBorder()
    this.closeControl()
    pending?.resolve(null)
    if (this.rejectWorkerReady) {
      const reject = this.rejectWorkerReady
      this.resolveWorkerReady = null
      this.rejectWorkerReady = null
      reject(new Error(message || '录制已取消'))
    }
    if (this.writeStream) {
      try {
        this.writeStream.destroy()
      } catch {}
      this.writeStream = null
    }
    this.removePart()
    this.output = null
    if (wasActive || message) this.sendStatus({ recording: false, error: message || '录制已取消' })
    this.finish()
  }

  removePart() {
    if (!this.output?.partPath) return
    try {
      fs.unlinkSync(this.output.partPath)
    } catch {}
  }

  closeWorker() {
    if (!this.worker) return
    const worker = this.worker
    this.worker = null
    try {
      worker.destroy()
    } catch {}
  }

  closeBorder() {
    if (!this.border) return
    const border = this.border
    this.border = null
    try {
      border.destroy()
    } catch {}
  }

  closeControl() {
    if (!this.control) return
    const control = this.control
    this.control = null
    try {
      control.destroy()
    } catch {}
  }

  unregisterShortcut() {
    if (!this.shortcutRegistered) return
    this.shortcutRegistered = false
    try {
      globalShortcut.unregister('CommandOrControl+Shift+F10')
    } catch {}
  }

  finish() {
    const resolve = this.resolveFinish
    this.resolveFinish = null
    this.finishPromise = null
    resolve?.()
  }

  sendStatus(status) {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('screen:recording-status', status)
  }
}

module.exports = { ScreenRecorder }
