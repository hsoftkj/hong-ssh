/**
 * Development launcher: starts Vite, waits for the dev server, then starts
 * Electron pointed at it. Electron restart is manual (Ctrl+C then rerun).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const url = 'http://127.0.0.1:5173/'

const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  cwd: root,
  stdio: 'inherit'
})

function waitForServer(deadline = Date.now() + 30000) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Vite dev server did not start'))
        else setTimeout(attempt, 250)
      })
      req.setTimeout(1500, () => req.destroy())
    }
    attempt()
  })
}

let electron = null
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    electron?.kill()
  } catch {}
  try {
    vite.kill()
  } catch {}
  process.exit(code)
}

vite.on('exit', (code) => {
  if (!shuttingDown) shutdown(code ?? 1)
})

await waitForServer()
console.log('[hongssh] Vite ready, launching Electron…')
electron = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url }
})
electron.on('exit', (code) => shutdown(code ?? 0))
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
