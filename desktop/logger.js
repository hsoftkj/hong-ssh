'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_LOG_SIZE = 2 * 1024 * 1024

/**
 * Minimal append-only logger with a size cap. A terminal client must keep
 * working even when logging fails, so every method is defensive.
 */
class Logger {
  constructor(directory) {
    this.directory = directory
    this.file = path.join(directory, 'hongssh.log')
    this.stream = null
    try {
      fs.mkdirSync(directory, { recursive: true })
      this.rotateIfNeeded()
      this.stream = fs.createWriteStream(this.file, { flags: 'a' })
    } catch {
      this.stream = null
    }
  }

  rotateIfNeeded() {
    try {
      const stat = fs.statSync(this.file)
      if (stat.size > MAX_LOG_SIZE) {
        fs.renameSync(this.file, `${this.file}.1`)
      }
    } catch {
      // Missing file on first run.
    }
  }

  write(level, message, detail) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${
      detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : safeJson(detail)}`
    }\n`
    if (level === 'error') console.error(line.trimEnd())
    else if (level === 'warn') console.warn(line.trimEnd())
    if (!this.stream) return
    try {
      this.stream.write(line)
    } catch {
      // ignore
    }
  }

  info(message, detail) {
    this.write('info', message, detail)
  }

  warn(message, detail) {
    this.write('warn', message, detail)
  }

  error(message, detail) {
    if (detail instanceof Error) {
      this.write('error', message, { message: detail.message, stack: detail.stack })
    } else {
      this.write('error', message, detail)
    }
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

module.exports = { Logger }
