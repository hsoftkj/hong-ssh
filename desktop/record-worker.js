'use strict'

const preview = document.getElementById('preview')
const canvas = document.getElementById('canvas')

let stream = null
let recorder = null
let drawTimer = null
let chunkChain = Promise.resolve()
let finished = false
let starting = false
let region = { x: 0, y: 0, width: 0, height: 0 }
let displaySize = { width: 1, height: 1 }
let sourceSize = { width: 1, height: 1 }
let sourceRect = { x: 0, y: 0, width: 1, height: 1 }

function updateSourceRect() {
  const displayWidth = Math.max(1, displaySize.width)
  const displayHeight = Math.max(1, displaySize.height)
  sourceRect = {
    x: (region.x / displayWidth) * sourceSize.width,
    y: (region.y / displayHeight) * sourceSize.height,
    width: (region.width / displayWidth) * sourceSize.width,
    height: (region.height / displayHeight) * sourceSize.height
  }
}

window.__hongsshRecordState = () => ({
  region: { ...region },
  sourceRect: { ...sourceRect },
  output: { width: canvas.width, height: canvas.height }
})

function cleanup() {
  if (drawTimer) clearInterval(drawTimer)
  drawTimer = null
  try {
    stream?.getTracks().forEach((track) => track.stop())
  } catch {}
  stream = null
}

function fail(error) {
  if (finished) return
  finished = true
  cleanup()
  try {
    recorder?.state !== 'inactive' && recorder?.stop()
  } catch {}
  screenRecorder.workerError(error?.message || String(error))
}

async function start(config) {
  if (starting || finished) return
  starting = true
  try {
    const scale = Number(config.display?.scaleFactor) || 1
    const captureWidth = Math.max(1, Math.round(config.display.width * scale))
    const captureHeight = Math.max(1, Math.round(config.display.height * scale))
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: config.sourceId,
          maxWidth: captureWidth,
          maxHeight: captureHeight,
          maxFrameRate: config.fps
        }
      }
    })
    if (!stream) throw new Error('无法获取桌面画面')

    preview.srcObject = stream
    preview.muted = true
    await preview.play()
    if (!preview.videoWidth || !preview.videoHeight) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1200)
        preview.onloadedmetadata = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }

    const sourceWidth = preview.videoWidth || captureWidth
    const sourceHeight = preview.videoHeight || captureHeight
    const outputWidth = Math.max(2, Math.round(config.region.width * scale))
    const outputHeight = Math.max(2, Math.round(config.region.height * scale))
    displaySize = {
      width: Math.max(1, Number(config.display.width) || 1),
      height: Math.max(1, Number(config.display.height) || 1)
    }
    sourceSize = { width: sourceWidth, height: sourceHeight }
    region = {
      x: Number(config.region.x) || 0,
      y: Number(config.region.y) || 0,
      width: Number(config.region.width) || outputWidth,
      height: Number(config.region.height) || outputHeight
    }
    updateSourceRect()

    canvas.width = outputWidth
    canvas.height = outputHeight
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('无法创建画布')

    const draw = () => {
      try {
        context.drawImage(
          preview,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height,
          0,
          0,
          outputWidth,
          outputHeight
        )
      } catch {}
    }
    draw()
    drawTimer = setInterval(draw, Math.max(16, Math.round(1000 / (config.fps || 30))))

    const captured = canvas.captureStream(config.fps || 30)
    if (!captured) throw new Error('无法创建录制流')
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm'
    recorder = new MediaRecorder(captured, {
      mimeType,
      videoBitsPerSecond: Number(config.bitrate) || 8_000_000
    })

    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return
      chunkChain = chunkChain
        .then(async () => {
          const buffer = await event.data.arrayBuffer()
          screenRecorder.workerChunk(buffer)
        })
        .catch((error) => fail(error))
    }
    recorder.onerror = (event) => {
      fail(event.error || new Error('录制编码失败'))
    }
    recorder.onstop = async () => {
      if (finished) return
      finished = true
      cleanup()
      try {
        await chunkChain
      } catch {}
      screenRecorder.workerFinished()
    }
    recorder.start(1000)
    starting = false
    screenRecorder.workerReady()
  } catch (error) {
    starting = false
    fail(error)
  }
}

screenRecorder.onWorkerStart((config) => {
  void start(config)
})

screenRecorder.onWorkerRegion((next) => {
  if (!next) return
  region.x = Number(next.x) || 0
  region.y = Number(next.y) || 0
  updateSourceRect()
})

screenRecorder.onWorkerStop(() => {
  if (finished) return
  try {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    } else {
      finished = true
      cleanup()
      screenRecorder.workerFinished()
    }
  } catch (error) {
    fail(error)
  }
})
