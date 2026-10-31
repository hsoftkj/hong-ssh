import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { scanXshellFolder } = require('../../desktop/xshell-import.js')

function writeSession(directory, filename, payload) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, filename), JSON.stringify(payload), 'utf8')
}

test('scanXshellFolder maps folders, names, ports and de-duplicates sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-xshell-'))
  try {
    const nested = path.join(root, 'WMS', '四川')
    writeSession(nested, '10.0.0.115root_connect_config.json', {
      host: '10.0.0.115',
      user_name: 'root',
      port: 2222,
      name: '10.0.0.115测试root',
      password: 'encrypted',
      terminal_encoding: 'UTF-8',
      description: '测试环境'
    })
    writeSession(nested, '10.0.0.115_connect_config.json', {
      host: '10.0.0.115',
      user_name: 'root',
      port: 2222,
      name: '重复会话',
      password: 'encrypted'
    })
    writeSession(root, '10.0.0.116_connect_config.json', {
      host: '10.0.0.116',
      user_name: 'tinci',
      name: '根目录连接',
      hongssh_password: 'portable-pass',
      hongssh_passphrase: 'portable-key'
    })
    fs.writeFileSync(path.join(root, 'notes.json'), JSON.stringify({ hello: 'world' }), 'utf8')
    fs.writeFileSync(path.join(nested, 'broken_connect_config.json'), '{bad json', 'utf8')

    const result = scanXshellFolder(root)
    assert.equal(result.summary.files, 5)
    assert.equal(result.summary.sessions, 3)
    assert.equal(result.summary.unique, 2)
    assert.equal(result.summary.duplicates, 1)
    assert.equal(result.summary.withPassword, 2)
    assert.equal(result.summary.portablePasswords, 1)
    assert.equal(result.summary.xshellPasswords, 1)
    assert.deepEqual(result.folders.sort(), ['WMS', 'WMS/四川'])

    const nestedConnection = result.connections.find((item) => item.host === '10.0.0.115')
    assert.equal(nestedConnection.username, 'root')
    assert.equal(nestedConnection.port, 2222)
    assert.equal(nestedConnection.name, '10.0.0.115测试root')
    assert.deepEqual(nestedConnection.folderPath, ['WMS', '四川'])
    assert.equal(nestedConnection.description, '测试环境')
    assert.equal(nestedConnection.hasXshellPassword, true)

    const rootConnection = result.connections.find((item) => item.host === '10.0.0.116')
    assert.equal(rootConnection.username, 'tinci')
    assert.equal(rootConnection.port, 22)
    assert.equal(rootConnection.password, 'portable-pass')
    assert.equal(rootConnection.passphrase, 'portable-key')
    assert.deepEqual(rootConnection.folderPath, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scanXshellFolder rejects a file path', () => {
  const file = path.join(os.tmpdir(), `hongssh-not-a-folder-${Date.now()}.json`)
  fs.writeFileSync(file, '{}')
  try {
    assert.throws(() => scanXshellFolder(file), /文件夹/)
  } finally {
    fs.rmSync(file, { force: true })
  }
})
