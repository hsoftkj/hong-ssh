'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('screenshot', {
  onInit: (callback) => on('screenshot:init', callback),
  finish: (payload) => ipcRenderer.send('screenshot:finish', payload),
  cancel: () => ipcRenderer.send('screenshot:cancel'),
  overlayReady: () => ipcRenderer.send('screenshot:overlay-ready'),
  pinReady: () => ipcRenderer.send('screenshot:pin-ready'),
  onSaveCancelled: (callback) => on('screenshot:save-cancelled', callback),
  onPinInit: (callback) => on('screenshot:pin-init', callback),
  onPinHover: (callback) => on('screenshot:pin-hover', callback),
  closePin: () => ipcRenderer.send('screenshot:pin-close')
})
