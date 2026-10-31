'use strict'

/**
 * HongSSH WebRTC signaling relay.
 *
 * It only exchanges SDP/ICE and device presence. Screen, input and file data
 * travel over the WebRTC DataChannel between the two desktop apps. When ICE
 * cannot find a direct path, a TURN server (configured below) carries the data;
 * this process never proxies media.
 *
 * Environment:
 *   PORT=47891
 *   HOST_TOKEN=change-me
 *   ICE_SERVERS_JSON=[{"urls":"stun:stun.example.com:3478"}]
 *   TLS_CERT=/etc/hongssh/fullchain.pem
 *   TLS_KEY=/etc/hongssh/privkey.pem
 */

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const { WebSocketServer, WebSocket } = require('ws')

const PORT = Number(process.env.PORT) || 47891
const HOST_TOKEN = String(process.env.HOST_TOKEN || '').trim()
const TLS_CERT = process.env.TLS_CERT || ''
const TLS_KEY = process.env.TLS_KEY || ''
const configuredIce = parseIceServers(process.env.ICE_SERVERS_JSON)
const ICE_SERVERS = configuredIce.length
  ? configuredIce
  : [{ urls: 'stun:stun.l.google.com:19302' }]

if (!HOST_TOKEN) {
  console.error('HOST_TOKEN is required; refusing to start an unauthenticated relay.')
  process.exit(1)
}

function parseIceServers(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    console.error('ICE_SERVERS_JSON is not valid JSON:', error.message)
    return []
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function validDevice(value) {
  return /^[A-Za-z0-9-]{6,32}$/.test(String(value || ''))
}

function json(ws, value) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value))
}

const agents = new Map()
const sessions = new Map()

function closeSession(sessionId, reason) {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  clearTimeout(session.timer)
  for (const socket of [session.controller, session.agentSocket]) {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, reason || 'closed')
    } catch {}
  }
  if (session.agent?.ws === session.agentControl) {
    json(session.agentControl, { type: 'peer-closed', sessionId })
  }
}

function handleAgent(ws, request, device) {
  if (!HOST_TOKEN || !safeEqual(request.headers['x-relay-token'], HOST_TOKEN)) {
    ws.close(4003, 'invalid host token')
    return
  }
  const existing = agents.get(device)
  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close(4001, 'agent replaced')
    } catch {}
    for (const session of [...sessions.values()]) {
      if (session.agent === existing) closeSession(session.id, 'agent replaced')
    }
  }
  const agent = { device, ws, sessions: new Set(), address: request.socket.remoteAddress || '' }
  agents.set(device, agent)
  json(ws, { type: 'registered', device, iceServers: ICE_SERVERS })
  console.log(`[agent] ${device} online from ${agent.address} (${agents.size} online)`)
  ws.on('message', (data) => {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (message.type === 'pong') return
  })
  ws.on('close', () => {
    if (agents.get(device) === agent) agents.delete(device)
    for (const session of [...sessions.values()]) {
      if (session.agent === agent) closeSession(session.id, 'agent offline')
    }
    console.log(`[agent] ${device} offline (${agents.size} online)`)
  })
  ws.on('error', (error) => console.warn(`[agent] ${device} error:`, error.message))
}

function handleControl(ws, request, device) {
  const agent = agents.get(device)
  if (!agent) {
    ws.close(4004, 'device offline')
    return
  }
  if ([...sessions.values()].some((session) => session.agent === agent)) {
    ws.close(4009, 'device busy')
    return
  }
  const sessionId = crypto.randomBytes(12).toString('hex')
  const session = {
    id: sessionId,
    device,
    agent,
    agentControl: agent.ws,
    controller: ws,
    agentSocket: null,
    timer: setTimeout(() => closeSession(sessionId, 'agent session timeout'), 15000)
  }
  sessions.set(sessionId, session)
  agent.sessions.add(sessionId)
  json(agent.ws, { type: 'peer', sessionId, iceServers: ICE_SERVERS })
  json(ws, { type: 'peer-ready', sessionId, iceServers: ICE_SERVERS })
  console.log(`[session] ${device} waiting for agent ${sessionId}`)
  ws.on('message', (data) => forward(session, 'controller', data))
  ws.on('close', () => closeSession(sessionId, 'controller closed'))
  ws.on('error', () => closeSession(sessionId, 'controller error'))
}

function handleAgentSession(ws, request, device, sessionId) {
  const session = sessions.get(sessionId)
  if (!session || session.device !== device) {
    ws.close(4004, 'session not found')
    return
  }
  if (!HOST_TOKEN || !safeEqual(request.headers['x-relay-token'], HOST_TOKEN)) {
    ws.close(4003, 'invalid host token')
    return
  }
  if (session.agentSocket) {
    ws.close(4009, 'session already attached')
    return
  }
  session.agentSocket = ws
  clearTimeout(session.timer)
  session.timer = null
  console.log(`[session] ${device} paired ${sessionId}`)
  ws.on('message', (data) => forward(session, 'agent', data))
  ws.on('close', () => closeSession(sessionId, 'agent session closed'))
  ws.on('error', () => closeSession(sessionId, 'agent session error'))
}

function forward(session, from, data) {
  const target = from === 'agent' ? session.controller : session.agentSocket
  if (!target || target.readyState !== WebSocket.OPEN) return
  try {
    target.send(data)
  } catch {}
}

const server = TLS_CERT && TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) })
  : http.createServer()

server.on('request', (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, agents: agents.size, sessions: sessions.size }))
    return
  }
  response.writeHead(404)
  response.end()
})

const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
wss.on('connection', (ws, request) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname !== '/signal') {
    ws.close(4004, 'not found')
    return
  }
  const role = url.searchParams.get('role') || ''
  const device = String(url.searchParams.get('device') || '')
  const sessionId = url.searchParams.get('session') || ''
  if (!validDevice(device)) {
    ws.close(4000, 'invalid device id')
    return
  }
  if (role === 'host') {
    handleAgent(ws, request, device)
  } else if (role === 'control') {
    handleControl(ws, request, device)
  } else if (role === 'agent-session') {
    handleAgentSession(ws, request, device, sessionId)
  } else {
    ws.close(4000, 'invalid role')
  }
})

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    try {
      ws.ping()
    } catch {}
  }
}, 30000)
wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HongSSH signaling relay listening on ${TLS_CERT && TLS_KEY ? 'wss' : 'ws'}://0.0.0.0:${PORT}/signal`)
  console.log(`ICE servers: ${ICE_SERVERS.length}`)
})

process.on('SIGTERM', () => {
  clearInterval(heartbeat)
  for (const session of [...sessions.values()]) closeSession(session.id, 'server shutdown')
  server.close(() => process.exit(0))
})
