import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DragDownloadService } from '../../desktop/drag-download.js'

test('drag download creates placeholders, detects the drop target and downloads with the real name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-drag-test-'))
  const target = path.join(root, 'target')
  fs.mkdirSync(target, { recursive: true })
  const calls = []
  const events = []
  const sftp = {
    async downloadAndWait(sessionId, remotePaths, localDir) {
      const remotePath = remotePaths[0]
      const name = path.posix.basename(remotePath)
      calls.push({ sessionId, remotePath, localDir })
      if (remotePath === '/remote/beta') {
        fs.mkdirSync(path.join(localDir, name), { recursive: true })
        fs.writeFileSync(path.join(localDir, name, 'nested.txt'), 'nested\n', 'utf8')
      } else {
        fs.writeFileSync(path.join(localDir, name), 'alpha\n', 'utf8')
      }
    }
  }
  let started = []
  const service = new DragDownloadService({
    getWindow: () => ({ isDestroyed: () => false }),
    sftp,
    send: (channel, payload) => events.push({ channel, payload }),
    watchRoots: [root],
    iconPath: '',
    startDrag: (files) => {
      started = files
      setTimeout(() => {
        for (const file of files) {
          fs.cpSync(file, path.join(target, path.basename(file)), { recursive: true })
        }
      }, 250)
    }
  })

  await service.start('session-1', [
    { path: '/remote/alpha.txt', name: 'alpha.txt', isDirectory: false },
    { path: '/remote/beta', name: 'beta', isDirectory: true }
  ])
  assert.equal(started.length, 2)
  for (let attempt = 0; attempt < 80 && events.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(calls.length, 2)
  assert.equal(fs.readFileSync(path.join(target, 'alpha.txt'), 'utf8'), 'alpha\n')
  assert.equal(fs.readFileSync(path.join(target, 'beta', 'nested.txt'), 'utf8'), 'nested\n')
  assert.equal(events.filter((event) => event.channel === 'sftp:drag-download').length, 2)
  assert.equal(events.filter((event) => event.channel === 'sftp:drag-error').length, 0)
  service.cleanup()
  fs.rmSync(root, { recursive: true, force: true })
})

test('drag download asks before overwriting and cancels when declined', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-drag-cancel-'))
  const target = path.join(root, 'target')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'alpha.txt'), 'old\n', 'utf8')
  const events = []
  let downloads = 0
  const service = new DragDownloadService({
    getWindow: () => ({ isDestroyed: () => false }),
    sftp: {
      async downloadAndWait() {
        downloads += 1
      }
    },
    send: (channel, payload) => events.push({ channel, payload }),
    watchRoots: [root],
    iconPath: '',
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    startDrag: (files) => {
      setTimeout(() => {
        fs.cpSync(files[0], path.join(target, path.basename(files[0])), { recursive: true })
      }, 200)
    }
  })
  await service.start('session-1', [
    { path: '/remote/alpha.txt', name: 'alpha.txt', isDirectory: false }
  ])
  for (let attempt = 0; attempt < 80 && events.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(downloads, 0)
  assert.equal(fs.readFileSync(path.join(target, 'alpha.txt'), 'utf8'), 'old\n')
  assert.equal(events[0]?.channel, 'sftp:drag-cancel')
  service.cleanup()
  fs.rmSync(root, { recursive: true, force: true })
})

test('drag download overwrites the existing target when approved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-drag-overwrite-'))
  const target = path.join(root, 'target')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'alpha.txt'), 'old\n', 'utf8')
  const events = []
  let overwrite = null
  const service = new DragDownloadService({
    getWindow: () => ({ isDestroyed: () => false }),
    sftp: {
      async downloadAndWait(_sessionId, _remotePaths, localDir, value) {
        overwrite = value
        fs.writeFileSync(path.join(localDir, 'alpha.txt'), 'new\n', 'utf8')
      }
    },
    send: (channel, payload) => events.push({ channel, payload }),
    watchRoots: [root],
    iconPath: '',
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    startDrag: (files) => {
      setTimeout(() => {
        fs.cpSync(files[0], path.join(target, path.basename(files[0])), { recursive: true })
      }, 200)
    }
  })
  await service.start('session-1', [
    { path: '/remote/alpha.txt', name: 'alpha.txt', isDirectory: false }
  ])
  for (let attempt = 0; attempt < 80 && events.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(overwrite, true)
  assert.equal(fs.readFileSync(path.join(target, 'alpha.txt'), 'utf8'), 'new\n')
  assert.equal(events[0]?.channel, 'sftp:drag-download')
  service.cleanup()
  fs.rmSync(root, { recursive: true, force: true })
})
