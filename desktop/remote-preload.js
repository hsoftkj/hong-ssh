'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('remoteApi', {
  info: () => ipcRenderer.invoke('remote:info'),
  connect: () => ipcRenderer.invoke('remote:connect'),
  input: (message) => ipcRenderer.send('remote:input', message),
  setStream: (refreshMs, quality) => ipcRenderer.send('remote:stream', { refreshMs, quality }),
  requestFull: () => ipcRenderer.send('remote:request-full'),
  setDisplay: (displayId) => ipcRenderer.send('remote:display', displayId),
  listFiles: () => ipcRenderer.invoke('remote:list-files'),
  upload: () => ipcRenderer.invoke('remote:upload'),
  download: (name) => ipcRenderer.invoke('remote:download', name),
  closeWindow: () => ipcRenderer.send('remote:close-window'),
  onFrame: (callback) => subscribe('remote:frame', callback),
  onCursor: (callback) => subscribe('remote:cursor', callback),
  onStatus: (callback) => subscribe('remote:status', callback),
  onWelcome: (callback) => subscribe('remote:welcome', callback),
  onError: (callback) => subscribe('remote:error', callback),
  onDisplay: (callback) => subscribe('remote:display', callback),
  onFileProgress: (callback) => subscribe('remote:file-progress', callback)
})
