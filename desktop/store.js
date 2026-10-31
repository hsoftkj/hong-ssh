'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { safeStorage } = require('electron')

const DATA_VERSION = 2
// 中继地址与 HOST_TOKEN 不再内置默认值：请自行部署 relay-server.js，
// 然后在“设置 → 远程控制（WebRTC 中继）”中填写，详见 relay-server-README.md。
const DEFAULT_RELAY_URL = ''
const DEFAULT_RELAY_TOKEN = ''

function newRelayDeviceId() {
  return String(crypto.randomInt(100000000, 999999999))
}

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'light',
  terminalTheme: 'xshell',
  fontFamily: '',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClick: 'contextMenu',
  confirmClose: true,
  autoReconnect: false,
  autoReconnectAttempts: 3,
  sidebarVisible: true,
  sidebarWidth: 286,
  sftpWidth: 430,
  hideSidebarScrollbar: true,
  showQuickCommands: true,
  terminalType: 'xterm-256color',
  keepaliveInterval: 15,
  hostKeyPolicy: 'accept-new',
  showStatusBar: true,
  bell: false,
  remoteEnabled: true,
  relayEnabled: true,
  relayUrl: DEFAULT_RELAY_URL,
  relayToken: DEFAULT_RELAY_TOKEN,
  relayDeviceId: '',
  inspectionDiskThreshold: 90
})

const AUTH_TYPES = new Set(['password', 'privateKey', 'agent'])
const HOST_KEY_POLICIES = new Set(['accept-new', 'strict', 'insecure'])
const THEMES = new Set([
  'light',
  'flat',
  'skeuomorphic',
  'handdrawn',
  'watercolor',
  'pixel',
  'neumorphic',
  'cyberpunk',
  'dark',
  'paper',
  'cute',
  'minimal',
  'swiss',
  'neon',
  'metal',
  'wood',
  'fabric',
  'gothic',
  'forest',
  'luxury',
  'eyecare'
])
const TERMINAL_THEMES = new Set(['xshell', 'solarized', 'light'])
const RIGHT_CLICK = new Set(['paste', 'contextMenu', 'nothing'])

function now() {
  return Date.now()
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  // Strip control characters that could break the UI or log files.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLength)
}

function cleanHost(value) {
  return cleanText(value, 255).replace(/\s+/g, '')
}

function cleanFolderName(value) {
  return cleanText(value, 80).replace(/[\\/:*?"<>|]/g, '_') || '新建文件夹'
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp`
  const text = JSON.stringify(data, null, 2)
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.copyFileSync(tmp, file)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
  }
}

function backupFile(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  } catch {
    // ignore
  }
}

class Store {
  constructor(directory, logger) {
    this.directory = directory
    this.logger = logger
    this.dataFile = path.join(directory, 'data.json')
    this.secretsFile = path.join(directory, 'secrets.json')
    fs.mkdirSync(directory, { recursive: true })
    this.data = this.readData()
    this.secrets = this.readSecrets()
    this.secretsEncrypted = this.canEncrypt()
    this.normalize()
    this.persist()
  }

  canEncrypt() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  readData() {
    const primary = readJson(this.dataFile)
    const backup = primary ? null : readJson(`${this.dataFile}.bak`)
    const source = primary || backup
    if (!source || typeof source !== 'object') {
      return { version: DATA_VERSION, folders: [], connections: [], settings: {}, knownHosts: {} }
    }
    if (primary) this.logger?.info('state loaded', { connections: source.connections?.length ?? 0 })
    else if (backup) this.logger?.warn('primary state unreadable, restored backup')
    return source
  }

  readSecrets() {
    const raw = readJson(this.secretsFile)
    if (!raw || typeof raw !== 'object') return {}
    const result = {}
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue
      result[id] = {}
      for (const field of ['password', 'passphrase']) {
        if (typeof value[field] === 'string' && value[field]) result[id][field] = value[field]
      }
    }
    return result
  }

  normalize() {
    const data = this.data
    const previousVersion = Number(data.version) || 1
    data.version = DATA_VERSION
    if (!Array.isArray(data.folders)) data.folders = []
    if (!Array.isArray(data.connections)) data.connections = []
    if (!data.settings || typeof data.settings !== 'object') data.settings = {}
    if (!data.knownHosts || typeof data.knownHosts !== 'object') data.knownHosts = {}
    if (previousVersion < 2 && data.settings.rightClick === 'paste') {
      data.settings.rightClick = 'contextMenu'
    }

    data.folders = data.folders
      .filter((folder) => folder && typeof folder === 'object')
      .map((folder, index) => ({
        id: typeof folder.id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(folder.id) ? folder.id : newId('folder'),
        name: cleanFolderName(folder.name),
        parentId: typeof folder.parentId === 'string' ? folder.parentId : null,
        expanded: folder.expanded !== false,
        order: Number.isFinite(folder.order) ? folder.order : index
      }))

    const folderIds = new Set(data.folders.map((folder) => folder.id))
    for (const folder of data.folders) {
      if (folder.parentId && !folderIds.has(folder.parentId)) folder.parentId = null
    }
    // Break accidental cycles so rendering can never recurse forever.
    for (const folder of data.folders) {
      const seen = new Set([folder.id])
      let parent = folder.parentId
      while (parent) {
        if (seen.has(parent)) {
          folder.parentId = null
          break
        }
        seen.add(parent)
        parent = data.folders.find((item) => item.id === parent)?.parentId ?? null
      }
    }

    const keptConnections = []
    for (const connection of data.connections) {
      if (!connection || typeof connection !== 'object') continue
      const id =
        typeof connection.id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(connection.id)
          ? connection.id
          : newId('conn')
      const authType = AUTH_TYPES.has(connection.authType) ? connection.authType : 'password'
      const protocol = connection.protocol === 'remoteDesktop' ? 'remoteDesktop' : 'ssh'
      const folderId = folderIds.has(connection.folderId) ? connection.folderId : null
      keptConnections.push({
        id,
        folderId,
        protocol,
        connectionMode: protocol === 'remoteDesktop' ? 'webrtc' : 'direct',
        relayUrl:
          protocol === 'remoteDesktop'
            ? cleanText(connection.relayUrl, 500) || DEFAULT_RELAY_URL
            : '',
        relayDeviceId: cleanText(connection.relayDeviceId, 32),
        name: cleanText(connection.name, 80) || cleanHost(connection.host) || '未命名连接',
        host: cleanHost(connection.host),
        port: clampInt(connection.port, 1, 65535, 22),
        username: cleanText(connection.username, 128) || (protocol === 'remoteDesktop' ? 'remote' : 'root'),
        authType,
        privateKeyPath: cleanText(connection.privateKeyPath, 500),
        description: cleanText(connection.description, 300),
        color: /^#[0-9a-fA-F]{6}$/.test(connection.color || '') ? connection.color : '#2f7fd8',
        terminalType: cleanText(connection.terminalType, 60) || 'xterm-256color',
        encoding: 'UTF-8',
        initCommand: cleanText(connection.initCommand, 500),
        hostKeyPolicy: HOST_KEY_POLICIES.has(connection.hostKeyPolicy)
          ? connection.hostKeyPolicy
          : 'accept-new',
        keepaliveInterval: clampInt(connection.keepaliveInterval, 0, 300, 15),
        remoteQuality: clampInt(connection.remoteQuality, 30, 85, 62),
        remoteRefreshMs: clampInt(connection.remoteRefreshMs, 50, 2000, 200),
        order: Number.isFinite(connection.order) ? connection.order : keptConnections.length,
        createdAt: Number.isFinite(connection.createdAt) ? connection.createdAt : now(),
        updatedAt: Number.isFinite(connection.updatedAt) ? connection.updatedAt : now(),
        lastConnectedAt: Number.isFinite(connection.lastConnectedAt) ? connection.lastConnectedAt : 0,
        importedFrom: cleanText(connection.importedFrom, 500)
      })
    }
    data.connections = keptConnections

    this.data.settings = this.normalizeSettings(data.settings)

    const knownHosts = {}
    for (const [key, value] of Object.entries(data.knownHosts)) {
      if (!value || typeof value !== 'object') continue
      if (typeof value.fingerprint !== 'string' || !value.fingerprint.startsWith('SHA256:')) continue
      knownHosts[cleanText(key, 320)] = {
        fingerprint: cleanText(value.fingerprint, 100),
        algorithm: cleanText(value.algorithm, 60),
        addedAt: Number.isFinite(value.addedAt) ? value.addedAt : now()
      }
    }
    data.knownHosts = knownHosts
  }

  normalizeSettings(input) {
    const source = input && typeof input === 'object' ? input : {}
    const merged = { ...DEFAULT_SETTINGS, ...source }
    return {
      theme: THEMES.has(merged.theme) ? merged.theme : DEFAULT_SETTINGS.theme,
      terminalTheme: TERMINAL_THEMES.has(merged.terminalTheme)
        ? merged.terminalTheme
        : DEFAULT_SETTINGS.terminalTheme,
      fontFamily: cleanText(source.fontFamily, 200),
      fontSize: clampInt(merged.fontSize, 9, 32, DEFAULT_SETTINGS.fontSize),
      lineHeight: Math.min(2.2, Math.max(1, Number(merged.lineHeight) || DEFAULT_SETTINGS.lineHeight)),
      letterSpacing: Math.min(4, Math.max(-2, Number(merged.letterSpacing) || 0)),
      cursorStyle: ['block', 'underline', 'bar'].includes(merged.cursorStyle)
        ? merged.cursorStyle
        : DEFAULT_SETTINGS.cursorStyle,
      cursorBlink: Boolean(merged.cursorBlink),
      scrollback: clampInt(merged.scrollback, 1000, 100000, DEFAULT_SETTINGS.scrollback),
      copyOnSelect: Boolean(merged.copyOnSelect),
      rightClick: RIGHT_CLICK.has(merged.rightClick) ? merged.rightClick : DEFAULT_SETTINGS.rightClick,
      confirmClose: Boolean(merged.confirmClose),
      autoReconnect: Boolean(merged.autoReconnect),
      autoReconnectAttempts: clampInt(merged.autoReconnectAttempts, 1, 10, 3),
      sidebarVisible: merged.sidebarVisible !== false,
      sidebarWidth: clampInt(merged.sidebarWidth, 200, 520, DEFAULT_SETTINGS.sidebarWidth),
      sftpWidth: clampInt(merged.sftpWidth, 320, 960, DEFAULT_SETTINGS.sftpWidth),
      hideSidebarScrollbar: merged.hideSidebarScrollbar !== false,
      showQuickCommands: merged.showQuickCommands !== false,
      terminalType: cleanText(merged.terminalType, 60) || 'xterm-256color',
      keepaliveInterval: clampInt(merged.keepaliveInterval, 0, 300, 15),
      hostKeyPolicy: HOST_KEY_POLICIES.has(merged.hostKeyPolicy)
        ? merged.hostKeyPolicy
        : DEFAULT_SETTINGS.hostKeyPolicy,
      showStatusBar: merged.showStatusBar !== false,
      bell: Boolean(merged.bell),
      remoteEnabled: true,
      relayEnabled: true,
      relayUrl: cleanText(merged.relayUrl, 500) || DEFAULT_RELAY_URL,
      relayToken: cleanText(merged.relayToken, 200) || DEFAULT_RELAY_TOKEN,
      relayDeviceId: cleanText(merged.relayDeviceId, 32) || newRelayDeviceId(),
      inspectionDiskThreshold: clampInt(
        merged.inspectionDiskThreshold,
        1,
        100,
        DEFAULT_SETTINGS.inspectionDiskThreshold
      )
    }
  }

  persist() {
    try {
      backupFile(this.dataFile)
      atomicWriteJson(this.dataFile, this.data)
      backupFile(this.secretsFile)
      atomicWriteJson(this.secretsFile, this.secrets)
    } catch (error) {
      this.logger?.error('failed to persist state', error)
      throw new Error(`无法保存本地数据：${error.message}`)
    }
  }

  publicState() {
    const connections = this.data.connections.map((connection) => {
      const secrets = this.secrets[connection.id] || {}
      return {
        ...connection,
        hasPassword: Boolean(secrets.password),
        hasPassphrase: Boolean(secrets.passphrase),
        encrypted: this.secretsEncrypted
      }
    })
    const knownHosts = Object.entries(this.data.knownHosts).map(([host, value]) => ({
      host,
      fingerprint: value.fingerprint,
      algorithm: value.algorithm,
      addedAt: value.addedAt
    }))
    return {
      version: this.data.version,
      folders: this.data.folders.map((folder) => ({ ...folder })),
      connections,
      settings: { ...this.data.settings },
      knownHosts,
      dataDir: this.directory,
      secretsEncrypted: this.secretsEncrypted
    }
  }

  getConnection(id) {
    return this.data.connections.find((connection) => connection.id === id) || null
  }

  getSecret(id, field) {
    if (!this.secretsEncrypted) return ''
    const encoded = this.secrets[id]?.[field]
    if (!encoded) return ''
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch (error) {
      this.logger?.warn('could not decrypt secret', { id, field, error: error.message })
      return ''
    }
  }

  setSecret(id, field, value) {
    if (!this.secretsEncrypted) {
      throw new Error('当前系统不支持安全凭据存储，无法记住密码')
    }
    if (!this.secrets[id]) this.secrets[id] = {}
    this.secrets[id][field] = safeStorage.encryptString(value).toString('base64')
  }

  deleteSecret(id, field) {
    if (!this.secrets[id]) return
    delete this.secrets[id][field]
    if (Object.keys(this.secrets[id]).length === 0) delete this.secrets[id]
  }

  saveConnection(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('连接数据无效')
    const requestedId =
      typeof payload.id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(payload.id) ? payload.id : ''
    const existing = requestedId ? this.getConnection(requestedId) : null
    const id = existing?.id || requestedId || newId('conn')
    const folderExists =
      payload.folderId && this.data.folders.some((folder) => folder.id === payload.folderId)
    const authType = AUTH_TYPES.has(payload.authType) ? payload.authType : 'password'
    const protocol =
      payload.protocol === 'remoteDesktop' || existing?.protocol === 'remoteDesktop'
        ? 'remoteDesktop'
        : 'ssh'
    const connectionMode = protocol === 'remoteDesktop' ? 'webrtc' : 'direct'
    const record = {
      id,
      folderId: folderExists ? payload.folderId : null,
      protocol,
      connectionMode,
      relayUrl:
        protocol === 'remoteDesktop'
          ? cleanText(payload.relayUrl, 500) || DEFAULT_RELAY_URL
          : '',
      relayDeviceId: protocol === 'remoteDesktop' ? cleanText(payload.relayDeviceId, 32) : '',
      name: cleanText(payload.name, 80) || cleanHost(payload.host) || '未命名连接',
      host: cleanHost(payload.host),
      port: clampInt(payload.port, 1, 65535, 22),
      username:
        cleanText(payload.username, 128) || (protocol === 'remoteDesktop' ? 'remote' : ''),
      authType,
      privateKeyPath: cleanText(payload.privateKeyPath, 500),
      description: cleanText(payload.description, 300),
      color: /^#[0-9a-fA-F]{6}$/.test(payload.color || '') ? payload.color : '#2f7fd8',
      terminalType: cleanText(payload.terminalType, 60) || 'xterm-256color',
      encoding: 'UTF-8',
      initCommand: cleanText(payload.initCommand, 500),
      hostKeyPolicy: HOST_KEY_POLICIES.has(payload.hostKeyPolicy)
        ? payload.hostKeyPolicy
        : 'accept-new',
      keepaliveInterval: clampInt(payload.keepaliveInterval, 0, 300, 15),
      remoteQuality: clampInt(payload.remoteQuality, 30, 85, 62),
      remoteRefreshMs: clampInt(payload.remoteRefreshMs, 50, 2000, 200),
      order: existing?.order ?? this.nextConnectionOrder(),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      lastConnectedAt: existing?.lastConnectedAt ?? 0,
      importedFrom: existing?.importedFrom ?? cleanText(payload.importedFrom, 500)
    }
    if (!record.host && connectionMode !== 'webrtc') throw new Error('主机地址不能为空')
    if (!record.username) throw new Error('用户名不能为空')

    if (typeof payload.password === 'string' && payload.password.length > 0) {
      if (payload.rememberPassword !== false) this.setSecret(id, 'password', payload.password)
    } else if (payload.clearPassword) {
      this.deleteSecret(id, 'password')
    }
    if (typeof payload.passphrase === 'string' && payload.passphrase.length > 0) {
      if (payload.rememberPassphrase !== false) this.setSecret(id, 'passphrase', payload.passphrase)
    } else if (payload.clearPassphrase) {
      this.deleteSecret(id, 'passphrase')
    }

    if (existing) {
      Object.assign(existing, record)
    } else {
      this.data.connections.push(record)
    }
    this.persist()
    return this.publicState()
  }

  nextConnectionOrder() {
    return this.data.connections.reduce((max, item) => Math.max(max, item.order || 0), 0) + 1
  }

  deleteConnection(id) {
    const index = this.data.connections.findIndex((connection) => connection.id === id)
    if (index === -1) return this.publicState()
    this.data.connections.splice(index, 1)
    delete this.secrets[id]
    this.persist()
    return this.publicState()
  }

  saveFolder(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('分组数据无效')
    const existing = payload.id
      ? this.data.folders.find((folder) => folder.id === payload.id)
      : null
    let parentId = payload.parentId || null
    if (parentId && !this.data.folders.some((folder) => folder.id === parentId)) parentId = null
    if (existing && parentId === existing.id) parentId = existing.parentId
    if (existing) {
      existing.name = cleanFolderName(payload.name)
      existing.parentId = parentId
      if (typeof payload.expanded === 'boolean') existing.expanded = payload.expanded
      if (Number.isFinite(payload.order)) existing.order = payload.order
    } else {
      this.data.folders.push({
        id: newId('folder'),
        name: cleanFolderName(payload.name),
        parentId,
        expanded: payload.expanded !== false,
        order: this.data.folders.length
      })
    }
    this.persist()
    return this.publicState()
  }

  moveItems(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('移动数据无效')
    const byId = new Map(this.data.folders.map((folder) => [folder.id, folder]))
    const requestedTarget =
      typeof payload.targetFolderId === 'string' && payload.targetFolderId
        ? payload.targetFolderId
        : null
    if (requestedTarget && !byId.has(requestedTarget)) throw new Error('目标分组不存在')

    const anchorConnectionId =
      typeof payload.anchorConnectionId === 'string' && payload.anchorConnectionId
        ? payload.anchorConnectionId
        : null
    const anchorPosition = payload.anchorPosition === 'after' ? 'after' : 'before'
    const anchorConnection = anchorConnectionId
      ? this.data.connections.find((connection) => connection.id === anchorConnectionId) || null
      : null
    if (anchorConnectionId && !anchorConnection) throw new Error('排序位置不存在')
    const anchorFolderId =
      typeof payload.anchorFolderId === 'string' && payload.anchorFolderId
        ? payload.anchorFolderId
        : null
    const anchorFolderPosition =
      payload.anchorFolderPosition === 'after' ? 'after' : 'before'
    const anchorFolder = anchorFolderId ? byId.get(anchorFolderId) || null : null
    if (anchorFolderId && !anchorFolder) throw new Error('目标分组不存在')
    if (anchorFolderId && anchorConnectionId) throw new Error('排序目标无效')
    const targetFolderId = anchorFolder
      ? anchorFolder.parentId || null
      : anchorConnection
        ? anchorConnection.folderId || null
        : requestedTarget
    if (targetFolderId && !byId.has(targetFolderId)) throw new Error('目标分组不存在')

    const folderIds = new Set(
      (Array.isArray(payload.folderIds) ? payload.folderIds : []).filter(
        (id) => typeof id === 'string'
      )
    )
    const connectionIds = new Set(
      (Array.isArray(payload.connectionIds) ? payload.connectionIds : []).filter(
        (id) => typeof id === 'string'
      )
    )
    if (anchorConnection && connectionIds.has(anchorConnection.id)) {
      throw new Error('不能以正在移动的连接作为排序位置')
    }
    if (anchorFolder && folderIds.has(anchorFolder.id)) {
      throw new Error('不能以正在移动的分组作为排序位置')
    }
    const selectedFolders = this.data.folders.filter((folder) => folderIds.has(folder.id))
    const selectedConnections = this.data.connections.filter((connection) =>
      connectionIds.has(connection.id)
    )

    // Moving a parent already moves its selected descendants; keep only roots.
    const hasSelectedAncestor = (folder) => {
      const guard = new Set()
      let current = folder.parentId
      while (current && !guard.has(current)) {
        guard.add(current)
        if (folderIds.has(current)) return true
        current = byId.get(current)?.parentId ?? null
      }
      return false
    }
    const movingFolders = selectedFolders
      .filter((folder) => !hasSelectedAncestor(folder))
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'zh-CN'))

    // A folder cannot be moved into itself or one of its descendants.
    if (targetFolderId) {
      for (const folder of movingFolders) {
        const guard = new Set()
        let current = byId.get(targetFolderId)
        while (current && !guard.has(current.id)) {
          if (current.id === folder.id) {
            throw new Error(`不能将分组“${folder.name}”移动到其自身或子分组中`)
          }
          guard.add(current.id)
          current = current.parentId ? byId.get(current.parentId) : null
        }
      }
    }

    const movingFolderIds = new Set(movingFolders.map((folder) => folder.id))
    const isInsideMovingFolder = (folderId) => {
      const guard = new Set()
      let current = folderId
      while (current && !guard.has(current)) {
        guard.add(current)
        if (movingFolderIds.has(current)) return true
        current = byId.get(current)?.parentId ?? null
      }
      return false
    }

    const changedFolders = movingFolders.filter(
      (folder) => Boolean(anchorFolder) || (folder.parentId || null) !== targetFolderId
    )
    const changedConnections = selectedConnections
      .filter(
        (connection) =>
          !isInsideMovingFolder(connection.folderId) &&
          (Boolean(anchorConnection) || (connection.folderId || null) !== targetFolderId)
      )
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'zh-CN'))
    if (changedFolders.length === 0 && changedConnections.length === 0) {
      return this.publicState()
    }

    if (targetFolderId) byId.get(targetFolderId).expanded = true
    if (changedFolders.length > 0) {
      const movingFolderIds = new Set(changedFolders.map((folder) => folder.id))
      const siblingFolders = this.data.folders
        .filter(
          (folder) =>
            (folder.parentId || null) === targetFolderId && !movingFolderIds.has(folder.id)
        )
        .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'zh-CN'))
      let insertAt = siblingFolders.length
      if (anchorFolder) {
        const anchorIndex = siblingFolders.findIndex((folder) => folder.id === anchorFolder.id)
        if (anchorIndex !== -1) {
          insertAt = anchorFolderPosition === 'before' ? anchorIndex : anchorIndex + 1
        }
      }
      const orderedFolders = [
        ...siblingFolders.slice(0, insertAt),
        ...changedFolders,
        ...siblingFolders.slice(insertAt)
      ]
      orderedFolders.forEach((folder, index) => {
        folder.order = index
      })
      for (const folder of changedFolders) {
        folder.parentId = targetFolderId
      }
    }

    if (changedConnections.length > 0) {
      const movingConnectionIds = new Set(changedConnections.map((connection) => connection.id))
      const siblings = this.data.connections
        .filter(
          (connection) =>
            (connection.folderId || null) === targetFolderId &&
            !movingConnectionIds.has(connection.id)
        )
        .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'zh-CN'))
      let insertAt = siblings.length
      if (anchorConnection) {
        const anchorIndex = siblings.findIndex(
          (connection) => connection.id === anchorConnection.id
        )
        if (anchorIndex !== -1) insertAt = anchorPosition === 'before' ? anchorIndex : anchorIndex + 1
      }
      const ordered = [
        ...siblings.slice(0, insertAt),
        ...changedConnections,
        ...siblings.slice(insertAt)
      ]
      ordered.forEach((connection, index) => {
        connection.order = index
      })
      for (const connection of changedConnections) {
        connection.folderId = targetFolderId
        connection.updatedAt = now()
      }
    }

    this.persist()
    return this.publicState()
  }

  deleteFolder(id) {
    const folder = this.data.folders.find((item) => item.id === id)
    if (!folder) return this.publicState()
    const toDelete = new Set([id])
    let changed = true
    while (changed) {
      changed = false
      for (const item of this.data.folders) {
        if (item.parentId && toDelete.has(item.parentId) && !toDelete.has(item.id)) {
          toDelete.add(item.id)
          changed = true
        }
      }
    }
    const removedConnections = this.data.connections.filter((connection) =>
      toDelete.has(connection.folderId)
    )
    for (const connection of removedConnections) delete this.secrets[connection.id]
    this.data.connections = this.data.connections.filter(
      (connection) => !toDelete.has(connection.folderId)
    )
    this.data.folders = this.data.folders.filter((item) => !toDelete.has(item.id))
    this.persist()
    return this.publicState()
  }

  saveSettings(patch) {
    if (!patch || typeof patch !== 'object') return this.publicState()
    this.data.settings = this.normalizeSettings({ ...this.data.settings, ...patch })
    this.persist()
    return this.publicState()
  }

  touchConnection(id) {
    const connection = this.getConnection(id)
    if (!connection) return
    connection.lastConnectedAt = now()
    try {
      this.persist()
    } catch (error) {
      this.logger?.warn('could not persist lastConnectedAt', error)
    }
  }

  checkKnownHost(hostKey) {
    return this.data.knownHosts[hostKey] || null
  }

  addKnownHost(hostKey, fingerprint, algorithm) {
    this.data.knownHosts[hostKey] = { fingerprint, algorithm, addedAt: now() }
    try {
      this.persist()
    } catch (error) {
      this.logger?.warn('could not persist known host', error)
    }
  }

  deleteKnownHost(hostKey) {
    delete this.data.knownHosts[hostKey]
    this.persist()
    return this.publicState()
  }

  clearKnownHosts() {
    this.data.knownHosts = {}
    this.persist()
    return this.publicState()
  }

  mergeImport(result) {
    const folderMap = new Map()
    for (const folder of this.data.folders) {
      folderMap.set(`${folder.parentId || ''}\u0000${folder.name.toLowerCase()}`, folder.id)
    }
    const ensureFolder = (parentId, name) => {
      const key = `${parentId || ''}\u0000${name.toLowerCase()}`
      if (folderMap.has(key)) return folderMap.get(key)
      const folder = {
        id: newId('folder'),
        name: cleanFolderName(name),
        parentId,
        expanded: true,
        order: this.data.folders.length
      }
      this.data.folders.push(folder)
      folderMap.set(key, folder.id)
      return folder.id
    }

    const connectionByKey = new Map(
      this.data.connections.map((connection) => [
        `${connection.host.toLowerCase()}:${connection.port}:${connection.username.toLowerCase()}`,
        connection
      ])
    )
    const existing = new Set(connectionByKey.keys())
    let imported = 0
    let skipped = 0
    let passwordsImported = 0
    let passphrasesImported = 0
    for (const item of result.connections) {
      const key = `${item.host.toLowerCase()}:${item.port}:${item.username.toLowerCase()}`
      if (existing.has(key)) {
        const target = connectionByKey.get(key)
        if (target && this.secretsEncrypted) {
          if (item.password && !this.secrets[target.id]?.password) {
            try {
              this.setSecret(target.id, 'password', item.password)
              passwordsImported += 1
            } catch (error) {
              this.logger?.warn('could not import connection password', error.message)
            }
          }
          if (item.passphrase && !this.secrets[target.id]?.passphrase) {
            try {
              this.setSecret(target.id, 'passphrase', item.passphrase)
              passphrasesImported += 1
            } catch (error) {
              this.logger?.warn('could not import connection passphrase', error.message)
            }
          }
        }
        skipped += 1
        continue
      }
      let parentId = null
      for (const segment of item.folderPath) parentId = ensureFolder(parentId, segment)
      const record = {
        id: newId('conn'),
        folderId: parentId,
        name: cleanText(item.name, 80) || `${item.username}@${item.host}`,
        host: cleanHost(item.host),
        port: clampInt(item.port, 1, 65535, 22),
        username: cleanText(item.username, 128) || 'root',
        authType: 'password',
        privateKeyPath: '',
        description: cleanText(item.description, 300) || '从配置导入',
        color: item.color || '#2f7fd8',
        terminalType: cleanText(item.terminalType, 60) || 'xterm-256color',
        encoding: 'UTF-8',
        initCommand: '',
        hostKeyPolicy: 'accept-new',
        keepaliveInterval: 15,
        order: this.data.connections.length,
        createdAt: now(),
        updatedAt: now(),
        lastConnectedAt: 0,
        importedFrom: cleanText(item.source, 500)
      }
      this.data.connections.push(record)
      if (item.password && this.secretsEncrypted) {
        try {
          this.setSecret(record.id, 'password', item.password)
          passwordsImported += 1
        } catch (error) {
          this.logger?.warn('could not import connection password', error.message)
        }
      }
      if (item.passphrase && this.secretsEncrypted) {
        try {
          this.setSecret(record.id, 'passphrase', item.passphrase)
          passphrasesImported += 1
        } catch (error) {
          this.logger?.warn('could not import connection passphrase', error.message)
        }
      }
      existing.add(key)
      connectionByKey.set(key, record)
      imported += 1
    }
    this.persist()
    return {
      state: this.publicState(),
      imported,
      skipped,
      folders: result.folders.length,
      passwordsImported,
      passphrasesImported
    }
  }
}

module.exports = { Store, DEFAULT_SETTINGS, newId }
