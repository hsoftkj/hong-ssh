'use strict'

const timeEl = document.getElementById('time')
const stopButton = document.getElementById('stop')
const bar = document.querySelector('.bar')

let startedAt = 0
let timer = null
let dragPointer = null
let dragStart = null

function format(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function tick() {
  if (!startedAt) return
  timeEl.textContent = format(Date.now() - startedAt)
}

screenRecorder.onControlInit((data) => {
  startedAt = Number(data?.startedAt) || Date.now()
  tick()
  if (timer) clearInterval(timer)
  timer = setInterval(tick, 500)
})

stopButton.addEventListener('click', () => {
  if (stopButton.disabled) return
  stopButton.disabled = true
  stopButton.textContent = '保存中…'
  screenRecorder.stopFromControl()
})

bar.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (event.target.closest('#stop')) return
  dragPointer = event.pointerId
  dragStart = { x: event.screenX, y: event.screenY }
  bar.classList.add('dragging')
  try {
    bar.setPointerCapture(event.pointerId)
  } catch {}
  screenRecorder.startControlDrag()
  event.preventDefault()
})

bar.addEventListener('pointermove', (event) => {
  if (dragPointer === null || !dragStart) return
  screenRecorder.moveControlDrag(event.screenX - dragStart.x, event.screenY - dragStart.y)
})

function endDrag(event) {
  if (dragPointer === null) return
  dragPointer = null
  dragStart = null
  bar.classList.remove('dragging')
  try {
    bar.releasePointerCapture?.(event.pointerId)
  } catch {}
  screenRecorder.endControlDrag()
}

bar.addEventListener('pointerup', endDrag)
bar.addEventListener('pointercancel', endDrag)

window.addEventListener('beforeunload', () => {
  if (timer) clearInterval(timer)
})
