'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const MAX_SEGMENT = 70

/**
 * Export HongSSH connections into a portable configuration directory:
 * nested folders containing `<session>_connect_config.json` files.
 *
 * The extra `hongssh_password` / `hongssh_passphrase` fields make the export a
 * complete HongSSH backup. They are plain text, so the export directory must
 * be kept private. The standard Xshell `password` field stays empty because
 * Xshell's own passwords are machine-bound and cannot be produced here.
 */
function exportXshellSessions(state, destination) {
  if (!state || typeof state !== 'object') throw new Error('连接数据无效')
  if (typeof destination !== 'string' || !destination) throw new Error('导出目录无效')
  const connections = Array.isArray(state.connections) ? state.connections : []
  const folders = Array.isArray(state.folders) ? state.folders : []
  const root = path.resolve(destination)
  fs.mkdirSync(root, { recursive: true })

  const folderById = new Map(
    folders
      .filter((folder) => folder && typeof folder.id === 'string')
      .map((folder) => [folder.id, folder])
  )
  const folderPathCache = new Map()
  const folderPaths = (folderId) => {
    if (!folderId) return []
    if (folderPathCache.has(folderId)) return folderPathCache.get(folderId)
    const segments = []
    const seen = new Set()
    let current = folderById.get(folderId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      segments.unshift(sanitizeSegment(current.name, 'folder'))
      current = current.parentId ? folderById.get(current.parentId) : null
    }
    folderPathCache.set(folderId, segments)
    return segments
  }

  const folderIdByPath = new Map()
  const folderIdFor = (segments) => {
    if (segments.length === 0) return '0'
    const key = segments.join('\u0000')
    let id = folderIdByPath.get(key)
    if (!id) {
      id = randomId()
      folderIdByPath.set(key, id)
    }
    return id
  }

  const directories = new Set()
  const usedNames = new Map()
  const usedIds = new Set()
  let files = 0
  let passwords = 0
  let passphrases = 0

  for (const connection of connections) {
    if (!connection || typeof connection !== 'object') continue
    if (connection.protocol === 'remoteDesktop') continue
    const segments = folderPaths(connection.folderId)
    const directory = path.join(root, ...segments)
    fs.mkdirSync(directory, { recursive: true })
    directories.add(directory)
    const parentId = folderIdFor(segments)
    const host = String(connection.host || '').trim()
    if (!host) continue
    const username = String(connection.username || 'root').trim() || 'root'
    const name = cleanText(connection.name) || `${username}@${host}`
    const base = uniqueBaseName(directory, sanitizeSegment(name, 'session'), usedNames)
    const fileName = `${base}_connect_config.json`
    const now = Date.now()
    let id = randomId()
    while (usedIds.has(id)) id = randomId()
    usedIds.add(id)
    const payload = {
      forwarding_auto_reconnect: false,
      custom_size: false,
      delete_time: 0,
      secret_key_id: '',
      user_name: username,
      remote_port_forwarding: {},
      conection_type: 100,
      sort_time: 0,
      description: cleanText(connection.description),
      proxy_id: '0',
      authentication_type:
        connection.authType === 'privateKey' ? 2 : connection.authType === 'agent' ? 4 : 1,
      drivestoredirect: true,
      delete_key_sequence: 0,
      password: '',
      hongssh_export_version: 1,
      hongssh_password: String(connection.password || ''),
      hongssh_passphrase: String(connection.passphrase || ''),
      modified_time: timestamp(connection.updatedAt, now),
      host,
      accelerate: false,
      id,
      height: 0,
      order: Number.isFinite(Number(connection.order)) ? Number(connection.order) : 0,
      create_time: timestamp(connection.createdAt, now),
      port_forwarding_list: [],
      parent_update_time: 0,
      rename_time: timestamp(connection.updatedAt, 0),
      backspace_key_sequence: 2,
      fullscreen: false,
      port: validPort(connection.port),
      terminal_encoding: cleanText(connection.encoding) || 'UTF-8',
      parent_id: parentId,
      terminal_type: cleanText(connection.terminalType) || 'xterm-256color',
      exec_channel_enable: true,
      width: 0,
      name,
      access_time: timestamp(connection.lastConnectedAt, now)
    }
    fs.writeFileSync(path.join(directory, fileName), JSON.stringify(payload), 'utf8')
    files += 1
    if (payload.hongssh_password) passwords += 1
    if (payload.hongssh_passphrase) passphrases += 1
  }

  return {
    directory: root,
    files,
    folders: directories.size,
    connections: files,
    passwords,
    passphrases
  }
}

function randomId() {
  const bytes = crypto.randomBytes(16)
  let value = ''
  for (let i = 0; i < 16; i += 1) value += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  return value
}

function sanitizeSegment(value, fallback) {
  let name = cleanText(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, MAX_SEGMENT)
  if (!name || name === '.' || name === '..') name = fallback
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`
  return name
}

function uniqueBaseName(directory, base, usedNames) {
  const key = directory.toLowerCase()
  const used = usedNames.get(key) || new Set()
  let candidate = base
  let index = 2
  while (used.has(candidate.toLowerCase()) || fs.existsSync(path.join(directory, `${candidate}_connect_config.json`))) {
    candidate = `${base}-${index}`
    index += 1
  }
  used.add(candidate.toLowerCase())
  usedNames.set(key, used)
  return candidate
}

function cleanText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .normalize('NFC')
    .trim()
    .slice(0, 200)
}

function timestamp(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

function validPort(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : 22
}

module.exports = { exportXshellSessions }
