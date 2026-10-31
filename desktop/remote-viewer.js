'use strict'

const api = window.remoteApi
const stage = document.getElementById('remote-stage')
const canvas = document.getElementById('remote-canvas')
const context = canvas.getContext('2d')
const cursorElement = document.getElementById('remote-cursor')
const statusElement = document.getElementById('remote-status')
const nameElement = document.getElementById('remote-name')
const addressElement = document.getElementById('remote-address')
const overlay = document.getElementById('remote-overlay')
const overlayTitle = document.getElementById('remote-overlay-title')
const overlayText = document.getElementById('remote-overlay-text')
const spinner = document.getElementById('remote-spinner')
const displayChooser = document.getElementById('display-chooser')
const reconnectButton = document.getElementById('reconnect-button')
const fullscreenButton = document.getElementById('fullscreen-button')
const fileButton = document.getElementById('file-button')
const displaySelect = document.getElementById('display-select')
const filesPanel = document.getElementById('remote-files')
const filesClose = document.getElementById('files-close')
const filesUpload = document.getElementById('files-upload')
const filesRefresh = document.getElementById('files-refresh')
const filesList = document.getElementById('files-list')
const filesDir = document.getElementById('files-dir')
const filesProgress = document.getElementById('files-progress')

const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1)
const frameCanvas = document.createElement('canvas')
const frameContext = frameCanvas.getContext('2d')
let hasFrame = false
let pendingFrames = []
let decoding = false
let waitingFull = false
let lastCursor = null
let imageRect = { x: 0, y: 0, width: 0, height: 0 }
let connected = false
let controlReady = false
let mouseTimer = null
let mousePosition = null
let pressedCodes = new Set()
let canvasMouseDown = false
let activeDisplayId = ''
let streamQuality = 62
let streamRefreshMs = 200

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function setStatus(text, state) {
  statusElement.textContent = text
  statusElement.className = 'remote-status'
  if (state === 'connected') statusElement.classList.add('is-connected')
  if (state === 'error') statusElement.classList.add('is-error')
}

function showOverlay(title, text, spinning) {
  overlay.classList.remove('is-hidden')
  displayChooser.classList.add('is-hidden')
  overlayTitle.textContent = title
  overlayText.textContent = text || ''
  spinner.style.display = spinning ? 'block' : 'none'
}

function hideOverlay() {
  overlay.classList.add('is-hidden')
}

function resizeCanvas() {
  const width = Math.max(1, stage.clientWidth)
  const height = Math.max(1, stage.clientHeight)
  canvas.width = Math.round(width * devicePixelRatio)
  canvas.height = Math.round(height * devicePixelRatio)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  draw()
}

function draw() {
  const width = canvas.width
  const height = canvas.height
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, height)
  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  if (!hasFrame) return
  const sourceWidth = frameCanvas.width
  const sourceHeight = frameCanvas.height
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const drawWidth = Math.round(sourceWidth * scale)
  const drawHeight = Math.round(sourceHeight * scale)
  const x = Math.round((width - drawWidth) / 2)
  const y = Math.round((height - drawHeight) / 2)
  context.imageSmoothingEnabled = true
  context.drawImage(frameCanvas, x, y, drawWidth, drawHeight)
  imageRect = {
    x: x / devicePixelRatio,
    y: y / devicePixelRatio,
    width: drawWidth / devicePixelRatio,
    height: drawHeight / devicePixelRatio
  }
  if (lastCursor) updateCursor(lastCursor)
}

function updateCursor(cursor) {
  if (!cursor) {
    cursorElement.style.display = 'none'
    return
  }
  const x = imageRect.x + clamp(cursor.x, 0, 1) * imageRect.width
  const y = imageRect.y + clamp(cursor.y, 0, 1) * imageRect.height
  if (x < 0 || y < 0 || x > imageRect.x + imageRect.width || y > imageRect.y + imageRect.height) {
    cursorElement.style.display = 'none'
    return
  }
  cursorElement.style.display = 'block'
  cursorElement.style.left = `${x}px`
  cursorElement.style.top = `${y}px`
}

async function decodeNext() {
  if (decoding || pendingFrames.length === 0) return
  decoding = true
  const frame = pendingFrames.shift()
  try {
    const blob = new Blob([frame.data], { type: 'image/jpeg' })
    const next = await createImageBitmap(blob)
    const header = frame.header
    if (header.partial) {
      if (
        !hasFrame ||
        frameCanvas.width !== header.width ||
        frameCanvas.height !== header.height ||
        !header.rect
      ) {
        next.close()
        waitingFull = true
        pendingFrames = []
        api.requestFull()
      } else {
        const rect = header.rect
        frameContext.drawImage(next, rect.x, rect.y, rect.width, rect.height)
        next.close()
        lastCursor = header.cursor || lastCursor
        draw()
      }
    } else {
      frameCanvas.width = header.width
      frameCanvas.height = header.height
      frameContext.drawImage(next, 0, 0)
      next.close()
      hasFrame = true
      lastCursor = header.cursor || lastCursor
      draw()
    }
  } catch (error) {
    console.error('frame decode failed', error)
    waitingFull = true
    pendingFrames = []
    api.requestFull()
  } finally {
    decoding = false
    if (pendingFrames.length) void decodeNext()
  }
}

function resetFrame() {
  hasFrame = false
  waitingFull = false
  pendingFrames = []
  lastCursor = null
  frameCanvas.width = 1
  frameCanvas.height = 1
  cursorElement.style.display = 'none'
  draw()
}

api.onFrame((header, data) => {
  if (activeDisplayId && header.displayId && header.displayId !== activeDisplayId) return
  if (waitingFull && header.partial) return
  if (waitingFull && !header.partial) waitingFull = false
  pendingFrames.push({ header, data })
  if (pendingFrames.length > 10) {
    pendingFrames = []
    waitingFull = true
    api.requestFull()
    return
  }
  if (!decoding) void decodeNext()
  if (!connected) {
    connected = true
  }
  controlReady = true
  setStatus('已连接', 'connected')
  hideOverlay()
  canvas.focus()
})

api.onCursor((message) => {
  if (
    activeDisplayId &&
    message?.displayId &&
    String(message.displayId) !== activeDisplayId
  ) {
    return
  }
  lastCursor = message?.cursor || message
  updateCursor(lastCursor)
})

function populateDisplays(displays, selectedId) {
  displaySelect.replaceChildren()
  if (!Array.isArray(displays) || displays.length <= 1) {
    displaySelect.classList.add('is-hidden')
    if (displays?.[0]?.id) activeDisplayId = String(displays[0].id)
    return
  }
  displaySelect.classList.remove('is-hidden')
  for (const display of displays) {
    const option = document.createElement('option')
    option.value = String(display.id)
    const size = display.size ? `${display.size.width}×${display.size.height}` : ''
    option.textContent = `${display.label || '屏幕'}${display.primary ? '（主屏）' : ''} ${size}`
    displaySelect.appendChild(option)
  }
  const selected = String(selectedId || displays[0].id)
  displaySelect.value = selected
  activeDisplayId = selected
}

api.onWelcome((welcome) => {
  connected = true
  setStatus('连接中…', '')
  if (welcome?.host) {
    addressElement.textContent = welcome.host
  }
  const displays = Array.isArray(welcome?.displays) ? welcome.displays : []
  if (welcome?.displays) populateDisplays(welcome.displays, welcome.display?.id)
  else if (welcome?.display?.id) activeDisplayId = String(welcome.display.id)

  if (displays.length > 1) {
    controlReady = false
    setStatus('请选择屏幕', '')
    overlay.classList.remove('is-hidden')
    spinner.style.display = 'none'
    overlayTitle.textContent = '选择要控制的屏幕'
    overlayText.textContent = '对方有多块屏幕，请选择这次要查看和控制的屏幕。'
    displayChooser.replaceChildren()
    for (const display of displays) {
      const button = document.createElement('button')
      button.className = 'display-choice'
      button.type = 'button'
      button.textContent = `${display.label || '屏幕'}${display.primary ? '（主屏）' : ''}`
      const detail = document.createElement('small')
      detail.textContent = display.size
        ? `${display.size.width} × ${display.size.height}`
        : ''
      button.appendChild(detail)
      button.addEventListener('click', () => chooseDisplay(display.id))
      displayChooser.appendChild(button)
    }
    displayChooser.classList.remove('is-hidden')
    return
  }

  const firstDisplay = welcome?.display?.id || displays[0]?.id
  if (firstDisplay) chooseDisplay(firstDisplay)
  else hideOverlay()
})

function chooseDisplay(displayId) {
  if (!displayId) return
  activeDisplayId = String(displayId)
  if (displaySelect.querySelector(`option[value="${activeDisplayId}"]`)) {
    displaySelect.value = activeDisplayId
  }
  controlReady = false
  resetFrame()
  showOverlay('正在获取屏幕画面…', '已选择屏幕，正在等待对方发送画面。', true)
  api.setDisplay(activeDisplayId)
}

api.onDisplay((display) => {
  if (!display?.id) return
  const id = String(display.id)
  if (activeDisplayId === id) return
  activeDisplayId = id
  if (displaySelect.querySelector(`option[value="${id}"]`)) {
    displaySelect.value = id
  }
  controlReady = false
  resetFrame()
  showOverlay('正在切换屏幕…', '正在获取所选显示器的画面。', true)
})

api.onStatus((status) => {
  if (status.state === 'connecting') {
    setStatus('连接中…', '')
    showOverlay('正在连接…', '正在建立 WebRTC 中继连接。', true)
  } else if (status.state === 'connected') {
    if (controlReady) setStatus('已连接', 'connected')
  } else if (status.state === 'closed') {
    connected = false
    setStatus('已断开', 'error')
    showOverlay('连接已断开', status.reason || '远程主机关闭了连接。', false)
  } else if (status.state === 'error') {
    connected = false
    setStatus('连接失败', 'error')
    showOverlay('连接失败', status.message || '无法连接远程主机。', false)
  }
})

api.onError((message) => {
  connected = false
  setStatus('连接失败', 'error')
  showOverlay('连接失败', message || '远程主机返回错误。', false)
})

function normalizedPoint(event) {
  const rect = canvas.getBoundingClientRect()
  const x = clamp((event.clientX - rect.left - imageRect.x) / Math.max(1, imageRect.width), 0, 1)
  const y = clamp((event.clientY - rect.top - imageRect.y) / Math.max(1, imageRect.height), 0, 1)
  return { x, y }
}

function flushMouse() {
  mouseTimer = null
  if (!mousePosition) return
  api.input({ type: 'mouse', action: 'move', ...mousePosition })
  mousePosition = null
}

function queueMouse(point) {
  mousePosition = point
  if (mouseTimer) return
  mouseTimer = setTimeout(flushMouse, 16)
}

canvas.addEventListener('mousemove', (event) => {
  if (!controlReady || imageRect.width <= 0) return
  queueMouse(normalizedPoint(event))
})
canvas.addEventListener('mousedown', (event) => {
  if (!controlReady || imageRect.width <= 0) return
  event.preventDefault()
  canvas.focus()
  canvasMouseDown = true
  const point = normalizedPoint(event)
  api.input({ type: 'mouse', action: 'down', ...point, button: event.button })
})
window.addEventListener('mouseup', (event) => {
  if (!controlReady || !canvasMouseDown || imageRect.width <= 0) return
  canvasMouseDown = false
  const point = normalizedPoint(event)
  api.input({ type: 'mouse', action: 'up', ...point, button: event.button })
})
canvas.addEventListener('wheel', (event) => {
  if (!controlReady) return
  event.preventDefault()
  api.input({
    type: 'mouse',
    action: 'wheel',
    delta: -event.deltaY * (event.deltaMode === 1 ? 16 : 1)
  })
}, { passive: false })
canvas.addEventListener('contextmenu', (event) => event.preventDefault())
canvas.addEventListener('mouseenter', () => canvas.focus())

function keyboardBlocked(target) {
  return target instanceof Element && Boolean(target.closest('button, input, textarea, select'))
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'F11') {
    event.preventDefault()
    void toggleFullscreen()
    return
  }
  if (!controlReady || keyboardBlocked(event.target)) return
  event.preventDefault()
  pressedCodes.add(event.code)
  api.input({ type: 'key', action: 'down', code: event.code })
})

window.addEventListener('keyup', (event) => {
  if (!controlReady || keyboardBlocked(event.target)) return
  event.preventDefault()
  pressedCodes.delete(event.code)
  api.input({ type: 'key', action: 'up', code: event.code })
})

window.addEventListener('blur', () => {
  for (const code of pressedCodes) api.input({ type: 'key', action: 'up', code })
  pressedCodes = new Set()
})

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (error) {
    console.error('fullscreen failed', error)
  }
}

document.addEventListener('fullscreenchange', () => {
  fullscreenButton.textContent = document.fullscreenElement ? '退出全屏' : '全屏'
})

fullscreenButton.addEventListener('click', () => void toggleFullscreen())
reconnectButton.addEventListener('click', () => void connect())
displaySelect.addEventListener('change', () => {
  if (!connected) return
  chooseDisplay(displaySelect.value)
})

function formatSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function showFiles(visible) {
  filesPanel.classList.toggle('is-hidden', !visible)
  if (visible) void loadFiles()
}

async function loadFiles() {
  filesList.replaceChildren(Object.assign(document.createElement('div'), {
    className: 'files-hint',
    textContent: '正在读取共享文件夹…'
  }))
  try {
    const result = await api.listFiles()
    filesDir.textContent = result.dir || ''
    if (!result.entries?.length) {
      filesList.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'files-hint',
        textContent: '共享文件夹为空。上传的文件会保存在对方的 Downloads\\HongSSH 目录。'
      }))
      return
    }
    filesList.replaceChildren()
    for (const entry of result.entries) {
      const row = document.createElement('div')
      row.className = 'file-row'
      const main = document.createElement('div')
      main.className = 'file-main'
      const name = document.createElement('span')
      name.className = 'file-name'
      name.textContent = entry.name
      const size = document.createElement('span')
      size.className = 'file-size'
      size.textContent = formatSize(entry.size)
      main.append(name, size)
      const download = document.createElement('button')
      download.className = 'remote-button'
      download.type = 'button'
      download.textContent = '下载'
      download.addEventListener('click', () => {
        download.disabled = true
        api
          .download(entry.name)
          .catch((error) => updateProgress({
            direction: 'download',
            name: entry.name,
            transferred: 0,
            total: entry.size,
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          }))
          .finally(() => {
            download.disabled = false
          })
      })
      row.append(main, download)
      filesList.appendChild(row)
    }
  } catch (error) {
    filesList.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'files-hint',
      textContent: error instanceof Error ? error.message : String(error)
    }))
  }
}

const progressRows = new Map()

function updateProgress(event) {
  const key = `${event.direction}:${event.name}`
  let row = progressRows.get(key)
  if (!row) {
    row = document.createElement('div')
    row.className = 'progress-row'
    const label = document.createElement('div')
    const bar = document.createElement('div')
    bar.className = 'progress-bar'
    const fill = document.createElement('span')
    bar.appendChild(fill)
    row.append(label, bar)
    row._label = label
    row._fill = fill
    filesProgress.prepend(row)
    progressRows.set(key, row)
  }
  const percent = event.total > 0 ? Math.min(100, (event.transferred / event.total) * 100) : 0
  const prefix = event.direction === 'upload' ? '↑' : '↓'
  row._label.textContent = `${prefix} ${event.name} · ${formatSize(event.transferred)} / ${formatSize(event.total)}`
  row._fill.style.width = `${percent}%`
  row.classList.toggle('is-done', event.status === 'done')
  row.classList.toggle('is-error', event.status === 'error')
  if (event.message) row.title = event.message
  if (event.status === 'done' && event.direction === 'upload') {
    void loadFiles()
  }
}

fileButton.addEventListener('click', () => {
  showFiles(filesPanel.classList.contains('is-hidden'))
})
filesClose.addEventListener('click', () => showFiles(false))
filesRefresh.addEventListener('click', () => void loadFiles())
filesUpload.addEventListener('click', async () => {
  try {
    await api.upload()
  } catch (error) {
    updateProgress({
      direction: 'upload',
      name: '上传',
      transferred: 0,
      total: 0,
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  }
})
api.onFileProgress(updateProgress)

async function connect() {
  try {
    const info = await api.info()
    if (info?.name) nameElement.textContent = info.name
    if (info?.relay) addressElement.textContent = `中继 ${info.relayDeviceId || ''}`
    else if (info?.host) addressElement.textContent = `${info.host}:${info.port}`
    streamQuality = Number(info?.quality) || 62
    streamRefreshMs = Number(info?.refreshMs) || 200
    connected = false
    controlReady = false
    activeDisplayId = ''
    resetFrame()
    showOverlay('正在连接…', '正在建立 WebRTC 中继连接。', true)
    await api.connect()
    api.setStream(streamRefreshMs, streamQuality)
  } catch (error) {
    showOverlay('连接失败', error instanceof Error ? error.message : String(error), false)
    setStatus('连接失败', 'error')
  }
}

window.addEventListener('resize', resizeCanvas)
resizeCanvas()
void connect()
