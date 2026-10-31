'use strict'

const { EventEmitter } = require('node:events')
const WebSocket = require('ws')
const { RTCPeerConnection } = require('werift')

function signalUrl(base, params) {
  let url
  try {
    url = new URL(String(base || ''))
  } catch {
    throw new Error('中继地址无效，请填写 wss://服务器 或 https://服务器')
  }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('中继地址必须使用 ws://、wss://、http:// 或 https://')
  }
  let path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/signal')) path += '/signal'
  url.pathname = path
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function parseJson(data) {
  try {
    return JSON.parse(String(data))
  } catch {
    return null
  }
}

class DataChannelSocket extends EventEmitter {
  constructor(channel) {
    super()
    this.channel = channel
    this.OPEN = 1
    this.CLOSED = 3
    this.readyState = 1
    this.closed = false
    channel.onmessage = (event) => {
      if (this.closed) return
      const value = event?.data
      let data
      if (Buffer.isBuffer(value)) data = value
      else if (value instanceof ArrayBuffer) data = Buffer.from(value)
      else if (ArrayBuffer.isView(value)) data = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      else data = Buffer.from(String(value ?? ''))
      this.acceptChunk(data)
    }
    channel.onclose = () => this.finish()
    channel.onerror = (error) => {
      this.emit('error', error instanceof Error ? error : new Error('WebRTC DataChannel 错误'))
      this.finish()
    }
  }

  get bufferedAmount() {
    return Number(this.channel?.bufferedAmount) || 0
  }

  acceptChunk(data) {
    if (data.length < 8) return
    const total = data.readUInt32BE(0)
    const offset = data.readUInt32BE(4)
    if (!Number.isFinite(total) || total <= 0 || total > 16 * 1024 * 1024) return
    if (!this.incoming || this.incoming.total !== total || offset === 0) {
      this.incoming = { total, data: Buffer.allocUnsafe(total), received: 0 }
    }
    const payload = data.subarray(8)
    if (offset + payload.length > total) {
      this.incoming = null
      return
    }
    payload.copy(this.incoming.data, offset)
    this.incoming.received += payload.length
    if (this.incoming.received >= total) {
      const message = this.incoming.data
      this.incoming = null
      this.emit('message', message)
    }
  }

  send(data) {
    if (this.closed || this.readyState !== 1) return false
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buffer.length === 0) return false
    const chunkSize = 32 * 1024
    try {
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const part = buffer.subarray(offset, Math.min(buffer.length, offset + chunkSize))
        const packet = Buffer.allocUnsafe(8 + part.length)
        packet.writeUInt32BE(buffer.length, 0)
        packet.writeUInt32BE(offset, 4)
        part.copy(packet, 8)
        this.channel.send(packet)
      }
      return true
    } catch {
      return false
    }
  }

  close() {
    if (this.closed) return
    try {
      this.channel.close()
    } catch {}
    this.finish()
  }

  finish() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.emit('close', 1000, 'datachannel closed')
  }
}

class WebRtcHostAgent extends EventEmitter {
  constructor(options) {
    super()
    this.url = options.url
    this.deviceId = String(options.deviceId || '')
    this.token = String(options.token || '')
    this.host = options.host
    this.logger = options.logger
    this.onStatus = options.onStatus
    this.running = false
    this.control = null
    this.reconnectTimer = null
    this.session = null
  }

  start() {
    if (this.running) return
    this.running = true
    this.connectControl()
  }

  stop() {
    this.running = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.closePeer()
    if (this.control) {
      try {
        this.control.close()
      } catch {}
    }
    this.control = null
    this.emitStatus('stopped')
  }

  emitStatus(state, detail) {
    try {
      this.onStatus?.({ state, detail, deviceId: this.deviceId })
    } catch {}
  }

  connectControl() {
    if (!this.running) return
    let ws
    try {
      ws = new WebSocket(signalUrl(this.url, { role: 'host', device: this.deviceId }), {
        headers: { 'x-relay-token': this.token },
        rejectUnauthorized: false,
        handshakeTimeout: 10000,
        perMessageDeflate: false
      })
    } catch (error) {
      this.logger?.warn('webrtc relay connect failed', error)
      this.scheduleReconnect()
      return
    }
    this.control = ws
    this.emitStatus('connecting')
    ws.on('open', () => this.emitStatus('signaling'))
    ws.on('message', (data) => {
      const message = parseJson(data)
      if (!message) return
      if (message.type === 'registered') {
        this.logger?.info('webrtc relay registered', { deviceId: this.deviceId })
        this.emitStatus('online')
        return
      }
      if (message.type === 'peer') {
        this.startPeer(message.sessionId, message.iceServers)
        return
      }
      if (message.type === 'peer-closed') {
        this.logger?.info('webrtc relay peer closed', { deviceId: this.deviceId })
      }
    })
    ws.on('close', () => {
      if (this.control === ws) this.control = null
      if (!this.running) return
      this.emitStatus('offline')
      this.scheduleReconnect()
    })
    ws.on('error', (error) => {
      this.logger?.warn('webrtc relay signaling error', error)
    })
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectControl()
    }, 4000)
  }

  startPeer(sessionId, iceServers) {
    this.closePeer()
    let pc
    let channel
    let sessionWs
    let socket
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      try {
        socket?.close()
      } catch {}
      try {
        channel?.close()
      } catch {}
      try {
        pc?.close()
      } catch {}
      try {
        sessionWs?.close()
      } catch {}
      if (this.session?.sessionId === sessionId) this.session = null
    }
    try {
      sessionWs = new WebSocket(
        signalUrl(this.url, {
          role: 'agent-session',
          device: this.deviceId,
          session: sessionId
        }),
        {
          headers: { 'x-relay-token': this.token },
          rejectUnauthorized: false,
          handshakeTimeout: 10000,
          perMessageDeflate: false
        }
      )
      pc = new RTCPeerConnection({ iceServers: Array.isArray(iceServers) ? iceServers : [] })
      channel = pc.createDataChannel('hongssh', { ordered: true })
      this.session = { sessionId, close }
      this.emitStatus('pairing')
      pc.onicecandidate = (event) => {
        if (!event.candidate || sessionWs.readyState !== WebSocket.OPEN) return
        try {
          sessionWs.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
        } catch {}
      }
      channel.onopen = () => {
        if (closed) return
        socket = new DataChannelSocket(channel)
        this.logger?.info('webrtc host data channel open', { sessionId })
        this.emitStatus('connected')
        try {
          this.host.attachClient(socket, 'webrtc')
        } catch (error) {
          this.logger?.warn('could not attach webrtc host client', error)
          close()
        }
      }
      channel.onclose = close
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) close()
      }
      let remoteSet = false
      const pendingCandidates = []
      sessionWs.on('message', async (data) => {
        const message = parseJson(data)
        if (!message) return
        try {
          if (message.type === 'answer' && message.description) {
            await pc.setRemoteDescription(message.description)
            remoteSet = true
            for (const candidate of pendingCandidates.splice(0)) {
              await pc.addIceCandidate(candidate)
            }
          } else if (message.type === 'candidate' && message.candidate) {
            if (remoteSet) await pc.addIceCandidate(message.candidate)
            else pendingCandidates.push(message.candidate)
          } else if (message.type === 'bye') {
            close()
          }
        } catch (error) {
          this.logger?.warn('webrtc host signaling failed', error)
          close()
        }
      })
      sessionWs.on('open', async () => {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sessionWs.send(JSON.stringify({ type: 'offer', description: pc.localDescription }))
        } catch (error) {
          this.logger?.warn('webrtc host offer failed', error)
          close()
        }
      })
      sessionWs.on('close', close)
      sessionWs.on('error', (error) => this.logger?.warn('webrtc host session error', error))
    } catch (error) {
      this.logger?.warn('webrtc host peer failed', error)
      close()
    }
  }

  closePeer() {
    if (this.session) {
      try {
        this.session.close()
      } catch {}
      this.session = null
    }
  }
}

class WebRtcController {
  constructor(options = {}) {
    this.url = options.url
    this.deviceId = String(options.deviceId || '')
    this.logger = options.logger
    this.ws = null
    this.pc = null
    this.channel = null
    this.closed = false
  }

  connect(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let settled = false
      let pc = null
      let pendingCandidates = []
      let remoteSet = false
      let ws
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          this.close()
          reject(error)
        } else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('WebRTC 连接超时')), timeoutMs)
      try {
        ws = new WebSocket(signalUrl(this.url, { role: 'control', device: this.deviceId }), {
          rejectUnauthorized: false,
          handshakeTimeout: 10000,
          perMessageDeflate: false
        })
      } catch (error) {
        finish(error)
        return
      }
      this.ws = ws
      const createPeer = (iceServers) => {
        if (pc) return pc
        pc = new RTCPeerConnection({
          iceServers: Array.isArray(iceServers) ? iceServers : []
        })
        this.pc = pc
        pc.ondatachannel = (event) => {
          this.channel = event.channel
          event.channel.onopen = () => {
            if (settled) return
            const socket = new DataChannelSocket(event.channel)
            // Give the remote side a moment to attach its protocol handler
            // after its own DataChannel onopen callback fires.
            setTimeout(() => {
              if (!settled) finish(null, socket)
            }, 180)
          }
          event.channel.onclose = () => {
            if (!settled) finish(new Error('WebRTC 数据通道已关闭'))
          }
        }
        pc.onicecandidate = (event) => {
          if (!event.candidate || ws.readyState !== WebSocket.OPEN) return
          try {
            ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
          } catch {}
        }
        pc.onconnectionstatechange = () => {
          if (['failed', 'closed'].includes(pc.connectionState) && !settled) {
            finish(new Error('WebRTC 连接失败'))
          }
        }
        return pc
      }
      ws.on('message', async (data) => {
        const message = parseJson(data)
        if (!message) return
        try {
          if (message.type === 'peer-ready') {
            createPeer(message.iceServers)
          } else if (message.type === 'offer' && message.description) {
            createPeer([])
            await pc.setRemoteDescription(message.description)
            remoteSet = true
            for (const candidate of pendingCandidates.splice(0)) {
              await pc.addIceCandidate(candidate)
            }
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            ws.send(JSON.stringify({ type: 'answer', description: pc.localDescription }))
          } else if (message.type === 'candidate' && message.candidate) {
            if (remoteSet) await pc.addIceCandidate(message.candidate)
            else pendingCandidates.push(message.candidate)
          } else if (message.type === 'bye') {
            finish(new Error('对方已断开中继会话'))
          }
        } catch (error) {
          finish(error)
        }
      })
      ws.on('close', (code, reason) => {
        if (settled) return
        const text = reason?.toString?.() || ''
        finish(new Error(text || `中继服务器关闭了连接 (${code})`))
      })
      ws.on('error', (error) => {
        if (!settled) finish(new Error(`无法连接中继服务器：${error.message}`))
      })
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.channel?.close()
    } catch {}
    try {
      this.pc?.close()
    } catch {}
    try {
      this.ws?.close()
    } catch {}
    this.channel = null
    this.pc = null
    this.ws = null
  }
}

module.exports = {
  DataChannelSocket,
  WebRtcHostAgent,
  WebRtcController,
  signalUrl
}
