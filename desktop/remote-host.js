'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { desktopCapturer, screen } = require('electron')

const { encodeMessage, createParser } = require('./remote-wire')
const { InputInjector } = require('./remote-input')

const KEY_MAP = {
  Enter: 0x0d,
  NumpadEnter: 0x0d,
  Escape: 0x1b,
  Backspace: 0x08,
  Tab: 0x09,
  Space: 0x20,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  ShiftLeft: 0x10,
  ShiftRight: 0x10,
  ControlLeft: 0x11,
  ControlRight: 0x11,
  AltLeft: 0x12,
  AltRight: 0x12,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  CapsLock: 0x14,
  NumLock: 0x90,
  ScrollLock: 0x91,
  PrintScreen: 0x2c,
  Pause: 0x13,
  Backquote: 0xc0,
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadMultiply: 0x6a,
  NumpadDivide: 0x6f,
  NumpadDecimal: 0x6e
}

const EXTENDED_KEYS = new Set([
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Insert',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'NumLock',
  'PrintScreen',
  'NumpadDivide',
  'NumpadEnter',
  'ControlRight',
  'AltRight',
  'MetaRight'
])

function keyInfo(code) {
  if (typeof code !== 'string' || !code) return null
  const extended = EXTENDED_KEYS.has(code)
  if (KEY_MAP[code]) return { vk: KEY_MAP[code], extended }
  if (/^Key[A-Z]$/.test(code)) return { vk: code.charCodeAt(3), extended: false }
  if (/^Digit[0-9]$/.test(code)) return { vk: code.charCodeAt(5), extended: false }
  if (/^Numpad[0-9]$/.test(code)) return { vk: 0x60 + Number(code.slice(6)), extended: false }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    const number = Number(code.slice(1))
    return { vk: number <= 12 ? 0x70 + number - 1 : 0x7c + number - 13, extended: false }
  }
  return null
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function streamConfig(message) {
  const source = message && typeof message === 'object' ? message : {}
  const direct = Number(source.refreshMs ?? source.intervalMs)
  const legacyFps = Number(source.fps)
  const refreshMs = clamp(
    Number.isFinite(direct) && direct > 0
      ? direct
      : legacyFps > 0
        ? 1000 / legacyFps
        : 200,
    50,
    2000
  )
  return {
    refreshMs: Math.round(refreshMs),
    quality: clamp(Number(source.quality) || 62, 30, 85)
  }
}

/**
 * Finds the bounding box of changed pixels and aligns it to 16px JPEG blocks.
 * The bitmap is BGRA, so comparing 32-bit pixels is enough to detect changes.
 */
function findDirtyRect(previous, current, width, height) {
  if (!previous || previous.length !== current.length) return null
  const expected = width * height * 4
  if (previous.length < expected || current.length < expected) return null
  if (previous.byteOffset % 4 !== 0 || current.byteOffset % 4 !== 0) return null
  const before = new Uint32Array(previous.buffer, previous.byteOffset, width * height)
  const after = new Uint32Array(current.buffer, current.byteOffset, width * height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let rowMin = width
    let rowMax = -1
    for (let x = 0; x < width; x += 1) {
      if (before[row + x] !== after[row + x]) {
        if (x < rowMin) rowMin = x
        if (x > rowMax) rowMax = x
      }
    }
    if (rowMax >= 0) {
      if (rowMin < minX) minX = rowMin
      if (rowMax > maxX) maxX = rowMax
      if (y < minY) minY = y
      maxY = y
    }
  }
  if (maxX < 0) return null
  const pad = 8
  const align = 16
  const x = Math.max(0, Math.floor((minX - pad) / align) * align)
  const y = Math.max(0, Math.floor((minY - pad) / align) * align)
  const right = Math.min(width, Math.ceil((maxX + 1 + pad) / align) * align)
  const bottom = Math.min(height, Math.ceil((maxY + 1 + pad) / align) * align)
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

class RemoteHost {
  constructor(options) {
    this.sharedDir = options.sharedDir
    this.logger = options.logger
    this.onStatus = options.onStatus
    this.input = new InputInjector(this.logger)
    this.clients = new Set()
    this.transfers = new Map()
    this.port = 0
    this.capturing = false
    this.running = false
    this.stream = { refreshMs: 200, quality: 62 }
    this.selectedDisplayId = ''
    this.forceFrame = false
    this.cursorTimer = null
    this.lastCursorKey = ''
  }

  isRunning() {
    return this.running
  }

  async startRelayOnly() {
    await this.stop()
    this.password = ''
    this.port = 0
    this.running = true
    this.input.warmup()
    this.startCursorLoop()
    this.logger?.info('remote relay host started', { sharedDir: this.sharedDir })
    this.emitStatus()
  }

  async stop() {
    this.running = false
    this.capturing = false
    this.stopCursorLoop()
    for (const client of [...this.clients]) {
      try {
        client.ws.close(1001, 'host stopped')
      } catch {}
    }
    this.clients.clear()
    for (const transfer of this.transfers.values()) {
      try {
        transfer.stream?.destroy()
      } catch {}
    }
    this.transfers.clear()
    this.input.stop()
    this.emitStatus()
  }

  emitStatus() {
    this.onStatus?.({
      running: this.isRunning(),
      port: this.port,
      clients: this.clients.size
    })
  }

  /** Attach a WebRTC DataChannel adapter to this host. */
  attachClient(ws, address = '') {
    const client = {
      ws,
      address,
      authed: false,
      timer: null,
      stream: { refreshMs: 200, quality: 62 }
    }
    client.timer = setTimeout(() => {
      if (!client.authed) ws.close(4001, 'auth timeout')
    }, 10000)
    const parser = createParser((message, payload) => {
      try {
        this.handleMessage(client, message, payload)
      } catch (error) {
        this.logger?.warn('remote message failed', error)
        ws.close(4002, 'bad message')
      }
    })
    ws.on('message', (data) => {
      try {
        parser(data)
      } catch (error) {
        this.logger?.warn('remote frame parse failed', error)
        ws.close(4002, 'bad frame')
      }
    })
    ws.on('close', () => {
      clearTimeout(client.timer)
      this.clients.delete(client)
      for (const [id, transfer] of [...this.transfers]) {
        if (transfer.client !== client) continue
        try {
          transfer.stream?.destroy()
        } catch {}
        this.transfers.delete(id)
      }
      if (this.clients.size === 0) this.stream = { refreshMs: 200, quality: 62 }
      this.emitStatus()
    })
    ws.on('error', (error) => this.logger?.warn('remote client error', error))
    return client
  }

  handleMessage(client, message, payload) {
    if (!client.authed) {
      if (message.type !== 'auth') return
      clearTimeout(client.timer)
      client.authed = true
      client.stream = streamConfig(message)
      this.stream = client.stream
      this.clients.add(client)
      const display = this.currentDisplay()
      const size = this.captureSize(display)
      if (!this.selectedDisplayId) this.selectedDisplayId = String(display.id)
      this.send(client, {
        type: 'welcome',
        version: 1,
        host: os.hostname(),
        displays: this.displayList(),
        display: this.displayInfo(display),
        screen: {
          width: size.width,
          height: size.height,
          scaleFactor: display.scaleFactor || 1
        },
        sharedDir: this.sharedDir
      })
      this.logger?.info('remote client connected', { address: client.address })
      this.emitStatus()
      return
    }

    switch (message.type) {
      case 'stream':
        client.stream = streamConfig(message)
        this.stream = client.stream
        break
      case 'ping':
        this.send(client, { type: 'pong', time: Date.now() })
        break
      case 'mouse':
        this.handleMouse(message)
        break
      case 'key':
        this.handleKey(message)
        break
      case 'display':
        this.selectDisplay(message.displayId)
        break
      case 'request-full':
        this.forceFrame = true
        if (this.clients.size > 0) void this.startCapture()
        break
      case 'list-displays':
        this.send(client, {
          type: 'displays',
          displays: this.displayList(),
          selectedId: this.selectedDisplayId
        })
        break
      case 'file-list':
        this.handleFileList(client, message)
        break
      case 'file-upload-start':
        this.handleUploadStart(client, message)
        break
      case 'file-upload-chunk':
        this.handleUploadChunk(client, message, payload)
        break
      case 'file-upload-end':
        this.handleUploadEnd(client, message)
        break
      case 'file-download-start':
        void this.handleDownloadStart(client, message)
        break
      default:
        break
    }
  }

  displayList() {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: display.label || `屏幕 ${index + 1}`,
      primary: String(display.id) === String(primary.id),
      bounds: { ...display.bounds },
      size: { ...display.size },
      scaleFactor: display.scaleFactor || 1
    }))
  }

  displayInfo(display) {
    const list = this.displayList()
    const found = list.find((item) => item.id === String(display.id))
    if (found) return found
    return {
      id: String(display.id),
      label: display.label || '屏幕',
      primary: false,
      bounds: { ...display.bounds },
      size: { ...display.size },
      scaleFactor: display.scaleFactor || 1
    }
  }

  currentDisplay() {
    const displays = screen.getAllDisplays()
    const selected = displays.find((display) => String(display.id) === this.selectedDisplayId)
    return selected || screen.getPrimaryDisplay()
  }

  selectDisplay(displayId) {
    const displays = screen.getAllDisplays()
    const display = displays.find((item) => String(item.id) === String(displayId))
    if (!display) return
    this.selectedDisplayId = String(display.id)
    this.lastCursorKey = ''
    this.forceFrame = true
    this.broadcast({ type: 'display-changed', display: this.displayInfo(display) })
    if (this.clients.size > 0) void this.startCapture()
  }

  captureSize(display) {
    const scale = display.scaleFactor || 1
    const width = Math.max(720, Math.min(1600, Math.round(display.size.width * scale)))
    const height = Math.max(400, Math.round((width * display.size.height) / display.size.width))
    return { width, height }
  }

  pointerPosition(message) {
    const display = this.currentDisplay()
    const bounds = display.bounds
    const x = clamp(Number(message.x) || 0, 0, 1)
    const y = clamp(Number(message.y) || 0, 0, 1)
    const dipPoint = {
      x: bounds.x + x * bounds.width,
      y: bounds.y + y * bounds.height
    }
    return screen.dipToScreenPoint(dipPoint)
  }

  handleMouse(message) {
    const action = message.action
    if (action === 'wheel') {
      const delta = clamp(Number(message.delta) || 0, -1200, 1200)
      if (delta !== 0) this.input.wheel(delta)
      return
    }
    const point = this.pointerPosition(message)
    if (action === 'move') {
      this.input.move(point.x, point.y)
      return
    }
    if (action === 'down' || action === 'up') {
      this.input.move(point.x, point.y)
      const button = message.button === 2 ? 'right' : message.button === 1 ? 'middle' : 'left'
      this.input.button(action, button)
    }
  }

  handleKey(message) {
    const action = message.action
    if (action !== 'down' && action !== 'up') return
    const info = keyInfo(message.code)
    if (!info) return
    this.input.key(action, info.vk, info.extended)
  }

  safeSharedPath(name) {
    const base = path.basename(String(name || ''))
    if (!base || base === '.' || base === '..' || base.includes('\0')) {
      throw new Error('文件名无效')
    }
    const root = path.resolve(this.sharedDir)
    const full = path.resolve(root, base)
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
      throw new Error('文件路径无效')
    }
    return full
  }

  fileError(client, id, message) {
    this.send(client, { type: 'file-error', id, message })
  }

  handleFileList(client, message) {
    const requestId = String(message.requestId || '')
    try {
      const entries = []
      for (const entry of fs.readdirSync(this.sharedDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        try {
          const stat = fs.statSync(path.join(this.sharedDir, entry.name))
          entries.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs })
        } catch {}
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      this.send(client, {
        type: 'file-list',
        requestId,
        dir: this.sharedDir,
        entries
      })
    } catch (error) {
      this.send(client, {
        type: 'file-error',
        id: requestId,
        message: `无法读取共享文件夹：${error.message}`
      })
    }
  }

  handleUploadStart(client, message) {
    const id = String(message.id || '').slice(0, 80)
    if (!id) return
    try {
      const name = path.basename(String(message.name || ''))
      const size = Number(message.size)
      if (!Number.isFinite(size) || size < 0) throw new Error('文件大小无效')
      const final = this.safeSharedPath(name)
      const part = `${final}.part`
      let offset = 0
      try {
        const stat = fs.statSync(part)
        if (stat.isFile()) offset = stat.size
      } catch {}
      if (offset > size) {
        fs.rmSync(part, { force: true })
        offset = 0
      }
      const stream = fs.createWriteStream(part, offset > 0 ? { flags: 'r+', start: offset } : { flags: 'w' })
      const transfer = {
        kind: 'upload',
        id,
        name,
        size,
        received: offset,
        stream,
        client,
        final,
        part,
        done: false
      }
      this.transfers.set(id, transfer)
      stream.on('error', (error) => {
        this.transfers.delete(id)
        this.fileError(client, id, `写入文件失败：${error.message}`)
      })
      this.send(client, { type: 'file-upload-ready', id, offset, size })
      if (size === offset) this.completeUpload(transfer)
    } catch (error) {
      this.fileError(client, id, error.message || String(error))
    }
  }

  handleUploadChunk(client, message, payload) {
    const transfer = this.transfers.get(String(message.id || ''))
    if (!transfer || transfer.kind !== 'upload' || transfer.client !== client) return
    if (transfer.done || !payload || payload.length === 0) return
    if (transfer.received + payload.length > transfer.size) {
      try {
        transfer.stream.destroy()
      } catch {}
      this.transfers.delete(transfer.id)
      try {
        fs.rmSync(transfer.part, { force: true })
      } catch {}
      this.fileError(client, transfer.id, '收到的文件数据超过原始大小')
      return
    }
    transfer.received += payload.length
    transfer.stream.write(payload)
    if (transfer.received >= transfer.size) this.completeUpload(transfer)
  }

  handleUploadEnd(client, message) {
    const transfer = this.transfers.get(String(message.id || ''))
    if (!transfer || transfer.kind !== 'upload' || transfer.client !== client) return
    if (transfer.received >= transfer.size) this.completeUpload(transfer)
    else this.fileError(client, transfer.id, '上传未完成，请重试续传')
  }

  completeUpload(transfer) {
    if (transfer.done) return
    transfer.done = true
    transfer.stream.end(() => {
      try {
        if (fs.existsSync(transfer.final)) fs.rmSync(transfer.final, { force: true })
        fs.renameSync(transfer.part, transfer.final)
        this.transfers.delete(transfer.id)
        this.send(transfer.client, {
          type: 'file-upload-complete',
          id: transfer.id,
          name: transfer.name,
          size: transfer.size
        })
      } catch (error) {
        this.transfers.delete(transfer.id)
        this.fileError(transfer.client, transfer.id, `保存文件失败：${error.message}`)
      }
    })
  }

  async handleDownloadStart(client, message) {
    const id = String(message.id || '').slice(0, 80)
    if (!id) return
    try {
      const name = path.basename(String(message.name || ''))
      const file = this.safeSharedPath(name)
      const stat = fs.statSync(file)
      if (!stat.isFile()) throw new Error('目标不是文件')
      const offset = clamp(Number(message.offset) || 0, 0, stat.size)
      const stream = fs.createReadStream(file, { start: offset, highWaterMark: 64 * 1024 })
      const transfer = { kind: 'download', id, name, size: stat.size, stream, client }
      this.transfers.set(id, transfer)
      this.send(client, {
        type: 'file-download-start',
        id,
        name,
        size: stat.size,
        offset
      })
      stream.on('data', (chunk) => {
        if (this.transfers.get(id) !== transfer) return
        this.send(client, { type: 'file-download-chunk', id }, chunk)
        if (client.ws.bufferedAmount > 4 * 1024 * 1024) {
          stream.pause()
          setTimeout(() => {
            if (this.transfers.get(id) === transfer) stream.resume()
          }, 20)
        }
      })
      stream.on('end', () => {
        if (this.transfers.get(id) !== transfer) return
        this.transfers.delete(id)
        this.send(client, {
          type: 'file-download-complete',
          id,
          name,
          size: stat.size
        })
      })
      stream.on('error', (error) => {
        if (this.transfers.get(id) !== transfer) return
        this.transfers.delete(id)
        this.fileError(client, id, `读取文件失败：${error.message}`)
      })
    } catch (error) {
      this.fileError(client, id, error.message || String(error))
    }
  }

  send(client, message, payload) {
    if (client.ws.readyState !== client.ws.OPEN) return
    client.ws.send(encodeMessage(message, payload))
  }

  broadcast(message, payload) {
    if (this.clients.size === 0) return
    const frame = encodeMessage(message, payload)
    for (const client of this.clients) {
      if (client.ws.readyState !== client.ws.OPEN) continue
      if (client.ws.bufferedAmount > 4 * 1024 * 1024) continue
      client.ws.send(frame)
    }
  }

  startCursorLoop() {
    if (this.cursorTimer) return
    this.lastCursorKey = ''
    this.cursorTimer = setInterval(() => {
      if (!this.running || this.clients.size === 0) return
      const display = this.currentDisplay()
      const pointer = screen.getCursorScreenPoint()
      const bounds = display.bounds
      const cursor = {
        x: clamp((pointer.x - bounds.x) / Math.max(1, bounds.width), 0, 1),
        y: clamp((pointer.y - bounds.y) / Math.max(1, bounds.height), 0, 1)
      }
      const key = `${cursor.x.toFixed(4)},${cursor.y.toFixed(4)}`
      if (key === this.lastCursorKey) return
      this.lastCursorKey = key
      this.broadcast({ type: 'cursor', displayId: String(display.id), cursor })
    }, 33)
  }

  stopCursorLoop() {
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    this.cursorTimer = null
    this.lastCursorKey = ''
  }

  async startCapture() {
    if (this.capturing) return
    this.capturing = true
    try {
      await this.captureLoop()
    } finally {
      this.capturing = false
    }
  }

  async captureLoop() {
    let sequence = 0
    let previousBitmap = null
    while (this.running && this.clients.size > 0) {
      const started = Date.now()
      try {
        if (this.forceFrame) {
          previousBitmap = null
          this.forceFrame = false
        }
        const display = this.currentDisplay()
        const size = this.captureSize(display)
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: size.width, height: size.height },
          fetchWindowIcons: false
        })
        const source =
          sources.find((item) => item.display_id === String(display.id)) || sources[0]
        if (!source) throw new Error('没有可用的屏幕源')
        const image = source.thumbnail
        const imageSize = image.getSize()
        const bitmap = image.toBitmap()
        const pointer = screen.getCursorScreenPoint()
        const bounds = display.bounds
        const cursor = {
          x: clamp((pointer.x - bounds.x) / Math.max(1, bounds.width), 0, 1),
          y: clamp((pointer.y - bounds.y) / Math.max(1, bounds.height), 0, 1)
        }
        const imageChanged =
          !previousBitmap ||
          previousBitmap.length !== bitmap.length ||
          !bitmap.equals(previousBitmap)

        if (!imageChanged) {
          // Cursor movement is handled by startCursorLoop at a higher rate;
          // an idle screen sends nothing here.
        } else {
          const dirty = findDirtyRect(
            previousBitmap,
            bitmap,
            imageSize.width,
            imageSize.height
          )
          previousBitmap = bitmap
          const fullArea = imageSize.width * imageSize.height
          const partialArea = dirty ? dirty.width * dirty.height : fullArea
          const header = {
            type: 'frame',
            width: imageSize.width,
            height: imageSize.height,
            seq: ++sequence,
            displayId: String(display.id),
            cursor,
            partial: false
          }
          let payload
          // Small changes (clock, caret, cursor trail) only send a JPEG patch.
          if (dirty && partialArea < fullArea * 0.55) {
            header.partial = true
            header.rect = dirty
            payload = image.crop(dirty).toJPEG(this.stream.quality)
          } else {
            payload = image.toJPEG(this.stream.quality)
          }
          this.broadcast(header, payload)
        }
      } catch (error) {
        this.logger?.warn('remote screen capture failed', error)
        await delay(1000)
      }
      const frameTime = Math.max(50, Number(this.stream.refreshMs) || 200)
      await delay(Math.max(30, frameTime - (Date.now() - started)))
    }
  }
}

module.exports = { RemoteHost }
