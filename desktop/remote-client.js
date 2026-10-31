'use strict'

const { EventEmitter } = require('node:events')

const { encodeMessage, createParser } = require('./remote-wire')

class RemoteClient extends EventEmitter {
  constructor() {
    super()
    this.ws = null
    this.connected = false
    this.welcome = null
    this.heartbeat = null
    this.pendingAuth = null
    this.pendingTimer = null
  }

  connect(options) {
    if (this.ws) this.close()
    const host = String(options.host || '')
    const port = Number(options.port) || 47890
    const password = String(options.password || '')
    this.emit('status', { state: 'connecting', host, port })
    return new Promise((resolve, reject) => {
      let settled = false
      this.pendingAuth = { resolve, reject }
      const ws = options.socket
      if (!ws) {
        this.pendingAuth = null
        reject(new Error('缺少 WebRTC 数据通道'))
        return
      }
      this.ws = ws
      this.pendingTimer = setTimeout(() => {
        if (settled) return
        settled = true
        this.pendingAuth = null
        try {
          ws.close()
        } catch {}
        reject(new Error('连接远程主机超时'))
      }, 12000)

      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(this.pendingTimer)
        this.pendingTimer = null
        this.pendingAuth = null
        if (error) reject(error)
        else resolve(value)
      }

      const sendAuth = () => {
        const refreshMs = Math.min(2000, Math.max(50, Number(options.refreshMs) || 200))
        this.send({
          type: 'auth',
          password,
          refreshMs,
          fps: Math.round(1000 / refreshMs),
          quality: Number(options.quality) || 62
        })
      }

      ws.on('open', () => {
        sendAuth()
      })
      ws.on('message', (data) => {
        try {
          parser(data)
        } catch (error) {
          this.emit('error', error)
          this.close()
        }
      })
      ws.on('close', (code, reason) => {
        const text = reason?.toString?.() || ''
        this.connected = false
        this.clearHeartbeat()
        if (!settled) {
          finish(new Error(text || `远程主机关闭了连接 (${code})`))
        }
        this.emit('status', { state: 'closed', code, reason: text })
        this.emit('closed', { code, reason: text })
      })
      ws.on('error', (error) => {
        this.emit('status', { state: 'error', message: error.message })
        if (!settled) finish(new Error(`无法连接远程主机：${error.message}`))
      })

      const parser = createParser((message, payload) => {
        if (message.type === 'welcome') {
          this.connected = true
          this.welcome = message
          finish(null, message)
          this.emit('welcome', message)
          this.startHeartbeat()
          this.emit('status', { state: 'connected', host, port })
          return
        }
        if (message.type === 'frame') {
          this.emit('frame', message, payload)
          return
        }
        if (message.type === 'cursor') {
          this.emit('cursor', message)
          return
        }
        if (message.type === 'pong') {
          this.lastPong = Date.now()
          return
        }
        if (message.type === 'error') {
          this.emit('remote-error', message.message || '远程主机返回错误')
          return
        }
        this.emit('message', message, payload)
      })

      // WebRTC DataChannel adapters are already open before connect() is called.
      if (ws.readyState === ws.OPEN) sendAuth()
    })
  }

  send(message, payload) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return false
    try {
      this.ws.send(encodeMessage(message, payload))
      return true
    } catch {
      return false
    }
  }

  setStream(refreshMs, quality) {
    const interval = Math.min(2000, Math.max(50, Number(refreshMs) || 200))
    this.send({
      type: 'stream',
      refreshMs: interval,
      intervalMs: interval,
      fps: Math.round(1000 / interval),
      quality
    })
  }

  setDisplay(displayId) {
    this.send({ type: 'display', displayId: String(displayId) })
  }

  mouse(message) {
    this.send({ type: 'mouse', ...message })
  }

  key(message) {
    this.send({ type: 'key', ...message })
  }

  startHeartbeat() {
    this.clearHeartbeat()
    this.lastPong = Date.now()
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
      if (Date.now() - this.lastPong > 20000) {
        this.emit('remote-error', '远程主机心跳超时')
        this.close()
        return
      }
      this.send({ type: 'ping', time: Date.now() })
    }, 5000)
  }

  clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  close() {
    this.clearHeartbeat()
    this.connected = false
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      try {
        ws.close()
      } catch {}
    }
  }
}

module.exports = { RemoteClient }
