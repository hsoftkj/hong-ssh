'use strict'

const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron')

const INVOKE_CHANNELS = new Set([
  'app:info',
  'update:check',
  'update:state',
  'update:info',
  'state:load',
  'state:move',
  'settings:save',
  'remote:open-window',
  'connection:save',
  'connection:delete',
  'folder:save',
  'folder:delete',
  'dialog:private-key',
  'dialog:folder',
  'dialog:pick-files',
  'dialog:pick-upload-folder',
  'dialog:pick-directory',
  'xshell:import',
  'xshell:import-path',
  'xshell:export',
  'ssh:test',
  'inspection:run',
  'inspection:cancel',
  'ssh:open',
  'ssh:write',
  'ssh:resize',
  'ssh:reconnect',
  'ssh:disconnect',
  'sftp:home',
  'sftp:list',
  'sftp:mkdir',
  'sftp:rename',
  'sftp:remove',
  'sftp:upload',
  'sftp:download',
  'sftp:cancel',
  'sftp:drag-start',
  'sftp:open-local',
  'knownhosts:delete',
  'knownhosts:clear',
  'app:open-external',
  'app:open-data-folder',
  'clipboard:read-files',
  'screen:start-recording',
  'screen:stop-recording',
  'screenshot:start',
  'window:set-title',
  'window:minimize',
  'window:toggle-maximize',
  'window:is-maximized',
  'window:close',
  'app:confirm-quit-response'
])

const EVENT_CHANNELS = new Set([
  'ssh:data',
  'ssh:status',
  'ssh:closed',
  'ssh:hostkey',
  'ssh:system-info',
  'ssh:system-stats',
  'inspection:progress',
  'sftp:progress',
  'sftp:drag-download',
  'sftp:drag-error',
  'sftp:drag-cancel',
  'window:maximized',
  'app:confirm-quit',
  'app:menu-action',
  'remote:status',
  'screen:recording-status'
])

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`))
  return ipcRenderer.invoke(channel, ...args)
}

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.has(channel) || typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('hongssh', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  appInfo: () => invoke('app:info'),
  checkForUpdates: () => invoke('update:check'),
  getUpdateState: () => invoke('update:state'),
  getUpdateInfo: () => invoke('update:info'),
  loadState: () => invoke('state:load'),
  moveItems: (payload) => invoke('state:move', payload),
  saveSettings: (patch) => invoke('settings:save', patch),
  openRemoteWindow: (id) => invoke('remote:open-window', id),
  saveConnection: (payload) => invoke('connection:save', payload),
  deleteConnection: (id) => invoke('connection:delete', id),
  saveFolder: (payload) => invoke('folder:save', payload),
  deleteFolder: (id) => invoke('folder:delete', id),
  pickPrivateKey: () => invoke('dialog:private-key'),
  pickFolder: () => invoke('dialog:folder'),
  pickFiles: () => invoke('dialog:pick-files'),
  pickUploadFolders: () => invoke('dialog:pick-upload-folder'),
  pickDownloadDirectory: () => invoke('dialog:pick-directory'),
  importXshell: () => invoke('xshell:import'),
  importXshellFrom: (directory) => invoke('xshell:import-path', directory),
  exportXshell: () => invoke('xshell:export'),
  testConnection: (payload) => invoke('ssh:test', payload),
  runInspection: (payload) => invoke('inspection:run', payload),
  cancelInspection: (runId) => invoke('inspection:cancel', runId),
  openSession: (payload) => invoke('ssh:open', payload),
  writeSession: (sessionId, data) => invoke('ssh:write', { sessionId, data }),
  resizeSession: (sessionId, cols, rows) => invoke('ssh:resize', { sessionId, cols, rows }),
  reconnectSession: (sessionId) => invoke('ssh:reconnect', sessionId),
  disconnectSession: (sessionId, destroy = false) =>
    invoke('ssh:disconnect', { sessionId, destroy }),
  sftpHome: (sessionId) => invoke('sftp:home', sessionId),
  sftpList: (sessionId, path) => invoke('sftp:list', { sessionId, path }),
  sftpMkdir: (sessionId, path) => invoke('sftp:mkdir', { sessionId, path }),
  sftpRename: (sessionId, from, to) => invoke('sftp:rename', { sessionId, from, to }),
  sftpRemove: (sessionId, path, recursive = false) =>
    invoke('sftp:remove', { sessionId, path, recursive }),
  sftpUpload: (payload) => invoke('sftp:upload', payload),
  sftpDownload: (payload) => invoke('sftp:download', payload),
  sftpCancel: (transferId) => invoke('sftp:cancel', transferId),
  startDragDownload: (sessionId, items, dragImage = '') =>
    invoke('sftp:drag-start', { sessionId, items, dragImage }),
  openLocalPath: (targetPath) => invoke('sftp:open-local', targetPath),
  deleteKnownHost: (hostKey) => invoke('knownhosts:delete', hostKey),
  clearKnownHosts: () => invoke('knownhosts:clear'),
  openExternal: (url) => invoke('app:open-external', url),
  openDataFolder: () => invoke('app:open-data-folder'),
  setWindowTitle: (title) => invoke('window:set-title', title),
  windowMinimize: () => invoke('window:minimize'),
  windowToggleMaximize: () => invoke('window:toggle-maximize'),
  windowIsMaximized: () => invoke('window:is-maximized'),
  windowClose: () => invoke('window:close'),
  confirmQuit: (confirmed) => invoke('app:confirm-quit-response', confirmed),
  clipboardWrite: (text) => {
    if (typeof text !== 'string') return
    if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(text)
    else ipcRenderer.sendSync('clipboard:write-text', text)
  },
  clipboardRead: () =>
    clipboard && typeof clipboard.readText === 'function'
      ? clipboard.readText()
      : String(ipcRenderer.sendSync('clipboard:read-text') || ''),
  getPathForFile: (file) => {
    try {
      return webUtils?.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  readClipboardFiles: () => invoke('clipboard:read-files'),
  startScreenRecording: () => invoke('screen:start-recording'),
  stopScreenRecording: () => invoke('screen:stop-recording'),
  startScreenshot: () => invoke('screenshot:start'),
  onSshData: (callback) => subscribe('ssh:data', callback),
  onSshStatus: (callback) => subscribe('ssh:status', callback),
  onSshClosed: (callback) => subscribe('ssh:closed', callback),
  onSshHostKey: (callback) => subscribe('ssh:hostkey', callback),
  onSystemInfo: (callback) => subscribe('ssh:system-info', callback),
  onSystemStats: (callback) => subscribe('ssh:system-stats', callback),
  onInspectionProgress: (callback) => subscribe('inspection:progress', callback),
  onSftpProgress: (callback) => subscribe('sftp:progress', callback),
  onSftpDragDownload: (callback) => subscribe('sftp:drag-download', callback),
  onSftpDragError: (callback) => subscribe('sftp:drag-error', callback),
  onSftpDragCancel: (callback) => subscribe('sftp:drag-cancel', callback),
  onWindowMaximized: (callback) => subscribe('window:maximized', callback),
  onConfirmQuit: (callback) => subscribe('app:confirm-quit', callback),
  onRemoteStatus: (callback) => subscribe('remote:status', callback),
  onScreenRecordingStatus: (callback) => subscribe('screen:recording-status', callback),
  onMenuAction: (callback) => subscribe('app:menu-action', callback)
})
