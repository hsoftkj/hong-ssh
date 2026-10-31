'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  screen
} = require('electron')

// Windows can animate a newly shown window (zoom/slide). Keep the window
// transparent for long enough to finish that animation before revealing it.
const OVERLAY_SHOW_SETTLE_MS = 300

const SAVE_DIALOG_ENABLED =
  process.env.HONGSSH_SAVE_DIALOG === '1' || process.env.HONGSSH_E2E !== '1'

function timestampName() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `HongSSH-截图-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function uniqueFilePath(directory, base, extension) {
  let candidate = path.join(directory, `${base}.${extension}`)
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${index}.${extension}`)
    index += 1
  }
  return candidate
}

function screenshotDirectory() {
  if (process.env.HONGSSH_SCREENSHOTS_DIR) {
    fs.mkdirSync(process.env.HONGSSH_SCREENSHOTS_DIR, { recursive: true })
    return process.env.HONGSSH_SCREENSHOTS_DIR
  }

  const bases = []
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
    const directory = path.join(base, 'HongSSH 截图')
    try {
      fs.mkdirSync(directory, { recursive: true })
      return directory
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`无法创建截图目录：${lastError?.message || '安装目录和用户数据目录均不可写'}`)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

class ScreenshotCapture {
  constructor(options) {
    this.getMainWindow = options.getMainWindow
    this.logger = options.logger
    this.starting = false
    this.overlays = []
    this.pending = null
    this.overlayRevealTimer = null
    this.overlayOpacityTimer = null
    this.overlayArmedAt = 0
    this.overlaysRevealed = false
    this.warmOverlays = new Map()
    this.warmRefreshTimer = null
    this.warmWatching = false
    this.warmEnabled = false
    this.registerIpc()
  }

  registerIpc() {
    ipcMain.handle('screenshot:start', (event) => {
      this.assertMain(event)
      return this.start()
    })
    ipcMain.on('screenshot:finish', (event, payload) => {
      void this.finishSelection(event, payload)
    })
    ipcMain.on('screenshot:cancel', (event) => {
      if (!this.overlayFor(event.sender)) return
      this.cancel()
    })
    ipcMain.on('screenshot:pin-close', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.close()
    })
  }

  assertMain(event) {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) {
      throw new Error('无效的截图请求')
    }
  }

  warmup() {
    this.warmEnabled = true
    this.bindWarmDisplayWatch()
    this.refreshWarmOverlays()
  }

  bindWarmDisplayWatch() {
    if (this.warmWatching) return
    this.warmWatching = true
    const schedule = () => {
      clearTimeout(this.warmRefreshTimer)
      this.warmRefreshTimer = setTimeout(() => this.refreshWarmOverlays(), 250)
    }
    screen.on('display-added', schedule)
    screen.on('display-removed', schedule)
    screen.on('display-metrics-changed', schedule)
  }

  displaySignature(display) {
    const bounds = display.bounds || {}
    return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${display.scaleFactor || 1}`
  }

  destroyWarmOverlay(entry) {
    const id = String(entry.display.id)
    if (this.warmOverlays.get(id) === entry) this.warmOverlays.delete(id)
    try {
      if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
    } catch {}
  }

  refreshWarmOverlays() {
    if (!this.warmEnabled || this.pending || this.overlays.length) return
    const displays = screen.getAllDisplays()
    const ids = new Set()
    for (const display of displays) {
      const id = String(display.id)
      ids.add(id)
      const signature = this.displaySignature(display)
      const existing = this.warmOverlays.get(id)
      if (existing && existing.signature === signature && !existing.window.isDestroyed()) continue
      if (existing) this.destroyWarmOverlay(existing)
      this.createWarmOverlay(display)
    }
    for (const [id, entry] of [...this.warmOverlays]) {
      if (!ids.has(id)) this.destroyWarmOverlay(entry)
    }
  }

  createWarmOverlay(display) {
    const id = String(display.id)
    let resolveLoaded
    const loaded = new Promise((resolve) => {
      resolveLoaded = resolve
    })
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
        preload: path.join(__dirname, 'screenshot-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    const entry = {
      display,
      signature: this.displaySignature(display),
      window: overlay,
      ready: false,
      active: false,
      isCursor: false,
      image: '',
      scaleFactor: Number(display.scaleFactor) || 1,
      loaded
    }
    this.warmOverlays.set(id, entry)
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.setBounds(display.bounds)

    let loadSettled = false
    const finishLoad = () => {
      if (loadSettled) return
      loadSettled = true
      resolveLoaded()
    }
    overlay.on('closed', () => {
      if (this.warmOverlays.get(id) === entry) this.warmOverlays.delete(id)
      finishLoad()
      if (entry.active && this.pending) this.cancel()
    })
    overlay.webContents.on('ipc-message', (_event, channel) => {
      if (channel !== 'screenshot:overlay-ready') return
      if (!entry.active || this.warmOverlays.get(id) !== entry) return
      entry.ready = true
      this.revealOverlaysIfReady()
    })
    overlay.webContents.on('did-finish-load', () => {
      overlay.setBounds(display.bounds)
      finishLoad()
    })
    overlay.loadFile(path.join(__dirname, 'screenshot-overlay.html')).catch((error) => {
      this.logger?.warn('could not preload screenshot overlay', error)
      finishLoad()
    })
    setTimeout(finishLoad, 4000)
    return entry
  }

  destroyWarmOverlays() {
    if (this.pending) this.cancel()
    this.warmEnabled = false
    clearTimeout(this.warmRefreshTimer)
    this.warmRefreshTimer = null
    const entries = [...this.warmOverlays.values()]
    this.warmOverlays.clear()
    for (const entry of entries) {
      entry.active = false
      entry.ready = false
      try {
        if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
      } catch {}
    }
  }

  async ensureWarmOverlays(displays) {
    this.warmEnabled = true
    const required = []
    const ids = new Set(displays.map((display) => String(display.id)))
    for (const [id, entry] of [...this.warmOverlays]) {
      if (!ids.has(id)) this.destroyWarmOverlay(entry)
    }
    for (const display of displays) {
      const id = String(display.id)
      const signature = this.displaySignature(display)
      let entry = this.warmOverlays.get(id)
      if (entry && (entry.signature !== signature || entry.window.isDestroyed())) {
        this.destroyWarmOverlay(entry)
        entry = null
      }
      if (!entry) entry = this.createWarmOverlay(display)
      entry.display = display
      entry.signature = signature
      required.push(entry)
    }
    await Promise.all(required.map((entry) => entry.loaded))
    return required
  }

  normalizeRegion(rect, bounds) {
    const width = Number(rect?.width)
    const height = Number(rect?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
    const x = clamp(Number(rect?.x) || 0, 0, bounds.width - 1)
    const y = clamp(Number(rect?.y) || 0, 0, bounds.height - 1)
    const region = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(Math.min(width, bounds.width - x)),
      height: Math.round(Math.min(height, bounds.height - y))
    }
    if (region.width < 1 || region.height < 1) return null
    return region
  }

  overlayFor(sender) {
    return (
      this.overlays.find((entry) => {
        if (!entry.window || entry.window.isDestroyed()) return false
        return entry.window.webContents.id === sender.id
      }) || null
    )
  }

  async finishSelection(event, payload) {
    const entry = this.overlayFor(event.sender)
    if (!entry || !this.pending) return
    const action = payload?.action
    if (!['copy', 'save', 'pin'].includes(action)) return
    let buffer
    try {
      buffer = Buffer.from(payload?.png || [])
    } catch {
      return
    }
    if (!buffer.length) return
    const rect = this.normalizeRegion(payload?.rect, entry.display.bounds)
    if (!rect) return

    let filePath = ''
    if (action === 'save' && SAVE_DIALOG_ENABLED) {
      try {
        const defaultPath = uniqueFilePath(screenshotDirectory(), timestampName(), 'png')
        this.hideOverlays()
        filePath = await this.chooseSavePath(defaultPath)
        if (!filePath) {
          this.restoreOverlays(entry)
          if (!entry.window.isDestroyed()) {
            entry.window.webContents.send('screenshot:save-cancelled')
          }
          return
        }
      } catch (error) {
        this.logger?.warn('could not show screenshot save dialog', error)
        this.restoreOverlays(entry)
        if (!entry.window.isDestroyed()) {
          entry.window.webContents.send('screenshot:save-cancelled')
        }
        return
      }
    }

    this.settle(
      { action, png: buffer, rect, display: entry.display, filePath },
      { keepOverlays: action === 'pin' }
    )
  }

  async chooseSavePath(defaultPath) {
    const win = this.getMainWindow()
    const options = {
      title: '保存截图',
      defaultPath,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const result =
      win && !win.isDestroyed() && win.isVisible()
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return ''
    return result.filePath.toLowerCase().endsWith('.png')
      ? result.filePath
      : `${result.filePath}.png`
  }

  hideOverlays() {
    for (const entry of this.overlays) {
      if (entry.window && !entry.window.isDestroyed()) entry.window.hide()
    }
  }

  restoreOverlays(focused) {
    this.showOverlaysAtomically(this.overlays, focused)
  }

  showOverlaysAtomically(overlays, focused) {
    const shown = []
    let hadHidden = false
    for (const entry of overlays) {
      const win = entry.window
      if (!win || win.isDestroyed()) continue
      win.setBounds(entry.display.bounds)
      if (!win.isVisible()) {
        hadHidden = true
        try {
          win.setOpacity(0)
        } catch {}
        win.setIgnoreMouseEvents(true, { forward: true })
        win.showInactive()
      }
      shown.push(win)
    }
    // The overlays are normally shown transparent before the capture. Wait
    // for Windows' show animation to finish before revealing the mask; if a
    // window had to be shown here, give it the full grace period.
    const elapsed = Date.now() - (this.overlayArmedAt || 0)
    const wait = hadHidden
      ? OVERLAY_SHOW_SETTLE_MS
      : Math.max(0, OVERLAY_SHOW_SETTLE_MS - elapsed)
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

  async start() {
    if (this.starting || this.pending) throw new Error('截图已在进行中')
    this.starting = true
    try {
      const capture = await this.selectRegion()
      if (!capture) return { cancelled: true }
      return await this.handleCapture(capture)
    } finally {
      this.starting = false
      this.closeOverlays()
    }
  }

  async selectRegion() {
    const displays = screen.getAllDisplays()
    const cursorDisplay =
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()
    const entries = []
    const warmEntries = await this.ensureWarmOverlays(displays)

    // Show the warm windows fully transparent and click-through before the
    // capture starts. Windows' initial show animation then finishes while
    // nothing is visible, so revealing the mask never scales in.
    this.overlays = []
    for (const entry of warmEntries) {
      const win = entry.window
      if (!win || win.isDestroyed()) continue
      entry.active = true
      entry.ready = false
      win.setBounds(entry.display.bounds)
      try {
        win.setOpacity(0)
      } catch {}
      win.setIgnoreMouseEvents(true, { forward: true })
      win.showInactive()
      this.overlays.push(entry)
    }
    this.overlayArmedAt = Date.now()

    // Capture each display at its own native resolution so the saved/copied
    // screenshot is pixel-exact even on mixed-DPI multi-monitor setups.
    const capturedList = await Promise.all(
      displays.map(async (display) => {
        const scale = Number(display.scaleFactor) || 1
        const thumbnailSize = {
          width: Math.max(1, Math.round(display.bounds.width * scale)),
          height: Math.max(1, Math.round(display.bounds.height * scale))
        }
        let sources
        try {
          sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize,
            fetchWindowIcons: false
          })
        } catch (error) {
          this.logger?.warn('could not capture display for screenshot', error)
          return null
        }
        const source =
          sources.find((item) => String(item.display_id) === String(display.id)) ||
          (sources.every((item) => !item.display_id) ? sources[0] : null)
        if (!source || source.thumbnail.isEmpty()) return null
        const image = source.thumbnail.toDataURL()
        if (!image) return null
        return {
          display,
          source,
          image,
          scaleFactor: scale,
          isCursor: String(display.id) === String(cursorDisplay.id)
        }
      })
    )
    for (const captured of capturedList) {
      if (captured) entries.push(captured)
    }
    if (!entries.length) throw new Error('没有可截图的屏幕')

    const capturedIds = new Set(entries.map((entry) => String(entry.display.id)))
    for (const entry of [...this.overlays]) {
      if (capturedIds.has(String(entry.display.id))) continue
      entry.active = false
      entry.ready = false
      try {
        if (entry.window && !entry.window.isDestroyed()) entry.window.hide()
      } catch {}
    }
    this.overlays = this.overlays.filter((entry) =>
      capturedIds.has(String(entry.display.id))
    )

    const selection = new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
    this.overlaysRevealed = false
    for (const captured of entries) {
      const warm = this.warmOverlays.get(String(captured.display.id))
      if (!warm || warm.window.isDestroyed()) continue
      warm.active = true
      warm.ready = false
      warm.isCursor = captured.isCursor
      warm.image = captured.image
      warm.scaleFactor = captured.scaleFactor
      warm.window.setBounds(captured.display.bounds)
      warm.window.webContents.send('screenshot:init', {
        image: captured.image,
        display: {
          width: captured.display.bounds.width,
          height: captured.display.bounds.height,
          scaleFactor: captured.scaleFactor
        },
        displayId: String(captured.display.id)
      })
    }
    if (!this.overlays.length) {
      this.pending = null
      throw new Error('截图界面准备失败')
    }
    clearTimeout(this.overlayRevealTimer)
    this.overlayRevealTimer = setTimeout(() => this.revealOverlays(), 1600)
    this.revealOverlaysIfReady()
    return selection
  }

  revealOverlaysIfReady() {
    if (!this.overlays.length) return
    if (this.overlays.every((entry) => entry.ready)) this.revealOverlays()
  }

  revealOverlays() {
    if (this.overlaysRevealed || !this.pending) return
    if (!this.overlays.length) return
    this.overlaysRevealed = true
    clearTimeout(this.overlayRevealTimer)
    this.overlayRevealTimer = null
    const focused = this.overlays.find((entry) => entry.isCursor) || this.overlays[0]
    this.showOverlaysAtomically(this.overlays, focused)
  }

  settle(result, options = {}) {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    if (!options.keepOverlays) this.closeOverlays()
    pending.resolve(result)
  }

  cancel() {
    this.settle(null)
  }

  abort(message) {
    this.logger?.warn('screenshot aborted', message)
    const pending = this.pending
    if (!pending) return
    this.pending = null
    this.closeOverlays()
    pending.reject(new Error(message || '截图失败'))
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
      entry.active = false
      entry.ready = false
      entry.isCursor = false
      try {
        if (entry.window && !entry.window.isDestroyed()) entry.window.hide()
      } catch {}
    }
  }

  async handleCapture(capture) {
    const buffer = Buffer.isBuffer(capture.png) ? capture.png : Buffer.from(capture.png)
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) throw new Error('截图数据无效')
    clipboard.writeImage(image)

    if (capture.action === 'save') {
      const file =
        capture.filePath || uniqueFilePath(screenshotDirectory(), timestampName(), 'png')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buffer)
      return { action: 'save', path: file, copied: true }
    }

    if (capture.action === 'pin') {
      await this.createPin(image, capture.rect, capture.display)
      return { action: 'pin', copied: false }
    }

    return { action: 'copy', copied: true }
  }

  createPin(image, rect, display) {
    const bounds = {
      x: display.bounds.x + rect.x,
      y: display.bounds.y + rect.y,
      width: Math.max(120, rect.width),
      height: Math.max(80, rect.height)
    }
    return new Promise((resolve) => {
      let finished = false
      let timer = null
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve()
      }
      const pin = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: false,
        backgroundColor: '#111318',
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        show: false,
        minWidth: 80,
        minHeight: 60,
        webPreferences: {
          preload: path.join(__dirname, 'screenshot-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false
        }
      })
      const show = () => {
        if (pin.isDestroyed()) {
          finish()
          return
        }
        pin.setBounds(bounds)
        try {
          pin.setOpacity(0)
        } catch {}
        pin.setIgnoreMouseEvents(true, { forward: true })
        pin.showInactive()
        pin.moveTop()
        setTimeout(() => {
          if (!pin.isDestroyed()) {
            pin.setIgnoreMouseEvents(false)
            try {
              pin.setOpacity(1)
            } catch {}
          }
        }, OVERLAY_SHOW_SETTLE_MS)
        finish()
      }
      pin.setAlwaysOnTop(true, 'screen-saver')
      pin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      pin.setAspectRatio(bounds.width / bounds.height)
      let hoverTimer = null
      let hovering = false
      const updatePinHover = () => {
        if (pin.isDestroyed() || !pin.isVisible()) return
        const cursor = screen.getCursorScreenPoint()
        const area = pin.getBounds()
        const inside =
          cursor.x >= area.x &&
          cursor.x < area.x + area.width &&
          cursor.y >= area.y &&
          cursor.y < area.y + area.height
        if (inside === hovering) return
        hovering = inside
        if (!pin.webContents.isDestroyed()) {
          pin.webContents.send('screenshot:pin-hover', inside)
        }
      }
      pin.once('show', () => {
        clearInterval(hoverTimer)
        hoverTimer = setInterval(updatePinHover, 100)
        updatePinHover()
      })
      pin.webContents.on('ipc-message', (_event, channel) => {
        if (channel === 'screenshot:pin-ready') show()
      })
      pin.on('closed', () => {
        clearInterval(hoverTimer)
        hoverTimer = null
        finish()
      })
      pin.webContents.on('did-finish-load', () => {
        if (pin.isDestroyed()) {
          finish()
          return
        }
        pin.webContents.send('screenshot:pin-init', { image: image.toDataURL() })
        pin.setBounds(bounds)
      })
      timer = setTimeout(show, 1800)
      pin.loadFile(path.join(__dirname, 'screenshot-pin.html')).catch((error) => {
        this.logger?.warn('could not load pinned screenshot', error)
        finish()
      })
    })
  }
}

module.exports = { ScreenshotCapture }
