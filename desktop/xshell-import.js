'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const GROUP_COLORS = ['#2f7fd8', '#0f9d8a', '#c26a1b', '#7d5bd6', '#bf3f6b', '#4b8b3b', '#a0522d']

/**
 * Scan a HongSSH configuration directory (or an extracted Xshell sessions
 * folder) and convert the JSON session files into HongSSH connections.
 * HongSSH exports carry portable password fields; Xshell's own saved password
 * is machine-bound and cannot be decrypted here.
 */
function scanXshellFolder(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory)
  const stat = fs.statSync(root)
  if (!stat.isDirectory()) throw new Error('请选择配置文件夹')
  const maxFiles = options.maxFiles ?? 5000
  const maxDepth = options.maxDepth ?? 10

  const files = []
  const walk = (directory, depth) => {
    if (depth > maxDepth || files.length >= maxFiles) return
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
      } else if (entry.isFile() && /\.json$/i.test(entry.name)) {
        const size = safeStatSize(fullPath)
        if (size > 0 && size < 512 * 1024) files.push(fullPath)
      }
    }
  }
  walk(root, 0)

  const connections = []
  const folderSet = new Set()
  const errors = []
  for (const file of files) {
    const parsed = parseSessionFile(file)
    if (!parsed) continue
    const relative = path.relative(root, file)
    const segments = path.dirname(relative) === '.' ? [] : path.dirname(relative).split(path.sep)
    const folderPath = segments
      .map((segment) => sanitizeSegment(segment))
      .filter(Boolean)
    for (let index = 0; index < folderPath.length; index += 1) {
      folderSet.add(folderPath.slice(0, index + 1).join('/'))
    }
    const name = cleanName(parsed.name) || `${parsed.username}@${parsed.host}`
    connections.push({
      name,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      description: cleanName(parsed.description),
      terminalType: parsed.terminalType || 'xterm-256color',
      folderPath,
      source: file,
      color: colorFor(folderPath[0] || name),
      password: parsed.portablePassword,
      passphrase: parsed.portablePassphrase,
      hasXshellPassword: Boolean(parsed.password)
    })
  }

  // De-duplicate repeated export folders (same host/user/port) in a stable way.
  const seen = new Set()
  const unique = []
  for (const connection of connections.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    const key = `${connection.host.toLowerCase()}:${connection.port}:${connection.username.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(connection)
  }

  return {
    root,
    folders: [...folderSet],
    connections: unique,
    summary: {
      files: files.length,
      sessions: connections.length,
      unique: unique.length,
      duplicates: connections.length - unique.length,
      folders: folderSet.size,
      withPassword: unique.filter((item) => item.password || item.hasXshellPassword).length,
      portablePasswords: unique.filter((item) => item.password).length,
      xshellPasswords: unique.filter((item) => item.hasXshellPassword).length,
      errors
    }
  }
}

function parseSessionFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object') return null
    const host = String(data.host || data.hostname || '').trim()
    if (!host) return null
    const username = String(data.user_name || data.username || data.user || '').trim() || 'root'
    const portNumber = Number(data.port)
    const port = Number.isFinite(portNumber) && portNumber > 0 && portNumber < 65536 ? portNumber : 22
    if (!/\.json$/i.test(file)) return null
    // Only accept objects that look like Xshell session configs, not random JSON.
    if (!('host' in data) || !('user_name' in data || 'username' in data)) return null
    return {
      name: String(data.name || ''),
      host,
      port,
      username,
      password: String(data.password || ''),
      portablePassword: String(data.hongssh_password || ''),
      portablePassphrase: String(data.hongssh_passphrase || ''),
      description: String(data.description || ''),
      terminalType: String(data.terminal_type || data.terminalType || '') || 'xterm-256color'
    }
  } catch (error) {
    return null
  }
}

function sanitizeSegment(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 80)
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .normalize('NFC')
    .trim()
    .slice(0, 200)
}

function safeStatSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function colorFor(value) {
  const hash = crypto.createHash('sha1').update(value).digest()[0]
  return GROUP_COLORS[hash % GROUP_COLORS.length]
}

module.exports = { scanXshellFolder }
