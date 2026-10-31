'use strict'

const snapshot = document.getElementById('snapshot')
const dim = document.getElementById('dim')
const selectionEl = document.getElementById('selection')
const hint = document.getElementById('hint')
const actions = document.getElementById('actions')
const sizeEl = document.getElementById('size')
const startButton = document.getElementById('start')
const cancelButton = document.getElementById('cancel')
const reselectButton = document.getElementById('reselect')

const MIN_SIZE = 16

let mode = null
let dragStart = null
let origin = null
let handle = null
let current = null
let sent = false

screenRecorder.onOverlayInit((data) => {
  if (!data?.image) {
    screenRecorder.overlayReady?.()
    return
  }
  let readySent = false
  const notifyReady = () => {
    if (readySent) return
    readySent = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => screenRecorder.overlayReady?.())
    })
  }
  snapshot.onload = () => {
    snapshot.classList.add('ready')
    dim.hidden = false
    if (typeof snapshot.decode === 'function') {
      snapshot.decode().then(notifyReady, notifyReady)
    } else {
      notifyReady()
    }
  }
  snapshot.onerror = notifyReady
  snapshot.src = data.image
})

function point(event) {
  return {
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY))
  }
}

function normalize(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const width = Math.abs(a.x - b.x)
  const height = Math.abs(a.y - b.y)
  return { x, y, width, height }
}

function render(rect) {
  selectionEl.hidden = false
  selectionEl.style.left = `${rect.x}px`
  selectionEl.style.top = `${rect.y}px`
  selectionEl.style.width = `${rect.width}px`
  selectionEl.style.height = `${rect.height}px`
}

function reset() {
  dragStart = null
  origin = null
  handle = null
  mode = null
  current = null
  selectionEl.hidden = true
  actions.hidden = true
  hint.hidden = false
  dim.hidden = false
  startButton.disabled = true
  sizeEl.textContent = ''
  sent = false
}

function contains(rect, p) {
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
}

function capture(event) {
  try {
    document.body.setPointerCapture(event.pointerId)
  } catch {}
}

function release(event) {
  try {
    document.body.releasePointerCapture(event.pointerId)
  } catch {}
}

function resizeRect(originRect, edge, p) {
  let left = originRect.x
  let top = originRect.y
  let right = originRect.x + originRect.width
  let bottom = originRect.y + originRect.height
  if (edge.includes('w')) left = Math.max(0, Math.min(p.x, right - MIN_SIZE))
  if (edge.includes('e')) right = Math.min(window.innerWidth, Math.max(p.x, left + MIN_SIZE))
  if (edge.includes('n')) top = Math.max(0, Math.min(p.y, bottom - MIN_SIZE))
  if (edge.includes('s')) bottom = Math.min(window.innerHeight, Math.max(p.y, top + MIN_SIZE))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const ACTION_MARGIN = 8
const ACTION_GAP = 6

function positionActions(rect) {
  // Anchor to the bottom-right corner of the frame, just outside of it.
  actions.hidden = false
  const width = actions.offsetWidth
  const height = actions.offsetHeight
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  let left = rect.x + rect.width - width
  let top = rect.y + rect.height + ACTION_GAP
  if (top + height > viewportHeight - ACTION_MARGIN) {
    const above = rect.y - ACTION_GAP - height
    top = above >= ACTION_MARGIN ? above : rect.y + rect.height - height - ACTION_MARGIN
  }
  left = Math.max(ACTION_MARGIN, Math.min(viewportWidth - width - ACTION_MARGIN, left))
  top = Math.max(ACTION_MARGIN, Math.min(viewportHeight - height - ACTION_MARGIN, top))
  actions.style.left = `${Math.round(left)}px`
  actions.style.top = `${Math.round(top)}px`
}

function updateActions(rect) {
  if (rect.width < 16 || rect.height < 16) {
    reset()
    return
  }
  hint.hidden = true
  startButton.disabled = false
  sizeEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
  positionActions(rect)
}

document.addEventListener('contextmenu', (event) => event.preventDefault())

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (event.target.closest('#actions')) return
  if (sent) return
  event.preventDefault()
  const p = point(event)
  if (!current) {
    mode = 'new'
    dragStart = p
    current = { x: p.x, y: p.y, width: 0, height: 0 }
    dim.hidden = true
    hint.hidden = true
    actions.hidden = true
    render(current)
    capture(event)
    return
  }
  const handleEl = event.target.closest('.handle')
  if (handleEl) {
    mode = 'resize'
    dragStart = p
    origin = { ...current }
    handle = handleEl.dataset.handle
    actions.hidden = true
    capture(event)
    return
  }
  if (contains(current, p)) {
    mode = 'move'
    dragStart = p
    origin = { ...current }
    actions.hidden = true
    capture(event)
    return
  }
  mode = 'new'
  dragStart = p
  current = { x: p.x, y: p.y, width: 0, height: 0 }
  dim.hidden = true
  hint.hidden = true
  actions.hidden = true
  render(current)
  capture(event)
})

document.addEventListener('pointermove', (event) => {
  if (!mode || !dragStart) return
  const p = point(event)
  if (mode === 'new') {
    current = normalize(dragStart, p)
    render(current)
    return
  }
  if (mode === 'move' && origin) {
    current = {
      x: Math.max(0, Math.min(window.innerWidth - origin.width, origin.x + p.x - dragStart.x)),
      y: Math.max(0, Math.min(window.innerHeight - origin.height, origin.y + p.y - dragStart.y)),
      width: origin.width,
      height: origin.height
    }
    render(current)
    return
  }
  if (mode === 'resize' && origin && handle) {
    current = resizeRect(origin, handle, p)
    render(current)
  }
})

document.addEventListener('pointerup', (event) => {
  if (!mode) return
  const finished = mode
  mode = null
  release(event)
  if (!current || !dragStart) {
    reset()
    return
  }
  if (finished === 'new') {
    current = normalize(dragStart, point(event))
    render(current)
  }
  dragStart = null
  origin = null
  handle = null
  updateActions(current)
})

document.addEventListener('pointercancel', (event) => {
  if (!mode) return
  mode = null
  release(event)
  dragStart = null
  origin = null
  handle = null
  if (current) updateActions(current)
})

cancelButton.addEventListener('click', () => {
  sent = true
  screenRecorder.cancelSelection()
})

reselectButton.addEventListener('click', () => {
  reset()
})

startButton.addEventListener('click', () => {
  if (!current || current.width < 16 || current.height < 16 || sent) return
  sent = true
  screenRecorder.confirmSelection({
    x: Math.round(current.x),
    y: Math.round(current.y),
    width: Math.round(current.width),
    height: Math.round(current.height)
  })
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!sent) {
      sent = true
      screenRecorder.cancelSelection()
    }
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (current && current.width >= 16 && current.height >= 16) startButton.click()
  }
})

window.addEventListener('resize', () => {
  if (current && !actions.hidden) positionActions(current)
})

reset()
