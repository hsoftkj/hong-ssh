'use strict'

const image = document.getElementById('image')
const closeButton = document.getElementById('close')

let readySent = false
function notifyReady() {
  if (readySent) return
  readySent = true
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.screenshot.pinReady?.())
  })
}

image.addEventListener('load', () => {
  if (typeof image.decode === 'function') {
    image.decode().then(notifyReady, notifyReady)
  } else {
    notifyReady()
  }
})
image.addEventListener('error', notifyReady)

window.screenshot.onPinInit((data) => {
  if (data?.image) image.src = data.image
  else notifyReady()
})

function showClose() {
  document.body.classList.add('show-close')
}

function hideClose() {
  if (closeButton.matches(':hover')) return
  document.body.classList.remove('show-close')
}

window.screenshot.onPinHover((inside) => {
  document.body.classList.toggle('show-close', Boolean(inside))
})

document.addEventListener('mousemove', showClose, { passive: true })
document.addEventListener('mouseenter', showClose, { passive: true })
document.addEventListener('mouseleave', hideClose, { passive: true })
closeButton.addEventListener('mouseenter', showClose)
closeButton.addEventListener('mouseleave', hideClose)

closeButton.addEventListener('click', () => {
  window.screenshot.closePin()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.screenshot.closePin()
})

document.addEventListener('dblclick', () => {
  window.screenshot.closePin()
})

document.addEventListener('contextmenu', (event) => event.preventDefault())
