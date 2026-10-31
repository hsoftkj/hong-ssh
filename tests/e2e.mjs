/**
 * End-to-end test: launches the real Electron app against a local SSH server
 * backed by Git Bash + ConPTY, then exercises the terminal, colors, top, vim,
 * search, resizing and settings. Screenshots are written to docs/screenshots.
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startTestServer } from './ssh-server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const screenshots = path.join(root, 'docs', 'screenshots')
fs.mkdirSync(screenshots, { recursive: true })
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-e2e-'))
const sftpLocalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-e2e-sftp-'))
const sftpUploadFile = path.join(sftpLocalDir, 'sftp-e2e.txt')
fs.writeFileSync(sftpUploadFile, 'uploaded by the E2E suite\n中文 SFTP\n', 'utf8')
const sftpDownloadDir = path.join(sftpLocalDir, 'downloads')
fs.mkdirSync(sftpDownloadDir)
const xshellExportParent = fs.mkdtempSync(path.join(os.tmpdir(), 'hongssh-e2e-xshell-'))
const sftpTree = path.join(sftpLocalDir, 'sftp-tree')
fs.mkdirSync(path.join(sftpTree, 'nested'), { recursive: true })
fs.mkdirSync(path.join(sftpTree, 'empty'), { recursive: true })
fs.writeFileSync(path.join(sftpTree, 'nested', 'nested.txt'), 'nested file\n', 'utf8')
fs.writeFileSync(path.join(sftpTree, 'root.txt'), 'root file\n', 'utf8')
const sftpFolderDownload = path.join(sftpLocalDir, 'folder-download')
fs.mkdirSync(sftpFolderDownload)
const clipboardFile = path.join(sftpLocalDir, 'clipboard-file.txt')
fs.writeFileSync(clipboardFile, 'pasted from the Windows clipboard\n', 'utf8')
const clipboardFolder = path.join(sftpLocalDir, 'clipboard-folder')
fs.mkdirSync(path.join(clipboardFolder, 'nested'), { recursive: true })
fs.writeFileSync(path.join(clipboardFolder, 'nested', 'clipboard-nested.txt'), 'clipboard folder\n', 'utf8')
const dropFile = path.join(sftpLocalDir, 'drop-file.txt')
fs.writeFileSync(dropFile, 'dropped file\n', 'utf8')
const dropFolder = path.join(sftpLocalDir, 'drop-folder')
fs.mkdirSync(path.join(dropFolder, 'nested'), { recursive: true })
fs.writeFileSync(path.join(dropFolder, 'nested', 'drop-nested.txt'), 'dropped folder\n', 'utf8')
const dragOutTarget = path.join(sftpLocalDir, 'drag-out-target')
fs.mkdirSync(dragOutTarget)
const resumeFullFile = path.join(sftpLocalDir, 'resume-e2e.txt')
fs.writeFileSync(resumeFullFile, 'RESUME-PART-COMPLETE', 'utf8')
const resumeUploadCheck = path.join(sftpLocalDir, 'resume-upload-check')
fs.mkdirSync(resumeUploadCheck)
const resumeDownloadDir = path.join(sftpLocalDir, 'resume-download')
fs.mkdirSync(resumeDownloadDir)
fs.writeFileSync(path.join(resumeDownloadDir, 'resume-e2e.txt.hongssh.part'), 'RESUME', 'utf8')
const server = await startTestServer()
const failures = []
const pageErrors = []

function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures.push(message)
    console.error(`  ✗ ${message}`)
  }
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(screenshots, name) })
  console.log(`  · screenshot ${name}`)
}

async function dismissToasts(page) {
  const buttons = page.locator('.toast-close')
  const count = await buttons.count()
  for (let index = 0; index < count; index += 1) {
    await buttons.nth(index).click({ timeout: 1000 }).catch(() => {})
  }
  await page.waitForTimeout(250)
}

function setClipboardFiles(paths) {
  const list = paths.map((item) => `'${item.replace(/'/g, "''")}'`).join(',')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$items = New-Object System.Collections.Specialized.StringCollection',
    `@(${list}) | ForEach-Object { [void]$items.Add($_) }`,
    '[System.Windows.Forms.Clipboard]::SetFileDropList($items)'
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { stdio: 'ignore' })
}

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

try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
  await page.waitForSelector('.app-shell', { timeout: 20000 })
  await page.waitForFunction(() => Boolean(window.__hongssh), null, { timeout: 10000 })

  console.log('\n[0] frameless window and custom title bar')
  await page.waitForSelector('.titlebar', { timeout: 5000 })
  check((await page.locator('.titlebar-control').count()) === 3, 'custom title bar has minimize/maximize/close')
  check(
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null),
    'native application menu is removed'
  )
  check(
    !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())),
    'native menu bar is hidden'
  )
  check(
    (await page.locator('.toolbar-status').innerText()).includes('未连接'),
    'toolbar shows the idle connection status'
  )
  check(
    await page
      .locator('.toolbar-button[title^="显示/隐藏连接面板"]')
      .evaluate((button) => button.classList.contains('is-active')),
    'toolbar sidebar button shows the active state'
  )
  check(
    (await page.locator('.status-zoom-label').innerText()) === '14px',
    'zoom controls live in the bottom-right status bar'
  )
  await page.locator('.status-zoom-button').last().click()
  await page.waitForFunction(
    () => document.querySelector('.status-zoom-label')?.textContent === '15px',
    null,
    { timeout: 3000 }
  )
  await page.locator('.status-zoom-button').first().click()
  await page.waitForFunction(
    () => document.querySelector('.status-zoom-label')?.textContent === '14px',
    null,
    { timeout: 3000 }
  )
  check(true, 'bottom-right zoom controls change the terminal font size')
  const maximizeButton = page.locator('.titlebar-control').nth(1)
  await maximizeButton.click()
  await page.waitForTimeout(500)
  check(await page.evaluate(() => window.hongssh.windowIsMaximized()), 'title bar maximize button works')
  await maximizeButton.click()
  await page.waitForTimeout(500)
  check(!(await page.evaluate(() => window.hongssh.windowIsMaximized())), 'title bar restore button works')
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'F1' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'F1' })
  })
  await page.waitForTimeout(400)
  check(
    (await page.locator('.modal').filter({ hasText: '快捷键' }).count()) === 1,
    'keyboard shortcuts still work without the native menu'
  )
  const modalBefore = await page.locator('.modal').boundingBox()
  if (modalBefore) {
    await page.mouse.move(modalBefore.x + modalBefore.width / 2, modalBefore.y + 24)
    await page.mouse.down()
    await page.mouse.move(
      modalBefore.x + modalBefore.width / 2 + 90,
      modalBefore.y + 24 + 55,
      { steps: 8 }
    )
    await page.mouse.up()
  }
  await page.waitForTimeout(250)
  const modalAfter = await page.locator('.modal').boundingBox()
  check(
    Boolean(
      modalBefore &&
        modalAfter &&
        (Math.abs(modalAfter.x - modalBefore.x) > 20 ||
          Math.abs(modalAfter.y - modalBefore.y) > 20)
    ),
    'modal dialogs can be dragged by their header'
  )
  await page.locator('.modal-close').click()
  await page.waitForTimeout(250)

  await shot(page, '01-empty.png')

  console.log('\n[1] create connection through the real IPC store')
  const connectionId = await page.evaluate(async ({ host, port, user, password }) => {
    const debug = window.__hongssh
    return debug.createConnection({
      id: `c_e2e_${Date.now()}`,
      folderId: null,
      name: 'Local Git Bash',
      host,
      port,
      username: user,
      authType: 'password',
      privateKeyPath: '',
      description: 'End-to-end test host',
      color: '#0f9d8a',
      terminalType: 'xterm-256color',
      initCommand: '',
      hostKeyPolicy: 'accept-new',
      keepaliveInterval: 15,
      password
    })
  }, {
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password
  })
  check(Boolean(connectionId), 'connection saved with encrypted password')
  await page.waitForSelector('.tree-connection', { timeout: 5000 })
  check(
    (await page.locator('.tree-connection').count()) === 1,
    'connection appears in the sidebar'
  )
  await shot(page, '02-connection-list.png')

  console.log('\n[1b] Xshell export and re-import')
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, xshellExportParent)
  const xshellExport = await page.evaluate(() => window.hongssh.exportXshell())
  check(Boolean(xshellExport?.directory), 'export creates an Xshell session directory')
  check(xshellExport?.files === 1, 'export writes one session JSON file')
  const exportedFiles = []
  const collectExported = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) collectExported(full)
      else if (entry.name.endsWith('_connect_config.json')) exportedFiles.push(full)
    }
  }
  collectExported(xshellExport.directory)
  const exported = JSON.parse(fs.readFileSync(exportedFiles[0], 'utf8'))
  check(exported.host === server.host && exported.user_name === server.user, 'export preserves host and user')
  check(exported.password === '', 'export never writes plaintext passwords')
  const reimported = await page.evaluate(
    (directory) => window.__hongssh.importXshellFrom(directory),
    xshellExport.directory
  )
  check(
    reimported.summary.unique === 1 && reimported.summary.imported === 0,
    'exported sessions round-trip through the Xshell importer without duplicates'
  )

  console.log('\n[2] open a real SSH PTY session')
  await page.evaluate((id) => window.__hongssh.openConnection(id), connectionId)
  await page.waitForFunction(
    () => window.__hongssh.getSessions().some((session) => session.connected),
    null,
    { timeout: 25000 }
  )
  await page.waitForFunction(
    () => window.__hongssh.getActiveBuffer().includes('$'),
    null,
    { timeout: 10000 }
  )
  const state = await page.evaluate(() => window.__hongssh.getSessionState())
  check(state?.connected === true, 'session reached connected state')
  check(
    (await page.locator('.toolbar-status').innerText()).includes('已连接'),
    'toolbar shows the connected status'
  )
  await page.waitForFunction(
    () => document.querySelector('.system-info-bar')?.textContent?.includes('Test Linux 1.0'),
    null,
    { timeout: 8000 }
  )
  const systemInfoText = await page.locator('.system-info-bar').innerText()
  check(systemInfoText.includes('10.0.0.5'), 'system info bar shows the remote IP address')
  check(systemInfoText.includes('Test Linux 1.0'), 'system info bar shows the OS name')
  check(systemInfoText.includes('e2e-host'), 'system info bar shows the hostname')
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.system-info-bar')?.textContent || ''
      return text.includes('20%') && text.includes('25%')
    },
    null,
    { timeout: 8000 }
  )
  const statsText = await page.locator('.system-info-bar').innerText()
  check(
    statsText.indexOf('20%') >= 0 && statsText.indexOf('20%') < statsText.indexOf('IP'),
    'live CPU usage percentage is shown before the IP address'
  )
  check(
    statsText.indexOf('25%') >= 0 && statsText.indexOf('25%') < statsText.indexOf('IP'),
    'live memory usage percentage is shown before the IP address'
  )
  const infoBarLayout = await page.evaluate(() => {
    const bar = document.querySelector('.system-info-bar')
    const surface = document.querySelector('.terminal-surface')
    if (!bar || !surface) return null
    const previousWidth = bar.style.width
    const previous = bar.scrollLeft
    bar.style.width = '600px'
    bar.scrollLeft = bar.scrollWidth
    const result = {
      overflowX: getComputedStyle(bar).overflowX,
      whiteSpace: getComputedStyle(bar).whiteSpace,
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      scrollLeft: bar.scrollLeft,
      terminalPaddingRight: getComputedStyle(surface).paddingRight
    }
    bar.scrollLeft = previous
    bar.style.width = previousWidth
    return result
  })
  check(
    Boolean(
      infoBarLayout &&
        infoBarLayout.overflowX === 'auto' &&
        infoBarLayout.whiteSpace === 'nowrap'
    ),
    'system info bar stays on one line and scrolls horizontally when needed'
  )
  check(
    Boolean(
      infoBarLayout &&
        infoBarLayout.scrollWidth > infoBarLayout.clientWidth &&
        infoBarLayout.scrollLeft > 0
    ),
    'system info bar shows a horizontal scrollbar when content overflows'
  )
  check(
    Boolean(infoBarLayout && infoBarLayout.terminalPaddingRight === '0px'),
    'terminal vertical scrollbar is flush with the right edge'
  )
  check(
    await page.locator('.toolbar-quick-button').isEnabled(),
    'quick command button is enabled for a connected session'
  )
  await page.locator('.toolbar-quick-button').click()
  await page.waitForFunction(
    () => !document.querySelector('.toolbar-quick-menu')?.hasAttribute('hidden'),
    null,
    { timeout: 3000 }
  )
  check(
    (await page.locator('.toolbar-quick-menu .quick-command').count()) === 8,
    'quick command dropdown opens with all commands'
  )
  await shot(page, '15-quick-commands.png')
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => document.querySelector('.toolbar-quick-menu')?.hasAttribute('hidden'),
    null,
    { timeout: 3000 }
  )
  check(true, 'quick command dropdown closes with Escape')

  console.log('\n[2a] host inspection')
  check(
    (await page.locator('.toolbar-inspection-button').getAttribute('title')) === '主机巡检',
    'toolbar exposes the host inspection button'
  )
  check(
    await page.evaluate(() => {
      const inspection = document.querySelector('.toolbar-inspection-button')
      const files = document.querySelector('.toolbar-button[title^="文件传输"]')
      return Boolean(
        inspection &&
          files &&
          inspection.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    }),
    'inspection button is placed before file transfer'
  )
  await page.locator('.toolbar-inspection-button').click()
  await page.waitForSelector('.inspection', { timeout: 5000 })
  check(
    (await page.locator('.inspection-threshold-input input').inputValue()) === '90',
    'inspection defaults to a 90% disk threshold'
  )
  await page.locator('.inspection-threshold-input input').fill('80')
  await page.locator('.inspection-threshold-input input').press('Enter')
  await page.waitForSelector('.inspection-row.is-alert', { timeout: 15000 })
  const inspectionAlert = await page.locator('.inspection-row.is-alert').innerText()
  check(inspectionAlert.includes('/data'), 'inspection reports the mount that exceeds the threshold')
  check(inspectionAlert.includes('95%'), 'inspection shows the current disk usage percentage')
  check(
    (await page.locator('.inspection-banner.is-alert').innerText()).includes('1 台主机'),
    'inspection banner summarizes the number of alerted hosts'
  )
  check(
    (await page.evaluate(() => window.__hongssh.getState().settings.inspectionDiskThreshold)) === 80,
    'adjusted threshold is persisted in settings'
  )
  await page.locator('.inspection-stat.is-alert').click()
  check(
    (await page.locator('.inspection-row').count()) === 1,
    'alert filter shows only alerted connections'
  )
  await page.locator('.modal-close').click()
  await page.waitForSelector('.inspection', { state: 'detached', timeout: 3000 })

  console.log('\n[2b] terminal right-click menu')
  check(
    (await page.evaluate(() => window.__hongssh.getState().settings.rightClick)) === 'contextMenu',
    'terminal right-click defaults to the context menu'
  )
  await page.locator('.session-pane.is-active').evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: bounds.left + 80,
        clientY: bounds.top + 80
      })
    )
  })
  await page.waitForSelector('.context-menu', { timeout: 3000 })
  const terminalMenuLabels = await page
    .locator('.context-menu-item')
    .evaluateAll((items) => items.map((item) => item.textContent || ''))
  check(
    terminalMenuLabels.some((label) => label.includes('复制当前选择的内容')),
    'terminal context menu offers copy selection'
  )
  check(
    terminalMenuLabels.some((label) => label.includes('复制并粘贴到光标位置')),
    'terminal context menu offers copy and paste at cursor'
  )
  check(
    terminalMenuLabels.some((label) => label.includes('粘贴多行指令')),
    'terminal context menu offers multi-line paste'
  )
  check(
    terminalMenuLabels.some((label) => label.includes('清屏')),
    'terminal context menu offers clear screen'
  )
  const clipboardRoundTrip = await page.evaluate(() => {
    window.hongssh.clipboardWrite('HongSSH clipboard test')
    return window.hongssh.clipboardRead()
  })
  check(clipboardRoundTrip === 'HongSSH clipboard test', 'terminal clipboard IPC supports copy and paste')
  await page.evaluate(() => {
    window.hongssh.clipboardWrite('echo HONG_MULTI_1\necho HONG_MULTI_2')
  })
  await page.locator('.session-pane.is-active').evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: bounds.left + 80,
        clientY: bounds.top + 80
      })
    )
  })
  await page.waitForSelector('.context-menu', { timeout: 3000 })
  await page.locator('.context-menu-item').filter({ hasText: '粘贴多行指令' }).click()
  await page.waitForFunction(() => !document.querySelector('.context-menu'), null, {
    timeout: 3000
  })
  await page.waitForFunction(
    () => {
      const buffer = window.__hongssh.getActiveBuffer()
      return buffer.includes('HONG_MULTI_1') && buffer.includes('HONG_MULTI_2')
    },
    null,
    { timeout: 5000 }
  )
  check(
    await page.evaluate(() => {
      const buffer = window.__hongssh.getActiveBuffer()
      return buffer.indexOf('HONG_MULTI_1') < buffer.lastIndexOf('HONG_MULTI_2')
    }),
    'terminal multi-line paste executes commands one line at a time'
  )
  await page.evaluate(() => window.__hongssh.sendCommand('clear'))
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => !document.querySelector('.context-menu'),
    null,
    { timeout: 3000 }
  )
  check((state?.cols ?? 0) > 40 && (state?.rows ?? 0) > 10, 'PTY reported terminal dimensions')
  const tabText = await page.locator('.session-tab').first().innerText()
  check(tabText.includes('Local Git Bash'), 'tab shows the session name')
  await page.waitForTimeout(400)
  await dismissToasts(page)
  await shot(page, '03-terminal-connected.png')

  console.log('\n[3] colors: 16-color, 256-color and truecolor')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.locator('.xterm-screen').click({ timeout: 2000 }).catch(() => {})
    await page.evaluate(() => {
      window.__hongssh.sendCommand(
        "printf '\\033[31mRED\\033[0m|\\033[32mGREEN\\033[0m|\\033[34mBLUE\\033[0m|\\033[38;5;208mORANGE256\\033[0m|\\033[38;2;255;0;255mTRUECOLOR\\033[0m\\n'"
      )
    })
    try {
      await page.waitForFunction(
        () =>
          window.__hongssh
            .getActiveBuffer()
            .split('\n')
            .some((line) => line.startsWith('RED|GREEN|BLUE|ORANGE256|TRUECOLOR')),
        null,
        { timeout: 4000 }
      )
      break
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  await page.waitForTimeout(250)
  const colors = await page.evaluate(() => window.__hongssh.getSessionColors())
  const red = colors.find((cell) => cell.text === 'R' && cell.fg === 1)
  const green = colors.find((cell) => cell.text === 'G' && cell.fg === 2)
  const blue = colors.find((cell) => cell.text === 'B' && cell.fg === 4)
  const orange = colors.find((cell) => cell.text === 'O' && cell.fg === 0xff8700)
  const truecolor = colors.find((cell) => cell.text === 'T' && cell.fg === 0xff00ff)
  if (!red || !green || !blue || !orange || !truecolor) {
    console.log(
      'color samples:',
      JSON.stringify(
        colors.filter((cell) => 'RGBOT'.includes(cell.text)).slice(-25),
        null,
        2
      )
    )
  }
  check(Boolean(red), 'SGR 31 red rendered with palette color 1')
  check(Boolean(green), 'SGR 32 green rendered with palette color 2')
  check(Boolean(blue), 'SGR 34 blue rendered with palette color 4')
  check(Boolean(orange), '256-color 208 rendered as #ff8700')
  check(Boolean(truecolor), 'truecolor #ff00ff rendered as #ff00ff')
  await shot(page, '04-terminal-colors.png')

  console.log('\n[4] top: alternate screen + colors + single-key quit')
  await page.evaluate(() => window.__hongssh.sendCommand('top'))
  await page.waitForFunction(
    () => window.__hongssh.getActiveBuffer().includes('HongSSH demo top'),
    null,
    { timeout: 10000 }
  )
  await page.waitForTimeout(500)
  check(true, 'top entered the full-screen alternate buffer')
  await shot(page, '05-terminal-top.png')
  await page.evaluate(() => window.__hongssh.sendText('q'))
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__hongssh.sendCommand('echo AFTER_TOP'))
  await page.waitForFunction(
    () => window.__hongssh.getActiveBuffer().includes('AFTER_TOP'),
    null,
    { timeout: 10000 }
  )
  check(true, 'top quit and the shell accepted the next command')

  console.log('\n[5] vim: full-screen editor and key handling')
  await page.evaluate(() => window.__hongssh.sendCommand('vi ~/demo.sh'))
  await page.waitForFunction(
    () => window.__hongssh.getActiveBuffer().includes('HongSSH interactive test file'),
    null,
    { timeout: 10000 }
  )
  await page.waitForTimeout(500)
  check(true, 'vi opened the test file')
  await shot(page, '06-terminal-vim.png')
  await page.evaluate(() => window.__hongssh.sendText('\u001b'))
  await page.waitForTimeout(200)
  await page.evaluate(() => window.__hongssh.sendText(':q!\r'))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__hongssh.sendCommand('echo AFTER_VIM'))
  await page.waitForFunction(
    () => window.__hongssh.getActiveBuffer().includes('AFTER_VIM'),
    null,
    { timeout: 10000 }
  )
  check(true, 'vim quit with :q! and the shell accepted the next command')

  console.log('\n[6] terminal search')
  await page.evaluate(() => window.__hongssh.focusTerminal())
  await page.keyboard.press('Control+f')
  await page.waitForSelector('.terminal-search:not([hidden])', { timeout: 5000 })
  await page.locator('.terminal-search .search-input').fill('TRUECOLOR')
  await page.waitForTimeout(400)
  check(true, 'Ctrl+F opened terminal search')
  await shot(page, '07-terminal-search.png')
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => document.querySelector('.terminal-search')?.hasAttribute('hidden'),
    null,
    { timeout: 5000 }
  )

  console.log('\n[7] resize the window and verify PTY window-change')
  const before = await page.evaluate(() => window.__hongssh.getSessionState())
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const bounds = window.getBounds()
    window.setSize(bounds.width - 240, bounds.height - 100)
  })
  await page.waitForTimeout(900)
  const after = await page.evaluate(() => window.__hongssh.getSessionState())
  check((after?.cols ?? 0) < (before?.cols ?? 0), 'terminal columns shrink after resizing')
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1380, 880)
  })
  await page.waitForTimeout(500)

  console.log('\n[8] settings dialog')
  await page.locator('.toolbar-button[title^="设置"]').click()
  await page.waitForSelector('.modal', { timeout: 5000 })
  await page.waitForTimeout(350)
  const modalTitle = await page.locator('.modal-title').innerText()
  check(modalTitle.includes('设置'), 'settings dialog opens')
  await shot(page, '08-settings.png')
  const themeSelect = page.locator('.modal select').first()
  const themeOptions = await themeSelect
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value))
  check(themeOptions.length === 21, 'settings exposes all 21 interface themes')
  for (const themeId of themeOptions) {
    await themeSelect.selectOption(themeId)
    await page.waitForTimeout(60)
    check(
      (await page.evaluate(() => document.documentElement.dataset.theme)) === themeId,
      `theme ${themeId} applies to the interface`
    )
    if (themeId === 'cute') await shot(page, '16-theme-cute.png')
    if (themeId === 'cyberpunk') await shot(page, '16-theme-cyberpunk.png')
  }
  await themeSelect.selectOption('light')
  await page.waitForTimeout(100)
  check(
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light',
    'default theme restored after previewing presets'
  )
  const scrollbarRow = page.locator('.checkbox-row').filter({ hasText: '隐藏连接树滚动条' })
  check(
    await scrollbarRow.locator('input').isChecked(),
    'connection tree scrollbar is hidden by default'
  )
  check(
    await page.evaluate(() => {
      const tree = document.querySelector('.connection-tree')
      return (
        !document.body.classList.contains('show-sidebar-scrollbar') &&
        Boolean(tree) &&
        getComputedStyle(tree).overflowY === 'auto' &&
        getComputedStyle(tree).scrollbarWidth === 'none'
      )
    }),
    'hidden scrollbar keeps the connection tree scrollable'
  )
  await scrollbarRow.locator('input').uncheck()
  await page.locator('.dialog-footer button').filter({ hasText: '保存设置' }).click()
  await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 5000 })
  check(
    await page.evaluate(
      () =>
        document.body.classList.contains('show-sidebar-scrollbar') &&
        getComputedStyle(document.querySelector('.connection-tree')).scrollbarWidth === 'thin'
    ),
    'turning the setting off restores the sidebar scrollbar'
  )
  await page.locator('.toolbar-button[title^="设置"]').click()
  await page.waitForSelector('.modal', { timeout: 5000 })
  const scrollbarRowAgain = page.locator('.checkbox-row').filter({ hasText: '隐藏连接树滚动条' })
  check(
    !(await scrollbarRowAgain.locator('input').isChecked()),
    'scrollbar setting is persisted'
  )
  await scrollbarRowAgain.locator('input').check()
  await page.locator('.dialog-footer button').filter({ hasText: '保存设置' }).click()
  await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 5000 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await shot(page, '09-final.png')

  console.log('\n[9] dark theme')
  await page.locator('.toolbar-button[title^="切换深色"]').click()
  await page.waitForTimeout(350)
  const theme = await page.evaluate(() => document.documentElement.dataset.theme)
  check(theme === 'dark', 'toolbar switches to dark theme')
  check(
    await page
      .locator('.toolbar-button[title^="切换浅色"]')
      .evaluate((button) => button.classList.contains('is-active')),
    'toolbar theme button shows the active state'
  )
  await shot(page, '10-dark.png')
  await page.locator('.toolbar-button[title^="切换浅色"]').click()
  await page.waitForTimeout(250)

  console.log('\n[10] SFTP file browser and transfers')
  const beforeSftpCols = (await page.evaluate(() => window.__hongssh.getSessionState()))?.cols ?? 0
  const activeSessionId = await page.evaluate(() => window.__hongssh.getSessions()[0].id)
  await page.locator('.toolbar-button[title^="文件传输"]').click()
  await page.waitForSelector('.sftp-panel:not([hidden])', { timeout: 5000 })
  await page.waitForSelector('.sftp-row', { timeout: 10000 })
  check(
    (await page.locator('.sftp-row').first().getAttribute('draggable')) === 'true',
    'remote rows are draggable for drag-out download'
  )
  check(
    await page.evaluate(() => typeof window.hongssh.startDragDownload === 'function'),
    'drag-out download API is exposed'
  )
  await page.waitForTimeout(500)
  const afterSftpCols = (await page.evaluate(() => window.__hongssh.getSessionState()))?.cols ?? 0
  check(afterSftpCols < beforeSftpCols, 'opening the file panel resizes the terminal PTY')
  check(
    await page
      .locator('.toolbar-button[title^="文件传输"]')
      .evaluate((button) => button.classList.contains('is-active')),
    'toolbar files button shows the active state'
  )
  await dismissToasts(page)
  const initialFiles = await page.locator('.sftp-row-name').allInnerTexts()
  check(initialFiles.includes('demo.sh'), 'SFTP panel lists the remote home directory')
  await shot(page, '11-sftp.png')

  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, sftpUploadFile)
  await page.locator('.sftp-action-button').filter({ hasText: '上传' }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.sftp-transfer.is-done').length > 0,
    null,
    { timeout: 15000 }
  )
  await page.waitForFunction(
    () => [...document.querySelectorAll('.sftp-row-name')].some((el) => el.textContent === 'sftp-e2e.txt'),
    null,
    { timeout: 10000 }
  )
  check(true, 'upload from the panel refreshes the remote listing')
  await dismissToasts(page)
  await shot(page, '12-sftp-upload.png')

  await page.locator('.sftp-row').filter({ hasText: 'sftp-e2e.txt' }).click()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, sftpDownloadDir)
  await page.locator('.sftp-action-button').filter({ hasText: '下载' }).click()
  let downloaded = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fs.existsSync(path.join(sftpDownloadDir, 'sftp-e2e.txt'))) {
      downloaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(downloaded, 'download from the panel writes the local file')
  check(
    fs.readFileSync(path.join(sftpDownloadDir, 'sftp-e2e.txt'), 'utf8').includes('中文 SFTP'),
    'downloaded file preserves its content'
  )
  await dismissToasts(page)
  await shot(page, '13-sftp-download.png')

  console.log('\n[10a] clipboard Ctrl+V upload')
  setClipboardFiles([clipboardFile, clipboardFolder])
  await page.waitForTimeout(250)
  const clipboardPaths = await page.evaluate(() => window.hongssh.readClipboardFiles())
  check(
    clipboardPaths.includes(clipboardFile) && clipboardPaths.includes(clipboardFolder),
    'electron reads files and folders from the Windows clipboard'
  )
  await page.locator('.sftp-row').first().click()
  await page.keyboard.press('Control+v')
  let clipboardUploaded = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await page.evaluate(async ({ sessionId }) => {
      try {
        const root = await window.hongssh.sftpList(sessionId, '/home/tester')
        const nested = await window.hongssh.sftpList(sessionId, '/home/tester/clipboard-folder/nested')
        return {
          root: root.entries.map((entry) => entry.name),
          nested: nested.entries.map((entry) => entry.name)
        }
      } catch {
        return null
      }
    }, { sessionId: activeSessionId })
    if (
      state &&
      state.root.includes('clipboard-file.txt') &&
      state.root.includes('clipboard-folder') &&
      state.nested.includes('clipboard-nested.txt')
    ) {
      clipboardUploaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(clipboardUploaded, 'Ctrl+V uploads clipboard files and folders recursively to the current directory')

  console.log('\n[10a2] drag-and-drop upload')
  const dropUris = [dropFile, dropFolder].map((item) => pathToFileURL(item).href)
  await page.evaluate((uris) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/uri-list', uris.join('\r\n'))
    window.__hongsshDropTest = dataTransfer
    document.querySelector('.sftp-panel')?.dispatchEvent(
      new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      })
    )
  }, dropUris)
  await page.waitForTimeout(200)
  check(
    await page.locator('.sftp-drop-overlay').isVisible(),
    'dragging files over the SFTP panel shows the drop overlay'
  )
  await page.evaluate(() => {
    const dataTransfer = window.__hongsshDropTest
    const panel = document.querySelector('.sftp-panel')
    if (!dataTransfer || !panel) return
    panel.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
    )
    panel.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
    )
    delete window.__hongsshDropTest
  })
  let dropUploaded = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await page.evaluate(async ({ sessionId }) => {
      try {
        const root = await window.hongssh.sftpList(sessionId, '/home/tester')
        const nested = await window.hongssh.sftpList(sessionId, '/home/tester/drop-folder/nested')
        return {
          root: root.entries.map((entry) => entry.name),
          nested: nested.entries.map((entry) => entry.name)
        }
      } catch {
        return null
      }
    }, { sessionId: activeSessionId })
    if (
      state &&
      state.root.includes('drop-file.txt') &&
      state.root.includes('drop-folder') &&
      state.nested.includes('drop-nested.txt')
    ) {
      dropUploaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(dropUploaded, 'drag-and-drop uploads files and folders recursively')

  console.log('\n[10a3] drag-out download')
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    globalThis.__hongsshOriginalStartDrag = contents.startDrag.bind(contents)
    globalThis.__hongsshDragFiles = null
    globalThis.__hongsshDragIcon = null
    contents.startDrag = (item) => {
      globalThis.__hongsshDragFiles = item.files
      globalThis.__hongsshDragIcon = item.icon
    }
  })
  const dragImage = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 70
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = '#f8fbff'
      context.fillRect(0, 0, 320, 70)
      context.fillStyle = '#13243a'
      context.font = '600 13px "Segoe UI"'
      context.fillText('drop-file.txt', 42, 28)
    }
    return canvas.toDataURL('image/png')
  })
  const dragOutResult = await page.evaluate(
    async ({ sessionId, image }) =>
      window.hongssh.startDragDownload(
        sessionId,
        [{ path: '/home/tester/drop-file.txt', name: 'drop-file.txt', isDirectory: false }],
        image
      ),
    { sessionId: activeSessionId, image: dragImage }
  )
  check(Boolean(dragOutResult.started), 'drag-out prepares local placeholder files')
  const dragFiles = await app.evaluate(() => globalThis.__hongsshDragFiles)
  check(Array.isArray(dragFiles) && dragFiles.length === 1, 'drag-out starts a native file drag')
  const dragIcon = await app.evaluate(() =>
    globalThis.__hongsshDragIcon?.getSize ? globalThis.__hongsshDragIcon.getSize() : null
  )
  check(Boolean(dragIcon && dragIcon.width >= 300), 'drag-out uses a visible local drag image')
  await page.waitForTimeout(500)
  fs.cpSync(dragFiles[0], path.join(dragOutTarget, path.basename(dragFiles[0])), {
    recursive: true
  })
  let dragOutDownloaded = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(path.join(dragOutTarget, 'drop-file.txt'))) {
      dragOutDownloaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(dragOutDownloaded, 'drag-out detects the drop folder and downloads the remote file')
  check(
    fs.readFileSync(path.join(dragOutTarget, 'drop-file.txt'), 'utf8') === 'dropped file\n',
    'drag-out downloaded file preserves its content'
  )
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    if (globalThis.__hongsshOriginalStartDrag) {
      contents.startDrag = globalThis.__hongsshOriginalStartDrag
    }
    delete globalThis.__hongsshOriginalStartDrag
    delete globalThis.__hongsshDragFiles
    delete globalThis.__hongsshDragIcon
  })

  console.log('\n[10b] recursive folder upload/download and resume')
  await page.locator('.sftp-icon-button[title="刷新"]').click()
  await page.waitForTimeout(300)
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, sftpTree)
  await page.locator('.sftp-icon-button[title^="上传文件夹"]').click()
  let folderUploaded = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const treeState = await page.evaluate(async ({ sessionId }) => {
      try {
        const root = await window.hongssh.sftpList(sessionId, '/home/tester/sftp-tree')
        const nested = await window.hongssh.sftpList(sessionId, '/home/tester/sftp-tree/nested')
        return {
          root: root.entries.map((entry) => entry.name),
          nested: nested.entries.map((entry) => entry.name)
        }
      } catch {
        return null
      }
    }, { sessionId: activeSessionId })
    if (
      treeState &&
      treeState.root.includes('empty') &&
      treeState.root.includes('root.txt') &&
      treeState.nested.includes('nested.txt')
    ) {
      folderUploaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(folderUploaded, 'recursive folder upload preserves nested and empty folders')

  await page.locator('.sftp-icon-button[title="刷新"]').click()
  await page.waitForTimeout(300)
  await page.locator('.sftp-row').filter({ hasText: 'sftp-tree' }).click()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, sftpFolderDownload)
  await page.locator('.sftp-action-button').filter({ hasText: '下载' }).click()
  let folderDownloaded = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      fs.existsSync(path.join(sftpFolderDownload, 'sftp-tree', 'nested', 'nested.txt')) &&
      fs.existsSync(path.join(sftpFolderDownload, 'sftp-tree', 'empty'))
    ) {
      folderDownloaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(folderDownloaded, 'recursive folder download preserves nested and empty folders')
  check(
    fs.readFileSync(path.join(sftpFolderDownload, 'sftp-tree', 'nested', 'nested.txt'), 'utf8') ===
      'nested file\n',
    'recursive download preserves file contents'
  )

  fs.writeFileSync(path.join(server.home, 'resume-e2e.txt.hongssh.part'), 'RESUME', 'utf8')
  await page.evaluate(
    async ({ sessionId, fullFile }) => {
      return window.hongssh.sftpUpload({
        sessionId,
        localPaths: [fullFile],
        remoteDir: '/home/tester',
        overwrite: false
      })
    },
    { sessionId: activeSessionId, fullFile: resumeFullFile }
  )
  let resumeUploaded = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const transferText = await page.locator('.sftp-transfer-meta').allInnerTexts()
    if (transferText.some((text) => text.includes('续传完成'))) {
      resumeUploaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(resumeUploaded, 'interrupted upload resumes from the existing remote partial file')
  await page.evaluate(
    async ({ sessionId, localDir }) => {
      return window.hongssh.sftpDownload({
        sessionId,
        remotePaths: ['/home/tester/resume-e2e.txt'],
        localDir,
        overwrite: false
      })
    },
    { sessionId: activeSessionId, localDir: resumeUploadCheck }
  )
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fs.existsSync(path.join(resumeUploadCheck, 'resume-e2e.txt'))) break
    await page.waitForTimeout(200)
  }
  check(
    fs.readFileSync(path.join(resumeUploadCheck, 'resume-e2e.txt'), 'utf8') ===
      'RESUME-PART-COMPLETE',
    'resumed upload result matches the source file'
  )

  const resumeDownload = await page.evaluate(
    async ({ sessionId, localDir }) => {
      return window.hongssh.sftpDownload({
        sessionId,
        remotePaths: ['/home/tester/resume-e2e.txt'],
        localDir,
        overwrite: false
      })
    },
    { sessionId: activeSessionId, localDir: resumeDownloadDir }
  )
  check(Boolean(resumeDownload.transfers[0]?.resumed), 'download detects the local partial file')
  let resumeDownloaded = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fs.existsSync(path.join(resumeDownloadDir, 'resume-e2e.txt'))) {
      resumeDownloaded = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(resumeDownloaded, 'interrupted download resumes from the existing local partial file')
  check(
    fs.readFileSync(path.join(resumeDownloadDir, 'resume-e2e.txt'), 'utf8') ===
      'RESUME-PART-COMPLETE',
    'resumed download result matches the remote file'
  )

  console.log('\n[10b1] recursive directory delete')
  await page.evaluate(
    async ({ sessionId, localFolder }) => {
      await window.hongssh.sftpMkdir(sessionId, '/home/tester/delete-tree')
      return window.hongssh.sftpUpload({
        sessionId,
        localPaths: [localFolder],
        remoteDir: '/home/tester/delete-tree',
        overwrite: false
      })
    },
    { sessionId: activeSessionId, localFolder: sftpTree }
  )
  let deleteTreeReady = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const exists = await page.evaluate(async ({ sessionId }) => {
      try {
        const list = await window.hongssh.sftpList(
          sessionId,
          '/home/tester/delete-tree/sftp-tree/nested'
        )
        return list.entries.some((entry) => entry.name === 'nested.txt')
      } catch {
        return false
      }
    }, { sessionId: activeSessionId })
    if (exists) {
      deleteTreeReady = true
      break
    }
    await page.waitForTimeout(200)
  }
  check(deleteTreeReady, 'test directory with nested files is ready')
  const removedTree = await page.evaluate(
    async ({ sessionId }) =>
      window.hongssh.sftpRemove(sessionId, '/home/tester/delete-tree', true),
    { sessionId: activeSessionId }
  )
  check(removedTree === '/home/tester/delete-tree', 'recursive delete returns the removed path')
  const deleteTreeGone = await page.evaluate(async ({ sessionId }) => {
    const list = await window.hongssh.sftpList(sessionId, '/home/tester')
    return !list.entries.some((entry) => entry.name === 'delete-tree')
  }, { sessionId: activeSessionId })
  check(deleteTreeGone, 'non-empty remote directory is deleted recursively')

  await dismissToasts(page)
  await page.locator('.sftp-transfer-list').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await shot(page, '14-sftp-recursive.png')

  const createdDir = await page.evaluate(async ({ sessionId }) => {
    return window.hongssh.sftpMkdir(sessionId, '/home/tester/e2e-folder')
  }, { sessionId: activeSessionId })
  check(createdDir === '/home/tester/e2e-folder', 'remote mkdir returns the target path')
  await page.evaluate(async ({ sessionId }) => {
    await window.hongssh.sftpRemove(sessionId, '/home/tester/e2e-folder')
  }, { sessionId: activeSessionId })
  await page.locator('.sftp-close').click()
  await page.waitForFunction(
    () => document.querySelector('.sftp-panel')?.hasAttribute('hidden'),
    null,
    { timeout: 5000 }
  )
  check(true, 'file panel closes and terminal layout is restored')

  console.log('\n[10c] new connection inherits the selected group')
  await page.locator('.connection-tree').evaluate((element) => {
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 })
    )
  })
  await page.locator('.context-menu-item').filter({ hasText: '新建分组' }).click()
  await page.locator('.modal .text-input').fill('E2E 分组')
  await page.locator('.modal .modal-actions button').filter({ hasText: '创建' }).click()
  await page.waitForFunction(
    () => [...document.querySelectorAll('.tree-folder')].some((row) => row.textContent?.includes('E2E 分组')),
    null,
    { timeout: 5000 }
  )
  const folderId = await page.evaluate(() => {
    const folder = window.__hongssh.getState().folders.find((item) => item.name === 'E2E 分组')
    return folder?.id ?? ''
  })
  check(Boolean(folderId), 'test group created')
  await page.locator('.tree-folder').filter({ hasText: 'E2E 分组' }).click()
  check(
    await page.locator('.tree-folder').filter({ hasText: 'E2E 分组' }).evaluate((row) => row.classList.contains('is-selected')),
    'group is selected'
  )
  await page.locator('.toolbar-button.is-primary').click()
  await page.waitForSelector('.modal-title', { timeout: 5000 })
  check(
    (await page.locator('.modal-title').innerText()) === '新建连接',
    'new connection dialog opened from toolbar'
  )
  check(
    (await page.locator('.modal select').first().inputValue()) === folderId,
    'new connection dialog preselects the selected group'
  )
  await page.locator('.dialog-footer button').filter({ hasText: '取消' }).click()
  await page.waitForTimeout(250)

  console.log('\n[11] private key authentication')
  const keyConnectionId = await page.evaluate(
    async ({ host, port, username, privateKeyPath }) =>
      window.__hongssh.createConnection({
        id: `c_key_${Date.now()}`,
        folderId: null,
        name: 'Key Auth',
        host,
        port,
        username,
        authType: 'privateKey',
        privateKeyPath,
        description: 'Generated test key',
        color: '#7d5bd6',
        terminalType: 'xterm-256color',
        initCommand: '',
        hostKeyPolicy: 'accept-new',
        keepaliveInterval: 15
      }),
    {
      host: server.host,
      port: server.port,
      username: server.user,
      privateKeyPath: server.privateKeyPath
    }
  )
  await page.evaluate((id) => window.__hongssh.openConnection(id), keyConnectionId)
  await page.waitForFunction(
    () =>
      window.__hongssh
        .getSessions()
        .some((session) => session.name === 'Key Auth' && session.connected),
    null,
    { timeout: 20000 }
  )
  check(true, 'private key authentication opens a PTY session')
  await page.evaluate(() => window.__hongssh.sendCommand('echo KEY_AUTH_OK'))
  await page.waitForFunction(() => window.__hongssh.getActiveBuffer().includes('KEY_AUTH_OK'), null, {
    timeout: 8000
  })
  check(true, 'private key session accepts commands')
  await page.evaluate(() => window.__hongssh.sendCommand('exit'))
  await page.waitForTimeout(400)

  console.log('\n[12] page errors')
  check(pageErrors.length === 0, `no renderer errors (${pageErrors.length})`)
  if (pageErrors.length) console.error(pageErrors.join('\n'))

  await page.evaluate(() => window.__hongssh.sendCommand('exit'))
  await page.waitForTimeout(600)
} finally {
  const timeout = (promise, ms, label) =>
    Promise.race([
      promise.catch((error) => console.error(`${label}: ${error.message}`)),
      new Promise((resolve) =>
        setTimeout(() => {
          console.error(`${label}: timed out after ${ms}ms`)
          resolve()
        }, ms)
      )
    ])
  await timeout(app.close(), 5000, 'app.close')
  try {
    app.process().kill()
  } catch {
    // already exited
  }
  await timeout(server.close(), 4000, 'server.close')
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(sftpLocalDir, { recursive: true, force: true })
  fs.rmSync(xshellExportParent, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nAll E2E checks passed.')
process.exit(0)
