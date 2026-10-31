'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const PLACEHOLDER_PREFIX = '.hongssh-drop-'
const WATCH_TIMEOUT_MS = 30000

function defaultWatchRoots() {
  const roots = new Set()
  for (const key of ['desktop', 'downloads', 'documents']) {
    try {
      const { app } = require('electron')
      const value = app.getPath(key)
      if (value) roots.add(value)
    } catch {
      // app may be unavailable in unit tests.
    }
  }
  roots.add(os.homedir())
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`
      if (fs.existsSync(root)) roots.add(root)
    }
  } else {
    roots.add('/')
  }
  return [...roots]
}

class DragDownloadService {
  constructor({
    getWindow,
    sftp,
    send,
    logger,
    icon = null,
    iconPath = '',
    dialog = null,
    createDragImage = null,
    watchRoots = null,
    startDrag = null
  }) {
    this.getWindow = getWindow
    this.sftp = sftp
    this.send = send
    this.logger = logger
    this.icon = icon
    this.iconPath = iconPath
    this.dialog = dialog
    this.createDragImage = createDragImage
    this.watchRoots = watchRoots
    this.startDragImpl = startDrag
    this.session = null
  }

  startWatchers(session) {
    const roots = this.watchRoots || defaultWatchRoots()
    for (const root of roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
          this.onWatch(root, filename)
        })
        watcher.on('error', () => {
          try {
            watcher.close()
          } catch {
            // ignore
          }
        })
        session.watchers.push(watcher)
      } catch (error) {
        this.logger?.warn('drag watch failed', { root, message: error.message })
      }
    }
    session.timer = setTimeout(() => this.cleanup(), WATCH_TIMEOUT_MS)
  }

  async start(sessionId, items, dragImage = '') {
    const list = Array.isArray(items) ? items : []
    if (!sessionId || list.length === 0) throw new Error('没有可下载的远端项目')
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('窗口不可用')
    if (this.session) this.cleanup()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-drag-'))
    this.session = {
      tempDir,
      watchers: [],
      entries: new Map(),
      total: 0,
      matched: 0,
      timer: null
    }
    const session = this.session
    const placeholders = []
    for (const item of list) {
      const remotePath = String(item?.path || '')
      const name = path.posix.basename(remotePath)
      if (!remotePath || !name) continue
      const isDirectory = Boolean(item?.isDirectory)
      const token = crypto.randomUUID()
      const placeholderName = `${PLACEHOLDER_PREFIX}${token}.file`
      const placeholderPath = path.join(session.tempDir, placeholderName)
      fs.writeFileSync(placeholderPath, '')
      session.entries.set(placeholderName.toLowerCase(), {
        sessionId: String(sessionId),
        remotePath,
        name,
        isDirectory,
        placeholderPath,
        matched: false
      })
      placeholders.push(placeholderPath)
    }
    if (placeholders.length === 0) {
      this.cleanup()
      throw new Error('没有可下载的远端项目')
    }
    session.total = placeholders.length
    this.startWatchers(session)
    if (session.watchers.length === 0) {
      this.cleanup()
      throw new Error('无法监听本地目录，拖放下载不可用')
    }
    let icon = this.icon || this.iconPath
    if (dragImage && this.createDragImage) {
      try {
        const image = this.createDragImage(dragImage)
        if (image && !image.isEmpty()) icon = image
      } catch (error) {
        this.logger?.warn('drag preview image failed', { message: error.message })
      }
    }
    try {
      if (this.startDragImpl) {
        this.startDragImpl(placeholders, icon)
      } else {
        window.webContents.startDrag({
          files: placeholders,
          icon
        })
      }
    } catch (error) {
      this.cleanup()
      throw error
    }
    return { started: true, count: placeholders.length }
  }

  onWatch(root, filename) {
    const session = this.session
    if (!session || !filename) return
    const fullPath = path.isAbsolute(filename) ? filename : path.join(root, filename)
    if (fullPath.toLowerCase().startsWith(`${session.tempDir.toLowerCase()}${path.sep}`)) return
    const entry = session.entries.get(path.basename(fullPath).toLowerCase())
    if (!entry || entry.matched) return
    if (!fs.existsSync(fullPath)) return
    entry.matched = true
    session.matched += 1
    void this.handleDrop(session, entry, fullPath)
    if (session.matched >= session.total) {
      setTimeout(() => this.cleanup(), 2500)
    }
  }

  async handleDrop(session, entry, placeholderPath) {
    const targetDirectory = path.dirname(placeholderPath)
    const targetPath = path.join(targetDirectory, entry.name)
    try {
      fs.rmSync(placeholderPath, { recursive: true, force: true })
      let overwrite = false
      if (fs.existsSync(targetPath)) {
        const approved = await this.confirmOverwrite(entry, targetPath)
        if (!approved) {
          this.send('sftp:drag-cancel', {
            sessionId: entry.sessionId,
            name: entry.name
          })
          return
        }
        overwrite = true
        const targetStat = fs.lstatSync(targetPath, { throwIfNoEntry: false })
        if (targetStat && (entry.isDirectory || targetStat.isDirectory())) {
          fs.rmSync(targetPath, { recursive: true, force: true })
        }
      }
      await this.sftp.downloadAndWait(
        entry.sessionId,
        [entry.remotePath],
        targetDirectory,
        overwrite
      )
      this.send('sftp:drag-download', {
        sessionId: entry.sessionId,
        name: entry.name,
        localPath: targetPath
      })
    } catch (error) {
      try {
        fs.rmSync(placeholderPath, { recursive: true, force: true })
      } catch {
        // ignore
      }
      this.logger?.warn('drag download failed', {
        remotePath: entry.remotePath,
        targetDirectory,
        message: error.message
      })
      this.send('sftp:drag-error', {
        sessionId: entry.sessionId,
        name: entry.name,
        message: error.message || '拖放下载失败'
      })
    }
  }

  async confirmOverwrite(entry, targetPath) {
    if (!this.dialog?.showMessageBox) return false
    try {
      const result = await this.dialog.showMessageBox(this.getWindow(), {
        type: 'warning',
        title: '目标已存在',
        message: `“${entry.name}”已存在，是否覆盖？`,
        detail: `目标位置：${targetPath}\n选择“取消”将取消本次下载，现有内容不会被修改。${
          entry.isDirectory ? '\n覆盖文件夹会先删除目标位置现有的同名文件夹。' : ''
        }`,
        buttons: ['覆盖', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      return result.response === 0
    } catch (error) {
      this.logger?.warn('drag overwrite prompt failed', { message: error.message })
      return false
    }
  }

  cleanup() {
    const session = this.session
    if (!session) return
    this.session = null
    clearTimeout(session.timer)
    for (const watcher of session.watchers) {
      try {
        watcher.close()
      } catch {
        // ignore
      }
    }
    for (const entry of session.entries.values()) {
      try {
        fs.rmSync(entry.placeholderPath, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(session.tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

module.exports = { DragDownloadService, defaultWatchRoots }
