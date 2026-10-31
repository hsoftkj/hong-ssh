'use strict'

// Wire format for the remote desktop channel:
// [4-byte big-endian JSON length][JSON header][optional binary payload]
// `payloadLength` inside the header tells the receiver how many binary bytes follow.

const MAX_HEADER = 1024 * 1024

function encodeMessage(message, payload) {
  const body = payload || Buffer.alloc(0)
  const json = Buffer.from(JSON.stringify({ ...message, payloadLength: body.length }), 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(json.length, 0)
  return Buffer.concat([header, json, body])
}

function createParser(onMessage) {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])
    while (pending.length >= 4) {
      const jsonLength = pending.readUInt32BE(0)
      if (jsonLength <= 0 || jsonLength > MAX_HEADER) throw new Error('远程消息头无效')
      if (pending.length < 4 + jsonLength) return
      const header = JSON.parse(pending.subarray(4, 4 + jsonLength).toString('utf8'))
      const payloadLength = Number.isFinite(header.payloadLength) ? header.payloadLength : 0
      if (payloadLength < 0 || payloadLength > 64 * 1024 * 1024) {
        throw new Error('远程消息体过大')
      }
      if (pending.length < 4 + jsonLength + payloadLength) return
      const payload = pending.subarray(4 + jsonLength, 4 + jsonLength + payloadLength)
      pending = pending.subarray(4 + jsonLength + payloadLength)
      onMessage(header, payload)
    }
  }
}

module.exports = { encodeMessage, createParser }
