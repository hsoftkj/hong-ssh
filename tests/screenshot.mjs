/**
 * Launch the built app with an isolated profile, wait for the shell, and save a
 * screenshot. Used for manual visual checks and by the E2E suite.
 */
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'docs', 'screenshots')
fs.mkdirSync(outDir, { recursive: true })
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-shot-'))

const app = await electron.launch({
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    HONGSSH_DATA_DIR: userData,
    HONGSSH_E2E: '1',
    HONGSSH_NO_CONFIRM: '1'
  }
})

const page = await app.firstWindow()
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
await page.waitForSelector('.app-shell', { timeout: 20000 })
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(outDir, 'empty-state.png') })
console.log(`saved ${path.join(outDir, 'empty-state.png')}`)
if (errors.length) {
  console.error(errors.join('\n'))
}
await Promise.race([
  app.close(),
  new Promise((resolve) => setTimeout(resolve, 4000))
])
try {
  app.process().kill()
} catch {}
fs.rmSync(userData, { recursive: true, force: true })
process.exit(errors.length ? 1 : 0)
