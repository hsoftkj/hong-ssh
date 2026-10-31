/**
 * Local SSH server for integration tests. It authenticates with a fixed
 * password and bridges the SSH shell channel to a real ConPTY running Git Bash.
 * That gives the client a genuine interactive terminal: vim, less, colors,
 * alternate screen and window resize all behave like a Linux host.
 */
import ssh2 from 'ssh2'
import pty from 'node-pty'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Server, utils } = ssh2

const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8
}

const OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
  flagsToString(flags) {
    const read = Boolean(flags & OPEN_MODE.READ)
    const write = Boolean(flags & OPEN_MODE.WRITE)
    if (!read && !write) return null
    if (read && !write) return 'r'
    if (write && !read) {
      if (flags & OPEN_MODE.APPEND) return 'a'
      return 'w'
    }
    return 'r+'
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
const fixtureBin = path.join(root, 'tests', 'fixtures', 'bin')

export const TEST_USER = 'tester'
export const TEST_PASSWORD = 'test123'

export async function startTestServer(options = {}) {
  if (!fs.existsSync(bashPath)) throw new Error(`Git Bash not found: ${bashPath}`)
  const hostKey = utils.generateKeyPairSync('ed25519')
  const sftpRoot = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-sftp-'))
  const home = path.join(sftpRoot, 'home', 'tester')
  const clients = new Set()
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(sftpRoot, 'tmp'), { recursive: true })
  const clientKey = utils.generateKeyPairSync('ed25519')
  const privateKeyPath = path.join(home, 'id_ed25519')
  fs.writeFileSync(privateKeyPath, clientKey.private, { encoding: 'utf8', mode: 0o600 })
  fs.writeFileSync(
    path.join(home, '.bash_profile'),
    "export PS1='\\[\\e[1;32m\\]tester@hongssh\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]$ '\n",
    'utf8'
  )
  const demoFile = path.join(home, 'demo.sh')
  fs.writeFileSync(
    demoFile,
    [
      '#!/usr/bin/env bash',
      '# HongSSH interactive test file',
      'set -euo pipefail',
      'for host in 10.0.0.1 10.0.0.2; do',
      '  echo "checking ${host}"',
      'done',
      'echo "hello from vim"',
      ''
    ].join('\n'),
    'utf8'
  )

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      if (
        ctx.method === 'password' &&
        ctx.username === TEST_USER &&
        ctx.password === TEST_PASSWORD
      ) {
        ctx.accept()
      } else if (ctx.method === 'publickey' && ctx.username === TEST_USER) {
        // Test-only: accept the generated key without checking the signature.
        ctx.accept()
      } else {
        ctx.reject(['password', 'publickey'])
      }
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        let ptyInfo = null
        let terminal = null
        let terminalExited = false

        session.on('pty', (acceptPty, _rejectPty, info) => {
          ptyInfo = info
          acceptPty()
        })

        session.on('window-change', (acceptChange, _rejectChange, info) => {
          if (terminal && info.cols && info.rows) {
            try {
              terminal.resize(info.cols, info.rows)
            } catch {
              // The shell may be exiting.
            }
          }
          acceptChange?.()
        })

        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          terminal = pty.spawn(bashPath, ['--login', '-i'], {
            name: 'xterm-256color',
            cols: ptyInfo?.cols ?? 100,
            rows: ptyInfo?.rows ?? 30,
            cwd: home,
            env: {
              ...process.env,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              HOME: home,
              PATH: `${fixtureBin};${process.env.PATH}`,
              LANG: 'en_US.UTF-8'
            }
          })
          terminal.onData((data) => {
            try {
              stream.write(data)
            } catch {
              // Client went away.
            }
          })
          terminal.onExit(() => {
            terminalExited = true
            try {
              stream.exit(0)
              stream.end()
            } catch {
              // Already closed.
            }
          })
          stream.on('data', (data) => {
            try {
              terminal.write(data.toString('utf8'))
            } catch {
              // Shell already exited.
            }
          })
          stream.on('close', () => {
            if (terminalExited) return
            // Politely ask the shell to exit. Avoid pty.kill() here: on some
            // Windows hosts node-pty's console-list helper can fail when the
            // ConPTY peer is already gone.
            try {
              terminal.write('exit\r')
            } catch {
              // ignore
            }
          })
        })

        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec()
          if (info.command.includes('HONGSSH_OK')) {
            stream.write('HONGSSH_OK\n')
          } else if (info.command.includes('__HG_STAT_CPU__')) {
            let tick = 0
            const writeSample = () => {
              tick += 1
              const used = 200 + tick * 20
              const total = 1000 + tick * 100
              const idle = total - used
              stream.write(
                [
                  '',
                  '__HG_STAT_CPU__',
                  `cpu ${used} 0 0 ${idle} 0 0 0 0`,
                  '__HG_STAT_MEM__',
                  '8388608 6291456',
                  ''
                ].join('\n')
              )
            }
            writeSample()
            const timer = setInterval(writeSample, 250)
            stream.on('close', () => clearInterval(timer))
            stream.on('error', () => clearInterval(timer))
            return
          } else if (info.command.includes('__HG_OS__')) {
            stream.write(
              [
                '__HG_OS__',
                'NAME="Test Linux"',
                'VERSION="1.0"',
                'PRETTY_NAME="Test Linux 1.0"',
                '__HG_UNAME__',
                'Linux 6.1.0-test x86_64',
                '__HG_HOST__',
                'e2e-host',
                '__HG_UPTIME__',
                'up 2 days, 3 hours',
                '__HG_CPU__',
                '4',
                '__HG_MEM__',
                '8192 2048',
                '__HG_IP__',
                '10.0.0.5',
                ''
              ].join('\n')
            )
          } else if (info.command.includes('df -P -k')) {
            stream.write(
              [
                'Filesystem 1024-blocks Used Available Capacity Mounted on',
                '/dev/sda1 102400000 20480000 81920000 20% /',
                '/dev/sdb1 51200000 48640000 2560000 95% /data',
                'tmpfs 16384 0 16384 0% /dev/shm',
                ''
              ].join('\n')
            )
          } else {
            stream.write(`exec: ${info.command}\n`)
          }
          stream.exit(0)
          stream.end()
        })

        session.on('sftp', (acceptSftp) => {
          const sftpSession = acceptSftp()
          attachSftpHandler(sftpSession, sftpRoot, home)
        })
      })
    })

    client.on('error', () => {})
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      resolve(server.address().port)
    })
  })

  return {
    port,
    host: '127.0.0.1',
    user: TEST_USER,
    password: TEST_PASSWORD,
    home,
    sftpRoot,
    demoFile,
    privateKeyPath,
    async close() {
      for (const client of clients) {
        try {
          client.end()
        } catch {
          // ignore
        }
      }
      clients.clear()
      await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ])
      try {
        fs.rmSync(sftpRoot, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

function attachSftpHandler(sftpSession, root, _home) {
  const virtualHome = '/home/tester'
  const handles = new Map()
  let nextHandle = 1

  const normalizeVirtual = (input) => {
    let value = String(input || '.').replace(/\\/g, '/')
    if (!value.startsWith('/')) value = path.posix.join(virtualHome, value)
    return path.posix.normalize(value)
  }

  const localPath = (input) => {
    const virtual = normalizeVirtual(input)
    const local = path.resolve(root, `.${virtual}`)
    const rootPrefix = path.resolve(root) + path.sep
    if (local !== path.resolve(root) && !local.startsWith(rootPrefix)) {
      const error = new Error('path escapes test root')
      error.code = STATUS_CODE.PERMISSION_DENIED
      throw error
    }
    return local
  }

  const attrsFor = (stats) => ({
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000)
  })

  const makeHandle = (state) => {
    const handle = Buffer.alloc(4)
    handle.writeUInt32BE(nextHandle, 0)
    handles.set(nextHandle, state)
    nextHandle += 1
    return handle
  }

  const getState = (handle) => {
    if (!Buffer.isBuffer(handle) || handle.length !== 4) return null
    return handles.get(handle.readUInt32BE(0)) || null
  }

  const fail = (reqid, error) => {
    sftpSession.status(
      reqid,
      error && error.code === STATUS_CODE.PERMISSION_DENIED
        ? STATUS_CODE.PERMISSION_DENIED
        : error && (error.code === 'ENOENT' || error.code === STATUS_CODE.NO_SUCH_FILE)
          ? STATUS_CODE.NO_SUCH_FILE
          : STATUS_CODE.FAILURE
    )
  }

  sftpSession.on('OPEN', (reqid, filename, flags) => {
    let mode
    try {
      mode = OPEN_MODE.flagsToString(flags)
    } catch {
      mode = null
    }
    if (!mode) return sftpSession.status(reqid, STATUS_CODE.FAILURE)
    try {
      fs.open(localPath(filename), mode, 0o644, (error, fd) => {
        if (error) return fail(reqid, error)
        sftpSession.handle(reqid, makeHandle({ type: 'file', fd }))
      })
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('READ', (reqid, handle, offset, length) => {
    const state = getState(handle)
    if (!state || state.type !== 'file') return sftpSession.status(reqid, STATUS_CODE.FAILURE)
    const buffer = Buffer.alloc(length)
    fs.read(state.fd, buffer, 0, length, offset, (error, bytesRead, readBuffer) => {
      if (error) return fail(reqid, error)
      if (bytesRead === 0) return sftpSession.status(reqid, STATUS_CODE.EOF)
      sftpSession.data(reqid, readBuffer.subarray(0, bytesRead))
    })
  })

  sftpSession.on('WRITE', (reqid, handle, offset, data) => {
    const state = getState(handle)
    if (!state || state.type !== 'file') return sftpSession.status(reqid, STATUS_CODE.FAILURE)
    fs.write(state.fd, data, 0, data.length, offset, (error) => {
      if (error) return fail(reqid, error)
      sftpSession.status(reqid, STATUS_CODE.OK)
    })
  })

  sftpSession.on('FSTAT', (reqid, handle) => {
    const state = getState(handle)
    if (!state || state.type !== 'file') return sftpSession.status(reqid, STATUS_CODE.FAILURE)
    fs.fstat(state.fd, (error, stats) => {
      if (error) return fail(reqid, error)
      sftpSession.attrs(reqid, attrsFor(stats))
    })
  })

  sftpSession.on('FSETSTAT', (reqid) => sftpSession.status(reqid, STATUS_CODE.OK))

  sftpSession.on('CLOSE', (reqid, handle) => {
    const state = getState(handle)
    if (!state) return sftpSession.status(reqid, STATUS_CODE.FAILURE)
    handles.delete(handle.readUInt32BE(0))
    if (state.type === 'file') {
      fs.close(state.fd, (error) => {
        if (error) return fail(reqid, error)
        sftpSession.status(reqid, STATUS_CODE.OK)
      })
    } else {
      sftpSession.status(reqid, STATUS_CODE.OK)
    }
  })

  sftpSession.on('OPENDIR', (reqid, directory) => {
    try {
      const local = localPath(directory)
      const entries = fs
        .readdirSync(local, { withFileTypes: true })
        .map((entry) => {
          const stats = fs.lstatSync(path.join(local, entry.name))
          return {
            filename: entry.name,
            longname: entry.name,
            attrs: attrsFor(stats)
          }
        })
      sftpSession.handle(reqid, makeHandle({ type: 'dir', entries, sent: false }))
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('READDIR', (reqid, handle) => {
    const state = getState(handle)
    if (!state || state.type !== 'dir') return sftpSession.status(reqid, STATUS_CODE.FAILURE)
    if (state.sent) return sftpSession.status(reqid, STATUS_CODE.EOF)
    state.sent = true
    sftpSession.name(reqid, state.entries)
  })

  const onStat = (reqid, target, useLstat = false) => {
    try {
      const local = localPath(target)
      const callback = (error, stats) => {
        if (error) return fail(reqid, error)
        sftpSession.attrs(reqid, attrsFor(stats))
      }
      if (useLstat) fs.lstat(local, callback)
      else fs.stat(local, callback)
    } catch (error) {
      fail(reqid, error)
    }
  }

  sftpSession.on('STAT', (reqid, target) => onStat(reqid, target, false))
  sftpSession.on('LSTAT', (reqid, target) => onStat(reqid, target, true))

  sftpSession.on('REALPATH', (reqid, target) => {
    try {
      const virtual = normalizeVirtual(target)
      sftpSession.name(reqid, [{ filename: virtual, longname: virtual, attrs: {} }])
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('MKDIR', (reqid, target) => {
    try {
      fs.mkdir(localPath(target), (error) => {
        if (error) return fail(reqid, error)
        sftpSession.status(reqid, STATUS_CODE.OK)
      })
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('RMDIR', (reqid, target) => {
    try {
      fs.rmdir(localPath(target), (error) => {
        if (error) return fail(reqid, error)
        sftpSession.status(reqid, STATUS_CODE.OK)
      })
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('REMOVE', (reqid, target) => {
    try {
      fs.unlink(localPath(target), (error) => {
        if (error) return fail(reqid, error)
        sftpSession.status(reqid, STATUS_CODE.OK)
      })
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('RENAME', (reqid, from, to) => {
    try {
      fs.rename(localPath(from), localPath(to), (error) => {
        if (error) return fail(reqid, error)
        sftpSession.status(reqid, STATUS_CODE.OK)
      })
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('SETSTAT', (reqid) => sftpSession.status(reqid, STATUS_CODE.OK))
  sftpSession.on('READLINK', (reqid, target) => {
    try {
      fs.readlink(localPath(target), (error, link) => {
        if (error) return fail(reqid, error)
        sftpSession.name(reqid, [{ filename: String(link), longname: String(link), attrs: {} }])
      })
    } catch (error) {
      fail(reqid, error)
    }
  })

  sftpSession.on('close', () => {
    for (const state of handles.values()) {
      if (state.type === 'file') {
        try {
          fs.closeSync(state.fd)
        } catch {
          // ignore
        }
      }
    }
    handles.clear()
  })
  sftpSession.on('error', () => {})
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = await startTestServer({ port: Number(process.env.PORT) || 2222 })
  console.log(`HongSSH test SSH server ready: ssh ${server.user}@${server.host} -p ${server.port}`)
  console.log(`password: ${server.password}`)
  const shutdown = async () => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
