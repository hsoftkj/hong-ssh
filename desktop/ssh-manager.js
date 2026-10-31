'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
const { Client, utils } = require('ssh2')
const { SftpService } = require('./sftp')
const {
  INSPECTION_COMMAND,
  clampInspectionThreshold,
  parseDfOutput
} = require('./inspection')

const CONNECT_TIMEOUT_MS = 25000
const SYSTEM_INFO_COMMAND = [
  "printf '\\n__HG_OS__\\n'",
  'cat /etc/os-release 2>/dev/null',
  "printf '\\n__HG_UNAME__\\n'",
  'uname -srm 2>/dev/null',
  "printf '\\n__HG_HOST__\\n'",
  'hostname 2>/dev/null',
  "printf '\\n__HG_UPTIME__\\n'",
  'uptime -p 2>/dev/null || uptime 2>/dev/null',
  "printf '\\n__HG_CPU__\\n'",
  'nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null',
  "printf '\\n__HG_MEM__\\n'",
  "free -m 2>/dev/null | awk '/Mem:/{print $2\" \"$3}'",
  "printf '\\n__HG_IP__\\n'",
  "hostname -I 2>/dev/null || ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2; exit}'"
].join('; ')

const SYSTEM_MONITOR_COMMAND = [
  'while true; do',
  "  printf '\\n__HG_STAT_CPU__\\n'",
  '  head -n 1 /proc/stat 2>/dev/null',
  "  printf '\\n__HG_STAT_MEM__\\n'",
  "  awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{if(t) print t, a}' /proc/meminfo 2>/dev/null",
  '  sleep 1',
  'done'
].join('\n')

function basicSystemInfo(connection) {
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    ip: connection.host,
    hostname: '',
    osName: '正在获取系统信息…',
    kernel: '',
    uptime: '',
    cpuCount: 0,
    memoryTotal: 0,
    memoryUsed: 0
  }
}

function parseCpuSnapshot(line) {
  const parts = String(line || '').trim().split(/\s+/)
  if (parts.length < 5 || parts[0] !== 'cpu') return null
  const values = parts.slice(1).map((value) => Number(value)).filter(Number.isFinite)
  if (values.length < 4) return null
  const idle = values[3] + (values[4] || 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total) || total <= 0) return null
  return { idle, total }
}

function parseMemorySample(line) {
  const [totalKb, availableKb] = String(line || '')
    .trim()
    .split(/\s+/)
    .map((value) => Number(value))
  if (!Number.isFinite(totalKb) || totalKb <= 0) return null
  const total = totalKb / 1024
  const used = Math.max(0, (totalKb - (Number.isFinite(availableKb) ? availableKb : 0)) / 1024)
  return {
    memoryTotal: total,
    memoryUsed: used,
    memoryPercent: Math.min(100, Math.max(0, (used / total) * 100))
  }
}

function parseSystemInfo(output, connection) {
  const sections = new Map()
  let current = ''
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const marker = rawLine.match(/^__HG_([A-Z]+)__$/)
    if (marker) {
      current = marker[1]
      sections.set(current, [])
    } else if (current) {
      sections.get(current).push(rawLine)
    }
  }
  const get = (name) => (sections.get(name) || []).join('\n').trim()
  const osLines = get('OS').split('\n')
  const osValues = {}
  for (const line of osLines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    osValues[match[1]] = match[2].replace(/^"(.*)"$/, '$1').replace(/\\(["\\$`])/g, '$1')
  }
  const uname = get('UNAME')
  const cpuMatch = get('CPU').match(/\d+/)
  const memoryMatch = get('MEM').match(/(\d+)\s+(\d+)/)
  const ip = get('IP').split(/\s+/).filter(Boolean)[0] || connection.host
  const uptime = get('UPTIME').replace(/^up\s+/i, '').replace(/\s+/g, ' ').slice(0, 120)
  const osName =
    osValues.PRETTY_NAME ||
    [osValues.NAME, osValues.VERSION_ID].filter(Boolean).join(' ') ||
    uname.split(/\s+/).slice(0, 2).join(' ')
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    ip: ip.replace(/\/\d+$/, '').slice(0, 80),
    hostname: get('HOST').split(/\s+/)[0].slice(0, 120),
    osName: String(osName || '未知系统').slice(0, 160),
    kernel: uname.slice(0, 160),
    uptime,
    cpuCount: cpuMatch ? Number(cpuMatch[0]) : 0,
    memoryTotal: memoryMatch ? Number(memoryMatch[1]) : 0,
    memoryUsed: memoryMatch ? Number(memoryMatch[2]) : 0
  }
}

function fingerprintOf(key) {
  const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/g, '')
  return `SHA256:${digest}`
}

function keyAlgorithm(key) {
  try {
    const parsed = utils.parseKey(key)
    if (parsed && !(parsed instanceof Error) && parsed.type) return parsed.type
  } catch {
    // Raw host keys are not always parseable as private key material.
  }
  return ''
}

function expandHome(value) {
  if (!value) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function friendlyError(error, config) {
  const message = String(error?.message || error || '未知错误')
  const lower = message.toLowerCase()
  if (lower.includes('all configured authentication methods failed')) {
    return {
      code: 'AUTH_FAILED',
      message: `认证失败：用户名或密码/私钥不正确（${config.username}@${config.host}）`
    }
  }
  if (lower.includes('encrypted private key') || lower.includes('bad passphrase')) {
    return { code: 'BAD_PASSPHRASE', message: '私钥已加密，请填写正确的私钥口令' }
  }
  if (lower.includes('econnrefused') || lower.includes('connect econnrefused')) {
    return { code: 'ECONNREFUSED', message: `连接被拒绝：${config.host}:${config.port} 未开放 SSH 服务` }
  }
  if (lower.includes('etimedout') || lower.includes('timed out') || lower.includes('timeout')) {
    return { code: 'ETIMEDOUT', message: `连接超时：请检查 ${config.host}:${config.port} 和网络` }
  }
  if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
    return { code: 'ENOTFOUND', message: `无法解析主机名：${config.host}` }
  }
  if (lower.includes('ehostunreach') || lower.includes('enetunreach')) {
    return { code: 'EHOSTUNREACH', message: `网络不可达：${config.host}` }
  }
  return { code: 'CONNECT_ERROR', message }
}

class SshManager {
  constructor({ store, settings, send, logger }) {
    this.store = store
    this.send = send
    this.logger = logger
    this.sessions = new Map()
    this.closedAt = new Map()
    this.inspectionRuns = new Map()
    this.sftp = new SftpService({
      getSession: (sessionId) => this.sessions.get(sessionId),
      send,
      logger
    })
  }

  currentSettings() {
    return this.store.data.settings
  }

  open({ id, connection, password, passphrase, cols = 100, rows = 30 }) {
    if (!connection || !connection.id) throw new Error('连接配置无效')
    const sessionId =
      typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : crypto.randomUUID()
    if (this.sessions.has(sessionId)) throw new Error('会话已存在')
    const session = {
      id: sessionId,
      connection,
      secret: { password: password || '', passphrase: passphrase || '' },
      cols: clampDimension(cols, 20, 500),
      rows: clampDimension(rows, 5, 200),
      client: null,
      stream: null,
      systemMonitor: null,
      cpuSnapshot: null,
      sftpChannel: null,
      homePath: '',
      decoder: new StringDecoder('utf8'),
      status: 'connecting',
      startedAt: Date.now(),
      connectedAt: 0,
      attempts: 0,
      intentionalClose: false,
      failed: false,
      hostKeyInfo: null,
      pending: [],
      flushScheduled: false
    }
    this.sessions.set(sessionId, session)
    this.closedAt.delete(sessionId)
    setImmediate(() => this.connect(session))
    return { sessionId }
  }

  emitStatus(session, status, message, extra = {}) {
    session.status = status
    this.send('ssh:status', {
      sessionId: session.id,
      status,
      message,
      connectionId: session.connection.id,
      host: session.connection.host,
      username: session.connection.username,
      port: session.connection.port,
      ...extra
    })
  }

  enqueue(session, text) {
    if (!text) return
    session.pending.push(text)
    if (session.flushScheduled) return
    session.flushScheduled = true
    setImmediate(() => {
      session.flushScheduled = false
      if (session.pending.length === 0) return
      const data = session.pending.join('')
      session.pending.length = 0
      this.send('ssh:data', { sessionId: session.id, data })
    })
  }

  connect(session) {
    const connection = session.connection
    session.failed = false
    this.stopSystemMonitor(session)
    this.sftp.closeSession(session.id).catch(() => {})
    session.client = null
    session.stream = null
    session.sftpChannel = null
    session.decoder = new StringDecoder('utf8')
    session.emitHostKey = null
    this.emitStatus(session, session.attempts > 0 ? 'reconnecting' : 'connecting', '正在建立 SSH 连接…', {
      attempt: session.attempts
    })

    const client = new Client()
    session.client = client

    const options = {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: Math.max(0, Number(connection.keepaliveInterval) || 0) * 1000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key) => this.verifyHostKey(session, key)
    }

    if (connection.authType === 'privateKey') {
      const keyPath = expandHome(connection.privateKeyPath)
      if (!keyPath) {
        this.failBeforeConnect(session, '缺少私钥文件，请编辑连接并选择私钥')
        return
      }
      let key
      try {
        const stat = fs.statSync(keyPath)
        if (!stat.isFile()) throw new Error('不是文件')
        if (stat.size > 2 * 1024 * 1024) throw new Error('私钥文件过大')
        key = fs.readFileSync(keyPath)
      } catch (error) {
        this.failBeforeConnect(session, `无法读取私钥：${error.message}`)
        return
      }
      options.privateKey = key
      if (session.secret.passphrase) options.passphrase = session.secret.passphrase
    } else if (connection.authType === 'agent') {
      options.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK || 'pageant'
    } else {
      options.password = session.secret.password
      if (!options.password) {
        this.failBeforeConnect(session, '需要密码：请双击连接并输入登录密码')
        return
      }
    }

    client.on('banner', (message) => {
      this.logger?.info('ssh banner', { sessionId: session.id, message: String(message).trim() })
    })

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      if (connection.authType === 'password' && session.secret.password) {
        finish(prompts.map(() => session.secret.password))
      } else {
        finish(prompts.map(() => ''))
      }
    })

    client.on('ready', () => {
      if (session.intentionalClose) return
      this.emitStatus(session, 'opening-shell', '认证成功，正在打开终端…')
      this.openShell(session)
    })

    client.on('error', (error) => {
      if (session.intentionalClose) return
      const friendly = friendlyError(error, connection)
      this.logger?.warn('ssh error', {
        sessionId: session.id,
        host: connection.host,
        code: friendly.code,
        message: friendly.message
      })
      if (session.hostKeyError) {
        this.failSession(session, session.hostKeyError.code, session.hostKeyError.message)
      } else {
        this.failSession(session, friendly.code, friendly.message)
      }
    })

    client.on('close', () => {
      if (session.stream) {
        // The stream close handler owns the state transition.
        return
      }
      if (session.intentionalClose) {
        this.emitStatus(session, 'disconnected', '连接已断开')
        this.send('ssh:closed', { sessionId: session.id, reason: 'closed' })
        return
      }
      if (session.failed) return
      this.handleUnexpectedClose(session, '连接已关闭')
    })

    client.on('end', () => {
      if (!session.failed && !session.intentionalClose && session.status === 'connected') {
        this.emitStatus(session, 'disconnected', '远端已结束连接', { reconnecting: false })
      }
    })

    try {
      client.connect(options)
    } catch (error) {
      this.failSession(session, 'CONNECT_ERROR', error.message)
    }
  }

  verifyHostKey(session, key) {
    const connection = session.connection
    const fingerprint = fingerprintOf(key)
    const algorithm = keyAlgorithm(key)
    const hostKey = `${connection.host}:${connection.port}`
    const known = this.store.checkKnownHost(hostKey)
    const policy = connection.hostKeyPolicy || 'accept-new'
    session.hostKeyInfo = { fingerprint, algorithm, hostKey }

    if (!known) {
      if (policy === 'strict') {
        session.hostKeyError = {
          code: 'HOST_KEY_UNKNOWN',
          message: `首次连接 ${hostKey}，主机密钥未受信任（${fingerprint}）。当前连接使用“严格”策略，请编辑连接并将主机密钥策略改为“接受新主机”，或先删除该主机的旧记录。`
        }
        return false
      }
      if (policy !== 'insecure') {
        this.store.addKnownHost(hostKey, fingerprint, algorithm)
        this.send('ssh:hostkey', {
          sessionId: session.id,
          hostKey,
          fingerprint,
          algorithm,
          status: 'new'
        })
      }
      return true
    }

    if (known.fingerprint !== fingerprint) {
      if (policy === 'insecure') {
        this.store.addKnownHost(hostKey, fingerprint, algorithm)
        return true
      }
      session.hostKeyError = {
        code: 'HOST_KEY_CHANGED',
        message: `警告：${hostKey} 的主机密钥已变更！\n旧指纹：${known.fingerprint}\n新指纹：${fingerprint}\n如果服务器确实重装过，请在“设置 → 安全”中删除该主机的记录后重试。`
      }
      return false
    }
    return true
  }

  openShell(session) {
    const connection = session.connection
    const term = connection.terminalType || 'xterm-256color'
    const client = session.client
    if (!client) return
    try {
      client.shell(
        { term, cols: session.cols, rows: session.rows, width: 0, height: 0 },
        { env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'HongSSH' } },
        (error, stream) => {
          if (error) {
            this.failSession(session, 'SHELL_FAILED', `无法打开终端：${error.message}`)
            return
          }
          if (session.intentionalClose) {
            stream.end()
            return
          }
          session.stream = stream
          session.status = 'connected'
          session.connectedAt = Date.now()
          session.attempts = 0
          session.decoder = new StringDecoder('utf8')
          this.store.touchConnection(connection.id)
          this.emitStatus(session, 'connected', '已连接', {
            fingerprint: session.hostKeyInfo?.fingerprint || ''
          })
          this.send('ssh:system-info', {
            sessionId: session.id,
            info: basicSystemInfo(session.connection)
          })
          this.collectSystemInfo(session)
          this.startSystemMonitor(session)

          stream.on('data', (chunk) => {
            this.enqueue(session, session.decoder.write(chunk))
          })
          if (stream.stderr) {
            stream.stderr.on('data', (chunk) => {
              this.enqueue(session, session.decoder.write(chunk))
            })
          }
          stream.on('close', () => {
            const tail = session.decoder.end()
            if (tail) this.enqueue(session, tail)
            session.stream = null
            if (session.intentionalClose) {
              this.emitStatus(session, 'disconnected', '连接已断开')
              this.send('ssh:closed', { sessionId: session.id, reason: 'closed' })
            } else {
              this.handleUnexpectedClose(session, '终端会话已结束')
            }
          })
          stream.on('error', (streamError) => {
            this.logger?.warn('shell stream error', {
              sessionId: session.id,
              message: streamError.message
            })
          })

          stream.setWindow(session.rows, session.cols, 0, 0)

          if (connection.initCommand) {
            const command = connection.initCommand
            setTimeout(() => {
              if (session.stream === stream && !session.intentionalClose) {
                try {
                  stream.write(`${command}\r`)
                } catch {
                  // The session may have closed in the meantime.
                }
              }
            }, 500)
          }
        }
      )
    } catch (error) {
      this.failSession(session, 'SHELL_FAILED', `无法打开终端：${error.message}`)
    }
  }

  failBeforeConnect(session, message) {
    this.failSession(session, 'CONFIG_ERROR', message)
  }

  startSystemMonitor(session) {
    if (session.systemMonitor || !session.client || session.intentionalClose) return
    session.cpuSnapshot = null
    try {
      session.client.exec(SYSTEM_MONITOR_COMMAND, (error, stream) => {
        if (error) {
          this.logger?.warn('system monitor failed', {
            sessionId: session.id,
            message: error.message
          })
          return
        }
        if (session.intentionalClose || this.sessions.get(session.id) !== session) {
          try {
            stream.close()
          } catch {}
          return
        }
        session.systemMonitor = stream
        let buffer = ''
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          buffer = this.consumeSystemStats(session, buffer)
        })
        stream.stderr?.on('data', () => {})
        stream.on('close', () => {
          if (session.systemMonitor === stream) session.systemMonitor = null
          session.cpuSnapshot = null
        })
        stream.on('error', () => {
          if (session.systemMonitor === stream) session.systemMonitor = null
          session.cpuSnapshot = null
        })
      })
    } catch (error) {
      this.logger?.warn('system monitor could not start', {
        sessionId: session.id,
        message: error.message
      })
    }
  }

  stopSystemMonitor(session) {
    const stream = session.systemMonitor
    session.systemMonitor = null
    session.cpuSnapshot = null
    try {
      stream?.close()
    } catch {}
  }

  consumeSystemStats(session, buffer) {
    const pattern = /__HG_STAT_CPU__\r?\n([^\r\n]*)\r?\n__HG_STAT_MEM__\r?\n([^\r\n]*)/g
    let match = null
    let consumed = 0
    while ((match = pattern.exec(buffer))) {
      consumed = pattern.lastIndex
      this.handleSystemSample(session, match[1], match[2])
    }
    let remaining = consumed > 0 ? buffer.slice(consumed) : buffer
    if (remaining.length > 16384) remaining = remaining.slice(-8192)
    return remaining
  }

  handleSystemSample(session, cpuLine, memoryLine) {
    const stats = {
      cpuPercent: null,
      memoryPercent: 0,
      memoryUsed: 0,
      memoryTotal: 0
    }
    const snapshot = parseCpuSnapshot(cpuLine)
    if (snapshot) {
      const previous = session.cpuSnapshot
      session.cpuSnapshot = snapshot
      if (previous && snapshot.total > previous.total) {
        const totalDelta = snapshot.total - previous.total
        const idleDelta = Math.max(0, snapshot.idle - previous.idle)
        stats.cpuPercent = Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100))
      }
    }
    const memory = parseMemorySample(memoryLine)
    if (memory) {
      stats.memoryPercent = memory.memoryPercent
      stats.memoryUsed = memory.memoryUsed
      stats.memoryTotal = memory.memoryTotal
    }
    if (stats.cpuPercent === null && stats.memoryTotal === 0) return
    this.send('ssh:system-stats', {
      sessionId: session.id,
      stats
    })
  }

  collectSystemInfo(session) {    const client = session.client
    if (!client) return
    let settled = false
    let output = ''
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (this.sessions.get(session.id) !== session || session.intentionalClose) return
      if (!output.trim()) {
        this.send('ssh:system-info', {
          sessionId: session.id,
          info: { ...basicSystemInfo(session.connection), osName: '未知系统' }
        })
        return
      }
      this.send('ssh:system-info', {
        sessionId: session.id,
        info: parseSystemInfo(output, session.connection)
      })
    }
    const timer = setTimeout(finish, 6000)
    try {
      client.exec(SYSTEM_INFO_COMMAND, (error, stream) => {
        if (error) {
          finish()
          return
        }
        stream.on('data', (chunk) => {
          if (output.length < 256 * 1024) output += chunk.toString('utf8')
        })
        stream.stderr?.on('data', () => {})
        stream.on('close', finish)
        stream.on('error', finish)
      })
    } catch {
      finish()
    }
  }

  failSession(session, code, message) {
    if (session.failed) return
    session.failed = true
    this.sftp.closeSession(session.id).catch(() => {})
    this.emitStatus(session, 'error', message, { code })
    try {
      session.client?.end()
    } catch {
      // ignore
    }
    this.send('ssh:closed', { sessionId: session.id, reason: 'error', code, message })
  }

  handleUnexpectedClose(session, message) {
    if (session.failed) return
    this.sftp.closeSession(session.id).catch(() => {})
    if (session.intentionalClose) {
      this.emitStatus(session, 'disconnected', '连接已断开')
      this.send('ssh:closed', { sessionId: session.id, reason: 'closed' })
      return
    }
    const settings = this.currentSettings()
    const canRetry =
      settings.autoReconnect &&
      session.connectedAt > 0 &&
      session.attempts < Math.max(1, Number(settings.autoReconnectAttempts) || 3)
    if (canRetry) {
      session.attempts += 1
      this.emitStatus(session, 'reconnecting', `连接中断，正在第 ${session.attempts} 次重连…`, {
        attempt: session.attempts
      })
      try {
        session.client?.end()
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (this.sessions.has(session.id) && !session.intentionalClose) this.connect(session)
      }, session.attempts * 1200)
      return
    }
    this.emitStatus(session, 'disconnected', message)
    this.send('ssh:closed', {
      sessionId: session.id,
      reason: 'closed',
      reconnectable: session.connectedAt > 0
    })
    session.connectedAt = 0
  }

  runInspection(payload = {}) {
    const runId =
      typeof payload.runId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(payload.runId)
        ? payload.runId
        : crypto.randomUUID()
    if (this.inspectionRuns.has(runId)) throw new Error('巡检任务已存在')
    const threshold = clampInspectionThreshold(payload.threshold)
    const rawIds = Array.isArray(payload.connectionIds) ? payload.connectionIds : []
    const connections = []
    const seen = new Set()
    for (const rawId of rawIds) {
      const id = String(rawId || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      const connection = this.store.getConnection(id)
      if (connection) connections.push(connection)
    }
    const run = {
      runId,
      threshold,
      aborted: false,
      clients: new Set(),
      streams: new Set(),
      startedAt: Date.now(),
      total: connections.length
    }
    this.inspectionRuns.set(runId, run)
    return this.executeInspection(connections, run).finally(() => {
      this.inspectionRuns.delete(runId)
    })
  }

  cancelInspection(runId) {
    const run = this.inspectionRuns.get(String(runId || ''))
    if (!run) return false
    run.aborted = true
    for (const stream of run.streams) {
      try {
        stream.close()
      } catch {
        // The channel may already be closed.
      }
    }
    run.streams.clear()
    for (const client of run.clients) {
      try {
        client.end()
      } catch {
        // The client may already be closed.
      }
    }
    run.clients.clear()
    return true
  }

  async executeInspection(connections, run) {
    const results = new Array(connections.length)
    let cursor = 0
    const workerCount = Math.min(6, connections.length)
    const worker = async () => {
      while (!run.aborted) {
        const index = cursor
        cursor += 1
        if (index >= connections.length) return
        const result = await this.inspectConnection(connections[index], run)
        if (!result) continue
        results[index] = result
        if (run.aborted) continue
        this.send('inspection:progress', {
          runId: run.runId,
          index,
          total: connections.length,
          result
        })
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return {
      runId: run.runId,
      threshold: run.threshold,
      aborted: run.aborted,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      total: connections.length,
      results: results.filter(Boolean)
    }
  }

  connectedSessionFor(connectionId) {
    for (const session of this.sessions.values()) {
      if (
        session.connection.id === connectionId &&
        session.status === 'connected' &&
        session.client &&
        !session.intentionalClose
      ) {
        return session
      }
    }
    return null
  }

  /**
   * Runs `df` against one configured connection. An already-open session is
   * reused so passwords typed for that session do not need to be stored; other
   * hosts get a short-lived SSH connection with the saved credentials.
   */
  inspectConnection(connection, run) {
    const started = Date.now()
    const base = {
      connectionId: connection.id,
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      protocol: connection.protocol,
      status: 'ok',
      message: '',
      disks: [],
      alerts: [],
      elapsed: 0
    }
    if (connection.protocol !== 'ssh') {
      return Promise.resolve({
        ...base,
        status: 'skipped',
        message: '远程桌面连接不支持磁盘巡检'
      })
    }

    const existingSession = this.connectedSessionFor(connection.id)
    const savedPassword =
      connection.authType === 'password' ? this.store.getSecret(connection.id, 'password') : ''
    const savedPassphrase =
      connection.authType === 'privateKey'
        ? this.store.getSecret(connection.id, 'passphrase')
        : ''
    if (!existingSession && connection.authType === 'password' && !savedPassword) {
      return Promise.resolve({
        ...base,
        status: 'error',
        message: '未保存登录密码，请先手动连接并勾选“记住密码”'
      })
    }

    return new Promise((resolve) => {
      let client = existingSession?.client || null
      let ownsClient = false
      let settled = false
      let timer = null
      let stream = null
      let hostKeyError = ''

      const finish = (patch) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (stream) {
          run.streams.delete(stream)
          try {
            stream.close()
          } catch {
            // The channel may already be closed.
          }
        }
        if (ownsClient && client) {
          try {
            client.end()
          } catch {
            // The client may already be closed.
          }
        }
        if (client) run.clients.delete(client)
        resolve({ ...base, ...patch, elapsed: Date.now() - started })
      }

      const fail = (message) => finish({ status: 'error', message })
      const runCommand = () => {
        try {
          client.exec(INSPECTION_COMMAND, (error, execStream) => {
            if (settled) {
              try {
                execStream?.close()
              } catch {}
              return
            }
            if (error) {
              fail(`无法执行巡检命令：${error.message}`)
              return
            }
            stream = execStream
            run.streams.add(execStream)
            let output = ''
            execStream.on('data', (chunk) => {
              if (output.length < 512 * 1024) output += chunk.toString('utf8')
            })
            execStream.stderr?.on('data', () => {})
            execStream.on('close', () => {
              if (settled) return
              if (run.aborted) {
                finish({ status: 'error', message: '巡检已取消' })
                return
              }
              const disks = parseDfOutput(output)
              if (disks.length === 0) {
                fail('未读取到磁盘信息：服务器可能不支持 df 命令，或没有可用挂载点')
                return
              }
              const alerts = disks.filter((disk) => disk.usagePercent >= run.threshold)
              finish({
                status: alerts.length > 0 ? 'alert' : 'ok',
                message:
                  alerts.length > 0
                    ? `${alerts.length} 个挂载点使用率达到 ${run.threshold}%`
                    : `所有挂载点使用率低于 ${run.threshold}%`,
                disks,
                alerts
              })
            })
            execStream.on('error', (streamError) => fail(streamError.message))
          })
        } catch (error) {
          fail(error.message)
        }
      }

      timer = setTimeout(() => fail('巡检超时（15 秒），请检查网络或 SSH 服务'), 15000)

      if (client) {
        runCommand()
        return
      }

      client = new Client()
      ownsClient = true
      run.clients.add(client)

      const options = {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        readyTimeout: 10000,
        keepaliveInterval: 5000,
        keepaliveCountMax: 1,
        tryKeyboard: true,
        hostVerifier: (key) => {
          const hostKey = `${connection.host}:${connection.port}`
          const fingerprint = fingerprintOf(key)
          const known = this.store.checkKnownHost(hostKey)
          const policy = connection.hostKeyPolicy || 'accept-new'
          if (!known) {
            if (policy === 'strict') {
              hostKeyError = `主机密钥未受信任：${hostKey}（${fingerprint}）`
              return false
            }
            if (policy !== 'insecure') {
              this.store.addKnownHost(hostKey, fingerprint, keyAlgorithm(key))
            }
            return true
          }
          if (known.fingerprint !== fingerprint) {
            if (policy === 'insecure') {
              this.store.addKnownHost(hostKey, fingerprint, keyAlgorithm(key))
              return true
            }
            hostKeyError = `主机密钥已变更：${hostKey}，请先在“设置 → 安全”中确认或删除旧记录`
            return false
          }
          return true
        }
      }

      if (connection.authType === 'privateKey') {
        try {
          options.privateKey = fs.readFileSync(expandHome(connection.privateKeyPath))
        } catch (error) {
          fail(`无法读取私钥：${error.message}`)
          return
        }
        if (savedPassphrase) options.passphrase = savedPassphrase
      } else if (connection.authType === 'agent') {
        options.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK || 'pageant'
      } else {
        options.password = savedPassword
      }

      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
        done(prompts.map(() => savedPassword))
      })
      client.on('ready', () => {
        if (settled) return
        runCommand()
      })
      client.on('error', (error) => {
        if (settled) return
        fail(hostKeyError || friendlyError(error, connection).message)
      })
      client.on('close', () => {
        if (settled) return
        fail(hostKeyError || '连接被服务器关闭')
      })

      try {
        client.connect(options)
      } catch (error) {
        fail(error.message)
      }
    })
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId)
    if (!session || !session.stream) return false
    if (typeof data !== 'string' || data.length > 1024 * 1024) return false
    try {
      session.stream.write(data)
      return true
    } catch (error) {
      this.logger?.warn('write failed', { sessionId, message: error.message })
      return false
    }
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.cols = clampDimension(cols, 20, 500)
    session.rows = clampDimension(rows, 5, 200)
    if (!session.stream) return false
    try {
      session.stream.setWindow(session.rows, session.cols, 0, 0)
      return true
    } catch {
      return false
    }
  }

  reconnect(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已关闭')
    this.sftp.closeSession(sessionId).catch(() => {})
    session.intentionalClose = false
    session.failed = false
    session.attempts = 0
    session.connectedAt = 0
    session.sftpChannel = null
    try {
      session.stream?.end()
    } catch {}
    try {
      session.client?.end()
    } catch {}
    session.stream = null
    session.client = null
    this.connect(session)
    return { sessionId }
  }

  disconnect(sessionId, options = {}) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.stopSystemMonitor(session)
    this.sftp.closeSession(sessionId).catch(() => {})
    session.intentionalClose = true
    try {
      session.stream?.end()
    } catch {}
    try {
      session.client?.end()
    } catch {}
    session.stream = null
    session.client = null
    session.sftpChannel = null
    if (options.destroy) {
      this.sessions.delete(sessionId)
      this.closedAt.set(sessionId, Date.now())
      for (const [id, time] of this.closedAt) {
        if (Date.now() - time > 60_000) this.closedAt.delete(id)
      }
    } else {
      this.emitStatus(session, 'disconnected', '连接已断开')
    }
  }

  destroy(sessionId) {
    this.disconnect(sessionId, { destroy: true })
  }

  closeAll() {
    for (const run of this.inspectionRuns.values()) {
      run.aborted = true
      for (const stream of run.streams) {
        try {
          stream.close()
        } catch {}
      }
      run.streams.clear()
      for (const client of run.clients) {
        try {
          client.end()
        } catch {}
      }
      run.clients.clear()
    }
    this.inspectionRuns.clear()
    this.sftp.closeAll()
    for (const id of [...this.sessions.keys()]) this.disconnect(id, { destroy: true })
  }

  activeCount() {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.intentionalClose) continue
      if (
        session.status === 'connecting' ||
        session.status === 'opening-shell' ||
        session.status === 'connected' ||
        session.status === 'reconnecting'
      ) {
        count += 1
      }
    }
    return count
  }
}

function clampDimension(value, min, max) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}

/**
 * Standalone connectivity check used by the connection editor. It verifies
 * authentication and, when the server allows it, executes a harmless command.
 * Host keys are intentionally accepted here (the real session applies the
 * configured policy) and the fingerprint is returned for display.
 */
function testConnection(connection, secret = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let fingerprint = ''
    const client = new Client()
    const timer = setTimeout(() => finish({ ok: false, message: '连接超时（25 秒）' }), 25000)
    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client.end()
      } catch {}
      resolve({ ...result, elapsed: Date.now() - started })
    }

    const options = {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 5000,
      keepaliveCountMax: 1,
      tryKeyboard: true,
      hostVerifier: (key) => {
        fingerprint = fingerprintOf(key)
        return true
      }
    }
    if (connection.authType === 'privateKey') {
      try {
        options.privateKey = fs.readFileSync(expandHome(connection.privateKeyPath))
      } catch (error) {
        return finish({ ok: false, message: `无法读取私钥：${error.message}` })
      }
      if (secret.passphrase) options.passphrase = secret.passphrase
    } else if (connection.authType === 'agent') {
      options.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK || 'pageant'
    } else {
      options.password = secret.password || ''
      if (!options.password) return finish({ ok: false, message: '请先填写密码' })
    }

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
      done(prompts.map(() => options.password || ''))
    })
    client.on('ready', () => {
      try {
        client.exec('printf HONGSSH_OK', (error, stream) => {
          if (error) {
            finish({ ok: true, message: '认证成功（服务器不支持 exec 测试）', fingerprint })
            return
          }
          let output = ''
          stream.on('data', (chunk) => {
            output += chunk.toString('utf8')
          })
          stream.stderr.on('data', () => {})
          stream.on('close', () => {
            if (output.includes('HONGSSH_OK')) {
              finish({ ok: true, message: '连接成功', fingerprint })
            } else {
              finish({ ok: true, message: '认证成功', fingerprint })
            }
          })
          stream.on('error', () => {
            finish({ ok: true, message: '认证成功', fingerprint })
          })
        })
      } catch (error) {
        finish({ ok: false, message: error.message, fingerprint })
      }
    })
    client.on('error', (error) => {
      finish({ ok: false, message: friendlyError(error, connection).message, fingerprint })
    })
    client.on('close', () => {
      finish({ ok: false, message: '连接被服务器关闭', fingerprint })
    })
    try {
      client.connect(options)
    } catch (error) {
      finish({ ok: false, message: error.message, fingerprint })
    }
  })
}

module.exports = { SshManager, testConnection, fingerprintOf }
