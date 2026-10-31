import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { exportXshellSessions } = require('../../desktop/xshell-export.js')
const { scanXshellFolder } = require('../../desktop/xshell-import.js')

test('exportXshellSessions creates Xshell session files and round-trips through the importer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-xshell-export-'))
  try {
    const state = {
      folders: [
        { id: 'group', name: '生产/核心', parentId: null },
        { id: 'nested', name: '成都', parentId: 'group' }
      ],
      connections: [
        {
          id: 'one',
          folderId: 'nested',
          name: '10.0.0.1 root',
          host: '10.0.0.1',
          port: 2222,
          username: 'root',
          authType: 'password',
          password: 's3cret',
          passphrase: 'keypass',
          description: '生产环境',
          terminalType: 'xterm-256color',
          encoding: 'UTF-8',
          order: 1,
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
          lastConnectedAt: 1700000002000
        },
        {
          id: 'two',
          folderId: null,
          name: 'root',
          host: '10.0.0.2',
          port: 22,
          username: 'tinci',
          authType: 'privateKey',
          description: '',
          terminalType: 'xterm',
          encoding: 'UTF-8',
          order: 0,
          createdAt: 0,
          updatedAt: 0,
          lastConnectedAt: 0
        }
      ]
    }
    const result = exportXshellSessions(state, path.join(root, 'export'))
    assert.equal(result.connections, 2)
    assert.equal(result.files, 2)
    assert.equal(result.folders, 2)
    assert.equal(result.passwords, 1)
    assert.equal(result.passphrases, 1)
    const nestedFile = path.join(result.directory, '生产_核心', '成都', '10.0.0.1 root_connect_config.json')
    assert.ok(fs.existsSync(nestedFile))
    const payload = JSON.parse(fs.readFileSync(nestedFile, 'utf8'))
    assert.equal(payload.host, '10.0.0.1')
    assert.equal(payload.user_name, 'root')
    assert.equal(payload.port, 2222)
    assert.equal(payload.name, '10.0.0.1 root')
    assert.equal(payload.password, '')
    assert.equal(payload.hongssh_password, 's3cret')
    assert.equal(payload.hongssh_passphrase, 'keypass')
    assert.equal(payload.authentication_type, 1)
    assert.equal(payload.parent_id.length, 16)
    assert.equal(payload.terminal_encoding, 'UTF-8')

    const scanned = scanXshellFolder(result.directory)
    assert.equal(scanned.summary.unique, 2)
    assert.equal(scanned.summary.withPassword, 1)
    assert.equal(scanned.summary.portablePasswords, 1)
    assert.equal(scanned.summary.xshellPasswords, 0)
    assert.deepEqual(scanned.folders.sort(), ['生产_核心', '生产_核心/成都'])
    const imported = scanned.connections.find((item) => item.host === '10.0.0.1')
    assert.deepEqual(imported.folderPath, ['生产_核心', '成都'])
    assert.equal(imported.port, 2222)
    assert.equal(imported.password, 's3cret')
    assert.equal(imported.passphrase, 'keypass')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('exportXshellSessions avoids duplicate filenames and strips path separators', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-xshell-export-'))
  try {
    const state = {
      folders: [],
      connections: [
        { name: 'same', host: 'a.example', port: 22, username: 'root' },
        { name: 'same', host: 'b.example', port: 22, username: 'root' },
        { name: 'bad/name:test', host: 'c.example', port: 22, username: 'root' }
      ]
    }
    const result = exportXshellSessions(state, path.join(root, 'export'))
    assert.equal(result.files, 3)
    assert.ok(fs.existsSync(path.join(result.directory, 'same_connect_config.json')))
    assert.ok(fs.existsSync(path.join(result.directory, 'same-2_connect_config.json')))
    assert.ok(fs.existsSync(path.join(result.directory, 'bad_name_test_connect_config.json')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
