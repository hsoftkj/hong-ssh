'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')

const SFTP_NO_SUCH_FILE = 2
const MAX_FILES_PER_REQUEST = 2000
const MAX_RECURSION_DEPTH = 64
const PROGRESS_INTERVAL_MS = 90
const PARTIAL_SUFFIX = '.hongssh.part'
const DOWNLOAD_CONCURRENCY = 32
const DOWNLOAD_CHUNK_SIZE = 64 * 1024

function posixJoin(base, name) {
  if (!base || base === '/') return `/${name}`
  return path.posix.join(base, name)
}

function remoteBaseName(remotePath) {
  return path.posix.basename(remotePath)
}

function validateRemotePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('远端路径不能为空')
  if (value.length > 4096) throw new Error('远端路径过长')
  return path.posix.normalize(value.replace(/\\/g, '/'))
}

function attrsIsDirectory(attrs) {
  return Boolean(attrs && typeof attrs.isDirectory === 'function' && attrs.isDirectory())
}

function attrsIsSymbolicLink(attrs) {
  return Boolean(attrs && typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink())
}

function isNoSuchFileError(error) {
  return Boolean(
    error &&
      (error.code === SFTP_NO_SUCH_FILE ||
        error.code === 'ENOENT' ||
        /no such file/i.test(String(error.message || '')))
  )
}

function transferId() {
  return crypto.randomUUID()
}

function safeLocalName(value) {
  const name = remoteBaseName(value)
  if (!name || name === '.' || name === '..') throw new Error('远端文件名无效')
  if (process.platform === 'win32' && /[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new Error(`文件名“${name}”包含 Windows 不支持的字符`)
  }
  return name
}
/**
 * SFTP file browser and transfer service. It reuses the SSH Client that already
 * owns the interactive shell, so file transfers share authentication, host key
 * verification, keepalive and connection lifetime with the terminal session.
 */
class SftpService {
  constructor({ getSession, send, logger }) {
    this.getSession = getSession
    this.send = send
    this.logger = logger
    this.transfers = new Map()
    this.sessionQueues = new Map()
  }

  requireSession(sessionId) {
    const session = this.getSession(sessionId)
    if (!session) throw new Error('会话不存在或已关闭')
    if (session.status !== 'connected' || !session.client) {
      throw new Error('当前会话未连接，无法使用文件传输')
    }
    return session
  }

  async getChannel(session) {
    if (session.sftpChannel) return session.sftpChannel
    if (!session.client) throw new Error('SSH 连接已关闭')
    const channel = await new Promise((resolve, reject) => {
      try {
        session.client.sftp((error, sftp) => {
          if (error) reject(error)
          else resolve(sftp)
        })
      } catch (error) {
        reject(error)
      }
    })
    if (session.sftpChannel) return session.sftpChannel
    session.sftpChannel = channel
    channel.on('error', (error) => {
      this.logger?.warn('sftp channel error', { sessionId: session.id, message: error.message })
    })
    channel.on('close', () => {
      if (session.sftpChannel === channel) session.sftpChannel = null
    })
    return channel
  }

  async realpath(session, remotePath) {
    const channel = await this.getChannel(session)
    const input = validateRemotePath(remotePath || '.')
    return new Promise((resolve, reject) => {
      channel.realpath(input, (error, resolved) => {
        if (error) reject(error)
        else resolve(resolved)
      })
    })
  }

  async list(sessionId, remotePath) {
    const session = this.requireSession(String(sessionId))
    const channel = await this.getChannel(session)
    const target = await this.realpath(session, remotePath || '.')
    const entries = await new Promise((resolve, reject) => {
      channel.readdir(target, (error, list) => {
        if (error) reject(error)
        else resolve(list || [])
      })
    })
    const mapped = []
    for (const entry of entries) {
      const name = String(entry.filename || '')
      if (!name || name === '.' || name === '..') continue
      if (name.endsWith(PARTIAL_SUFFIX)) continue
      const attrs = entry.attrs || {}
      const directory = attrsIsDirectory(attrs)
      const symlink = attrsIsSymbolicLink(attrs)
      mapped.push({
        name,
        path: posixJoin(target, name),
        type: directory ? 'directory' : symlink ? 'symlink' : 'file',
        size: Number(attrs.size) || 0,
        mtime: Number(attrs.mtime) ? Number(attrs.mtime) * 1000 : 0,
        mode: Number(attrs.mode) || 0,
        permissions: Number(attrs.mode) ? (Number(attrs.mode) & 0o777).toString(8).padStart(3, '0') : ''
      })
    }
    mapped.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (b.type === 'directory' && a.type !== 'directory') return 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return {
      path: target,
      home: session.homePath || '',
      entries: mapped
    }
  }

  async home(sessionId) {
    const session = this.requireSession(String(sessionId))
    const home = await this.realpath(session, '.')
    session.homePath = home
    return home
  }

  async mkdir(sessionId, remotePath) {
    const session = this.requireSession(String(sessionId))
    const channel = await this.getChannel(session)
    const target = validateRemotePath(remotePath)
    await new Promise((resolve, reject) => {
      channel.mkdir(target, (error) => (error ? reject(error) : resolve()))
    })
    return target
  }

  async rename(sessionId, from, to) {
    const session = this.requireSession(String(sessionId))
    const channel = await this.getChannel(session)
    const source = validateRemotePath(from)
    const target = validateRemotePath(to)
    await new Promise((resolve, reject) => {
      channel.rename(source, target, (error) => (error ? reject(error) : resolve()))
    })
    return target
  }

  async remove(sessionId, remotePath, recursive = false) {
    const session = this.requireSession(String(sessionId))
    const channel = await this.getChannel(session)
    const target = validateRemotePath(remotePath)
    const attrs = await this.lstat(channel, target)
    if (!attrs) throw new Error('文件或目录不存在')
    if (attrsIsSymbolicLink(attrs)) {
      await this.unlinkRemote(channel, target)
    } else if (attrsIsDirectory(attrs)) {
      if (recursive) {
        await this.removeDirectoryRecursive(channel, target, 0)
      } else {
        try {
          await new Promise((resolve, reject) => {
            channel.rmdir(target, (error) => (error ? reject(error) : resolve()))
          })
        } catch {
          throw new Error(`文件夹“${remoteBaseName(target)}”非空或无法删除，请使用递归删除`)
        }
      }
    } else {
      await this.unlinkRemote(channel, target)
    }
    return target
  }

  async removeDirectoryRecursive(channel, remotePath, depth) {
    if (depth > MAX_RECURSION_DEPTH) throw new Error(`目录层级过深，已中止删除：${remotePath}`)
    const entries = await new Promise((resolve, reject) => {
      channel.readdir(remotePath, (error, list) => (error ? reject(error) : resolve(list || [])))
    })
    for (const entry of entries) {
      const name = String(entry.filename || '')
      if (!name || name === '.' || name === '..') continue
      const child = posixJoin(remotePath, name)
      const attrs = entry.attrs || {}
      try {
        if (attrsIsDirectory(attrs) && !attrsIsSymbolicLink(attrs)) {
          await this.removeDirectoryRecursive(channel, child, depth + 1)
        } else {
          await this.unlinkRemote(channel, child)
        }
      } catch (error) {
        throw new Error(`无法删除 ${child}：${error.message || error}`)
      }
    }
    try {
      await new Promise((resolve, reject) => {
        channel.rmdir(remotePath, (error) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      throw new Error(`无法删除目录 ${remotePath}：${error.message || error}`)
    }
  }

  unlinkRemote(channel, remotePath) {
    return new Promise((resolve, reject) => {
      channel.unlink(remotePath, (error) => (error ? reject(error) : resolve()))
    })
  }

  stat(channel, remotePath) {
    return new Promise((resolve, reject) => {
      channel.stat(remotePath, (error, attrs) => {
        if (error) {
          if (isNoSuchFileError(error)) resolve(null)
          else reject(error)
        } else {
          resolve(attrs)
        }
      })
    })
  }

  lstat(channel, remotePath) {
    return new Promise((resolve, reject) => {
      channel.lstat(remotePath, (error, attrs) => {
        if (error) {
          if (isNoSuchFileError(error)) resolve(null)
          else reject(error)
        } else {
          resolve(attrs)
        }
      })
    })
  }

  async ensureRemoteDirectories(channel, directories) {
    const cache = new Set()
    const sorted = [...directories].sort((a, b) => a.length - b.length)
    for (const directory of sorted) {
      await this.ensureRemoteDir(channel, directory, cache)
    }
  }

  async ensureRemoteDir(channel, directory, cache) {
    const normalized = path.posix.normalize(directory)
    const parts = normalized.split('/').filter(Boolean)
    let current = normalized.startsWith('/') ? '/' : ''
    for (const part of parts) {
      current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part
      if (cache.has(current)) continue
      const attrs = await this.stat(channel, current)
      if (attrs) {
        if (!attrsIsDirectory(attrs)) throw new Error(`远端路径不是目录：${current}`)
      } else {
        await new Promise((resolve, reject) => {
          channel.mkdir(current, (error) => (error ? reject(error) : resolve()))
        })
      }
      cache.add(current)
    }
  }


  async upload(sessionId, localPaths, remoteDir, overwrite = false) {
    const session = this.requireSession(String(sessionId))
    if (!Array.isArray(localPaths) || localPaths.length === 0) throw new Error('请选择要上传的文件或文件夹')
    if (localPaths.length > MAX_FILES_PER_REQUEST) throw new Error('一次选择的项目过多')
    const channel = await this.getChannel(session)
    const targetDir = await this.realpath(session, remoteDir || '.')
    const records = []
    const conflicts = []
    const directories = new Set()
    const remoteTargets = new Set()

    const addDirectory = (remotePath) => {
      directories.add(validateRemotePath(remotePath))
    }

    const addFileRecord = async (localPath, remotePath, relativePath, total) => {
      if (records.length >= MAX_FILES_PER_REQUEST) {
        throw new Error(`一次最多传输 ${MAX_FILES_PER_REQUEST} 个文件`)
      }
      if (remoteTargets.has(remotePath)) {
        throw new Error(`目标路径重复：${relativePath}`)
      }
      remoteTargets.add(remotePath)
      const existing = await this.stat(channel, remotePath)
      if (existing && attrsIsDirectory(existing)) {
        throw new Error(`远端已存在同名目录：${relativePath}`)
      }
      const targetExists = Boolean(existing)
      if (targetExists && !overwrite) conflicts.push(relativePath)
      records.push({
        id: transferId(),
        sessionId: session.id,
        direction: 'upload',
        name: relativePath,
        localPath,
        remotePath,
        partialPath: `${remotePath}${PARTIAL_SUFFIX}`,
        total,
        transferred: 0,
        resumeOffset: 0,
        resumed: false,
        targetExists,
        status: 'queued',
        cancelled: false
      })
    }

    const walkLocal = async (localDirectory, remoteDirectory, relativeBase, depth) => {
      if (depth > MAX_RECURSION_DEPTH) throw new Error(`文件夹层级过深：${localDirectory}`)
      let entries
      try {
        entries = fs.readdirSync(localDirectory, { withFileTypes: true })
      } catch (error) {
        throw new Error(`无法读取本地文件夹 ${localDirectory}：${error.message}`)
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const childLocal = path.join(localDirectory, entry.name)
        const childRemote = posixJoin(remoteDirectory, entry.name)
        const childRelative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          addDirectory(childRemote)
          await walkLocal(childLocal, childRemote, childRelative, depth + 1)
        } else if (entry.isFile()) {
          let stat
          try {
            stat = fs.statSync(childLocal)
          } catch {
            throw new Error(`无法读取本地文件：${childLocal}`)
          }
          await addFileRecord(childLocal, childRemote, childRelative, stat.size)
        }
      }
    }

    for (const localPath of localPaths) {
      if (typeof localPath !== 'string' || !localPath) throw new Error('本地路径无效')
      let lstat
      try {
        lstat = fs.lstatSync(localPath)
      } catch {
        throw new Error(`无法读取本地路径：${localPath}`)
      }
      if (lstat.isSymbolicLink()) throw new Error(`暂不支持上传符号链接：${path.basename(localPath)}`)
      const name = path.basename(path.resolve(localPath))
      if (!name) throw new Error(`本地路径无效：${localPath}`)
      const remotePath = posixJoin(targetDir, name)
      if (lstat.isFile()) {
        await addFileRecord(localPath, remotePath, name, lstat.size)
      } else if (lstat.isDirectory()) {
        const existing = await this.stat(channel, remotePath)
        if (existing && !attrsIsDirectory(existing)) {
          throw new Error(`远端已存在同名文件：${name}`)
        }
        addDirectory(remotePath)
        await walkLocal(localPath, remotePath, '', 0)
      } else {
        throw new Error(`不支持的文件类型：${name}`)
      }
    }

    if (conflicts.length > 0) {
      return { started: false, conflicts, transfers: [] }
    }

    await this.ensureRemoteDirectories(channel, directories)

    for (const record of records) {
      let offset = 0
      const partial = await this.stat(channel, record.partialPath)
      if (partial) {
        if (attrsIsDirectory(partial)) {
          throw new Error(`续传临时路径是一个目录：${record.name}`)
        }
        const size = Number(partial.size) || 0
        if (size > record.total) {
          await this.unlinkQuiet(channel, record.partialPath)
        } else {
          offset = size
        }
      }
      record.resumeOffset = offset
      record.transferred = offset
      record.resumed = offset > 0
    }

    if (records.length > 0) this.enqueue(session, records)
    return {
      started: true,
      conflicts: [],
      transfers: records.map((record) => this.publicTransfer(record))
    }
  }

  async downloadAndWait(sessionId, remotePaths, localDir, overwrite = false) {
    const result = await this.download(sessionId, remotePaths, localDir, overwrite)
    if (!result.started) {
      throw new Error(`本地已存在同名文件：${result.conflicts.slice(0, 3).join('、') || '未知'}`)
    }
    for (const transfer of result.transfers) {
      await this.waitForTransfer(transfer.id)
    }
    return result
  }

  async waitForTransfer(transferId) {
    const deadline = Date.now() + 30 * 60 * 1000
    while (Date.now() < deadline) {
      const record = this.transfers.get(String(transferId))?.record
      if (!record) return
      if (record.status === 'done') return
      if (record.status === 'error') throw new Error(record.error || `下载失败：${record.name}`)
      if (record.status === 'canceled') throw new Error(`下载已取消：${record.name}`)
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    throw new Error('下载超时')
  }

  async download(sessionId, remotePaths, localDir, overwrite = false) {
    const session = this.requireSession(String(sessionId))
    if (!Array.isArray(remotePaths) || remotePaths.length === 0) throw new Error('请选择要下载的文件或文件夹')
    if (remotePaths.length > MAX_FILES_PER_REQUEST) throw new Error('一次选择的项目过多')
    if (typeof localDir !== 'string' || !localDir) throw new Error('本地目录无效')
    const localStat = fs.statSync(localDir, { throwIfNoEntry: false })
    if (!localStat || !localStat.isDirectory()) throw new Error('本地下载目录不存在')
    const channel = await this.getChannel(session)
    const records = []
    const conflicts = []
    const localTargets = new Set()

    const addLocalDirectory = (target) => {
      const existing = fs.statSync(target, { throwIfNoEntry: false })
      if (existing && !existing.isDirectory()) throw new Error(`本地已存在同名文件：${path.basename(target)}`)
      fs.mkdirSync(target, { recursive: true })
    }

    const addFileRecord = (remotePath, localPath, relativePath, total) => {
      if (records.length >= MAX_FILES_PER_REQUEST) {
        throw new Error(`一次最多传输 ${MAX_FILES_PER_REQUEST} 个文件`)
      }
      if (localTargets.has(localPath)) throw new Error(`本地目标路径重复：${relativePath}`)
      localTargets.add(localPath)
      const existing = fs.statSync(localPath, { throwIfNoEntry: false })
      if (existing && existing.isDirectory()) {
        throw new Error(`本地已存在同名文件夹：${relativePath}`)
      }
      const targetExists = Boolean(existing)
      if (targetExists && !overwrite) conflicts.push(relativePath)
      records.push({
        id: transferId(),
        sessionId: session.id,
        direction: 'download',
        name: relativePath,
        localPath,
        remotePath,
        partialPath: `${localPath}${PARTIAL_SUFFIX}`,
        total,
        transferred: 0,
        resumeOffset: 0,
        resumed: false,
        targetExists,
        status: 'queued',
        cancelled: false
      })
    }

    const readRemoteDirectory = (remotePath) =>
      new Promise((resolve, reject) => {
        channel.readdir(remotePath, (error, list) => {
          if (error) reject(error)
          else resolve(list || [])
        })
      })

    const walkRemote = async (remoteDirectory, localDirectory, relativeBase, depth, visited) => {
      if (depth > MAX_RECURSION_DEPTH) throw new Error(`远端文件夹层级过深：${remoteDirectory}`)
      if (visited.has(remoteDirectory)) return
      visited.add(remoteDirectory)
      const entries = await readRemoteDirectory(remoteDirectory)
      entries.sort((a, b) => String(a.filename).localeCompare(String(b.filename), 'zh-CN'))
      for (const entry of entries) {
        const name = String(entry.filename || '')
        if (!name || name === '.' || name === '..') continue
        if (name.endsWith(PARTIAL_SUFFIX)) continue
        const attrs = entry.attrs || {}
        if (attrsIsSymbolicLink(attrs)) continue
        const remotePath = posixJoin(remoteDirectory, name)
        const relativePath = relativeBase ? `${relativeBase}/${name}` : name
        const localPath = path.join(localDirectory, safeLocalName(name))
        if (attrsIsDirectory(attrs)) {
          addLocalDirectory(localPath)
          await walkRemote(remotePath, localPath, relativePath, depth + 1, visited)
        } else {
          addFileRecord(remotePath, localPath, relativePath, Number(attrs.size) || 0)
        }
      }
    }

    for (const remotePath of remotePaths) {
      const source = validateRemotePath(remotePath)
      const attrs = await this.stat(channel, source)
      if (!attrs) throw new Error(`远端文件不存在：${source}`)
      const name = safeLocalName(source)
      if (attrsIsDirectory(attrs)) {
        const localRoot = path.join(localDir, name)
        addLocalDirectory(localRoot)
        await walkRemote(source, localRoot, '', 0, new Set())
      } else {
        addFileRecord(source, path.join(localDir, name), name, Number(attrs.size) || 0)
      }
    }

    if (conflicts.length > 0) {
      return { started: false, conflicts, transfers: [] }
    }

    for (const record of records) {
      let offset = 0
      if (fs.existsSync(record.partialPath)) {
        const partialStat = fs.statSync(record.partialPath, { throwIfNoEntry: false })
        if (partialStat && partialStat.isDirectory()) {
          throw new Error(`续传临时路径是一个文件夹：${record.name}`)
        }
        const size = partialStat ? Number(partialStat.size) || 0 : 0
        if (size > record.total) {
          fs.rmSync(record.partialPath, { force: true })
        } else {
          offset = size
        }
      }
      record.resumeOffset = offset
      record.transferred = offset
      record.resumed = offset > 0
    }

    if (records.length > 0) this.enqueue(session, records)
    return {
      started: true,
      conflicts: [],
      transfers: records.map((record) => this.publicTransfer(record))
    }
  }


  publicTransfer(record) {
    return {
      id: record.id,
      sessionId: record.sessionId,
      direction: record.direction,
      name: record.name,
      total: record.total,
      status: record.status,
      resumed: Boolean(record.resumed)
    }
  }

  enqueue(session, records) {
    for (const record of records) {
      this.transfers.set(record.id, { record, abort: null, createdAt: Date.now() })
      this.emit(record, 'queued')
    }
    const previous = this.sessionQueues.get(session.id) || Promise.resolve()
    const next = previous
      .then(() => this.runRecords(session.id, records))
      .catch((error) => {
        this.logger?.warn('sftp queue error', { sessionId: session.id, message: error.message })
      })
      .finally(() => {
        if (this.sessionQueues.get(session.id) === next) this.sessionQueues.delete(session.id)
      })
    this.sessionQueues.set(session.id, next)
  }

  async runRecords(sessionId, records) {
    for (const record of records) {
      if (record.status === 'canceled' || record.cancelled) {
        if (record.status !== 'canceled') this.emit(record, 'canceled')
        continue
      }
      const session = this.getSession(sessionId)
      if (!session || session.status !== 'connected' || !session.client) {
        record.error = '会话已断开，传输已中止'
        this.emit(record, 'error', { error: record.error })
        continue
      }
      record.status = 'running'
      record.startedAt = Date.now()
      this.emit(record, 'running')
      try {
        if (record.direction === 'upload') await this.uploadOne(session, record)
        else await this.downloadOne(session, record)
        if (record.cancelled) {
          if (record.status !== 'canceled') this.emit(record, 'canceled')
        } else {
          record.transferred = record.total
          this.emit(record, 'done')
        }
      } catch (error) {
        if (record.cancelled) {
          if (record.status !== 'canceled') this.emit(record, 'canceled')
        } else {
          this.logger?.warn('sftp transfer failed', {
            sessionId,
            direction: record.direction,
            name: record.name,
            message: error.message
          })
          record.error = error.message || '传输失败'
          this.emit(record, 'error', { error: record.error })
        }
      } finally {
        const entry = this.transfers.get(record.id)
        if (entry) entry.abort = null
        record.finishedAt = Date.now()
        this.cleanupTransfer(record.id)
      }
    }
  }

  async uploadOne(session, record) {
    const channel = await this.getChannel(session)
    const partial = record.partialPath
    const offset = Number(record.resumeOffset) || 0
    record.transferred = offset
    if (record.cancelled) throw new Error('传输已取消')

    if (offset < record.total) {
      const read = fs.createReadStream(record.localPath, { start: offset })
      const write = channel.createWriteStream(
        partial,
        offset > 0
          ? { flags: 'r+', start: offset, mode: 0o644 }
          : { flags: 'w', mode: 0o644 }
      )
      const entry = this.transfers.get(record.id)
      if (entry) {
        entry.abort = () => {
          try {
            read.destroy()
          } catch {}
          try {
            write.destroy()
          } catch {}
        }
      }
      let lastEmit = 0
      read.on('data', (chunk) => {
        record.transferred += chunk.length
        const now = Date.now()
        if (now - lastEmit >= PROGRESS_INTERVAL_MS || record.transferred >= record.total) {
          lastEmit = now
          this.emit(record, 'running')
        }
      })
      await pipeline(read, write)
      if (record.cancelled) throw new Error('传输已取消')
      const partialAttrs = await this.stat(channel, partial)
      if (!partialAttrs || Number(partialAttrs.size) < record.total) {
        throw new Error('上传未完成，已保留临时文件，可重试续传')
      }
    } else if (offset === 0 && record.total === 0) {
      await new Promise((resolve, reject) => {
        channel.open(partial, 'w', 0o644, (error, handle) => {
          if (error) return reject(error)
          channel.close(handle, (closeError) => (closeError ? reject(closeError) : resolve()))
        })
      })
    } else {
      const partialAttrs = await this.stat(channel, partial)
      if (!partialAttrs || Number(partialAttrs.size) !== record.total) {
        throw new Error('续传临时文件大小异常，请重试')
      }
    }

    if (record.cancelled) throw new Error('传输已取消')
    const targetAttrs = await this.stat(channel, record.remotePath)
    if (targetAttrs && attrsIsDirectory(targetAttrs)) {
      throw new Error('远端目标是一个目录')
    }
    if (targetAttrs) await this.unlinkQuiet(channel, record.remotePath)
    await new Promise((resolve, reject) => {
      channel.rename(partial, record.remotePath, (error) => (error ? reject(error) : resolve()))
    })
    record.transferred = record.total
  }

  async downloadOne(session, record) {
    const channel = await this.getChannel(session)
    const partial = record.partialPath
    const offset = Number(record.resumeOffset) || 0
    record.transferred = offset
    if (record.cancelled) throw new Error('传输已取消')

    if (offset < record.total) {
      await this.downloadPipelined(channel, record, partial, offset)
      if (record.cancelled) throw new Error('传输已取消')
      const partialStat = fs.statSync(partial, { throwIfNoEntry: false })
      if (!partialStat || partialStat.size < record.total) {
        throw new Error('下载未完成，已保留临时文件，可重试续传')
      }
    } else if (offset === 0 && record.total === 0) {
      fs.writeFileSync(partial, Buffer.alloc(0), { mode: 0o600 })
    } else {
      const partialStat = fs.statSync(partial, { throwIfNoEntry: false })
      if (!partialStat || partialStat.size !== record.total) {
        throw new Error('续传临时文件大小异常，请重试')
      }
    }

    if (record.cancelled) throw new Error('传输已取消')
    const targetStat = fs.statSync(record.localPath, { throwIfNoEntry: false })
    if (targetStat && targetStat.isDirectory()) {
      throw new Error('本地目标是一个文件夹')
    }
    if (targetStat) fs.rmSync(record.localPath, { force: true })
    fs.renameSync(partial, record.localPath)
    record.transferred = record.total
  }

  async downloadPipelined(channel, record, partial, offset) {
    const total = Number(record.total) || 0
    if (total <= offset) return
    const entry = this.transfers.get(record.id)
    const handle = await new Promise((resolve, reject) => {
      channel.open(record.remotePath, 'r', (error, value) => {
        if (error) reject(error)
        else resolve(value)
      })
    })
    if (record.cancelled) {
      try {
        channel.close(handle, () => {})
      } catch {}
      throw new Error('传输已取消')
    }

    let fd
    try {
      fd = fs.openSync(partial, offset > 0 ? 'r+' : 'w', 0o600)
    } catch (error) {
      try {
        channel.close(handle, () => {})
      } catch {}
      throw error
    }
    if (offset > 0) {
      const stat = fs.fstatSync(fd)
      if (stat.size < offset) {
        try {
          fs.closeSync(fd)
        } catch {}
        try {
          channel.close(handle, () => {})
        } catch {}
        throw new Error('续传临时文件大小异常，请重试')
      }
    }

    let settled = false
    let fdOpen = true
    let handleOpen = true
    let active = 0
    let next = offset
    let writePosition = offset
    let writing = false
    let lastEmit = 0
    const ready = new Map()

    const closeResources = () => {
      if (fdOpen) {
        fdOpen = false
        try {
          fs.closeSync(fd)
        } catch {}
      }
      if (handleOpen) {
        handleOpen = false
        try {
          channel.close(handle, () => {})
        } catch {}
      }
    }

    await new Promise((resolve, reject) => {
      const fail = (error) => {
        if (settled) return
        settled = true
        if (entry) entry.abort = null
        closeResources()
        reject(error)
      }
      const finish = () => {
        if (settled) return
        if (record.cancelled) {
          fail(new Error('传输已取消'))
          return
        }
        const stat = fs.statSync(partial, { throwIfNoEntry: false })
        if (!stat || stat.size < total) {
          fail(new Error('下载未完成，已保留临时文件，可重试续传'))
          return
        }
        settled = true
        if (entry) entry.abort = null
        closeResources()
        record.transferred = total
        resolve()
      }
      const emitProgress = () => {
        const now = Date.now()
        if (now - lastEmit >= PROGRESS_INTERVAL_MS || writePosition >= total) {
          lastEmit = now
          this.emit(record, 'running')
        }
      }
      const flush = () => {
        if (settled || writing) return
        const buffer = ready.get(writePosition)
        if (!buffer) return
        writing = true
        fs.write(fd, buffer, 0, buffer.length, writePosition, (error, bytesWritten) => {
          writing = false
          if (settled) return
          if (error) {
            fail(error)
            return
          }
          if (bytesWritten !== buffer.length) {
            fail(new Error('本地写入不完整'))
            return
          }
          ready.delete(writePosition)
          writePosition += buffer.length
          record.transferred = Math.min(total, writePosition)
          emitProgress()
          flush()
          schedule()
          maybeFinish()
        })
      }
      const maybeFinish = () => {
        if (settled) return
        if (active === 0 && next >= total && ready.size === 0 && !writing && writePosition >= total) {
          finish()
        }
      }
      const schedule = () => {
        if (settled) return
        if (record.cancelled) {
          fail(new Error('传输已取消'))
          return
        }
        while (active + ready.size < DOWNLOAD_CONCURRENCY && next < total) {
          const position = next
          const length = Math.min(DOWNLOAD_CHUNK_SIZE, total - position)
          next += length
          active += 1
          readRange(position, length, (error, buffer) => {
            active -= 1
            if (settled) return
            if (error) {
              fail(error)
              return
            }
            ready.set(position, buffer)
            flush()
            schedule()
            maybeFinish()
          })
        }
        maybeFinish()
      }
      const readRange = (position, length, done) => {
        const buffer = Buffer.allocUnsafe(length)
        let filled = 0
        const step = () => {
          if (settled) return
          if (record.cancelled) {
            done(new Error('传输已取消'))
            return
          }
          channel.read(handle, buffer, filled, length - filled, position + filled, (error, bytesRead) => {
            if (settled) return
            if (error) {
              done(error)
              return
            }
            if (!bytesRead) {
              done(new Error('远端读取未返回数据'))
              return
            }
            filled += bytesRead
            if (filled < length) {
              step()
            } else {
              done(null, buffer)
            }
          })
        }
        step()
      }
      if (entry) {
        entry.abort = () => {
          record.cancelled = true
          fail(new Error('传输已取消'))
        }
      }
      schedule()
    })
  }

  unlinkQuiet(channel, remotePath) {
    return new Promise((resolve) => {
      channel.unlink(remotePath, () => resolve())
    })
  }

  emit(record, status, extra = {}) {
    if (record.status === 'canceled' && status !== 'canceled') return
    record.status = status
    const total = Number(record.total) || 0
    const transferred = Math.min(Number(record.transferred) || 0, total || Number.MAX_SAFE_INTEGER)
    const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 1000) / 10) : 0
    this.send('sftp:progress', {
      sessionId: record.sessionId,
      transferId: record.id,
      direction: record.direction,
      name: record.name,
      status,
      transferred,
      total,
      percent,
      resumed: Boolean(record.resumed),
      remotePath: record.remotePath,
      localPath: record.localPath,
      error: extra.error || ''
    })
  }

  cancel(transferId) {
    const entry = this.transfers.get(String(transferId))
    if (!entry) return false
    const record = entry.record
    if (record.status === 'done' || record.status === 'error' || record.status === 'canceled') {
      return false
    }
    record.cancelled = true
    record.status = 'canceled'
    this.emit(record, 'canceled')
    try {
      entry.abort?.()
    } catch {
      // ignore
    }
    this.cleanupTransfer(record.id)
    return true
  }

  cleanupTransfer(id) {
    const entry = this.transfers.get(id)
    if (!entry) return
    if (entry.record.status === 'done' || entry.record.status === 'error' || entry.record.status === 'canceled') {
      setTimeout(() => this.transfers.delete(id), 5 * 60 * 1000).unref?.()
    }
  }

  abortSession(sessionId) {
    for (const entry of [...this.transfers.values()]) {
      if (entry.record.sessionId !== sessionId) continue
      if (entry.record.status === 'done' || entry.record.status === 'error') continue
      if (entry.record.status === 'canceled') continue
      entry.record.cancelled = true
      entry.record.status = 'canceled'
      this.emit(entry.record, 'canceled', { error: '会话已断开' })
      try {
        entry.abort?.()
      } catch {
        // ignore
      }
      this.cleanupTransfer(entry.record.id)
    }
  }

  async closeSession(sessionId) {
    this.abortSession(sessionId)
    const session = this.getSession(sessionId)
    if (!session) return
    const channel = session.sftpChannel
    session.sftpChannel = null
    if (channel) {
      try {
        channel.end()
      } catch {
        // ignore
      }
    }
  }

  closeAll() {
    const sessionIds = new Set()
    for (const entry of this.transfers.values()) {
      sessionIds.add(entry.record.sessionId)
      this.cancel(entry.record.id)
    }
    for (const sessionId of sessionIds) void this.closeSession(sessionId)
  }
}

module.exports = { SftpService }
