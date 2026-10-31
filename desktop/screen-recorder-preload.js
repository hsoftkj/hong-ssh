'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('screenRecorder', {
  onOverlayInit: (callback) => on('screen:overlay-init', callback),
  overlayReady: () => ipcRenderer.send('screen:overlay-ready'),
  confirmSelection: (rect) => ipcRenderer.send('screen:selection', rect),
  cancelSelection: () => ipcRenderer.send('screen:selection-cancel'),
  onWorkerStart: (callback) => on('screen:worker-start', callback),
  onWorkerStop: (callback) => on('screen:worker-stop', callback),
  onWorkerRegion: (callback) => on('screen:worker-region', callback),
  workerReady: () => ipcRenderer.send('screen:worker-ready'),
  workerChunk: (data) => ipcRenderer.send('screen:worker-chunk', data),
  workerFinished: () => ipcRenderer.send('screen:worker-finished'),
  workerError: (message) => ipcRenderer.send('screen:worker-error', String(message || '录制失败')),
  onControlInit: (callback) => on('screen:control-init', callback),
  stopFromControl: () => ipcRenderer.send('screen:control-stop'),
  startControlDrag: () => ipcRenderer.send('screen:control-drag-start'),
  moveControlDrag: (dx, dy) =>
    ipcRenderer.send('screen:control-drag-move', { dx: Number(dx) || 0, dy: Number(dy) || 0 }),
  endControlDrag: () => ipcRenderer.send('screen:control-drag-end')
})
