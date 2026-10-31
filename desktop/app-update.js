'use strict'

/**
 * Hong desktop applications update client.
 *
 * This file is intentionally dependency-free and copied verbatim into the
 * HongSSH and HongDBM desktop shells. It talks to the hong-app-update service,
 * downloads the assigned installer, verifies SHA-256 and starts the silent NSIS
 * upgrade before the Electron process exits.
 */

const { app, dialog, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

function envFlag(name) {
    const value = String(process.env[name] || '').toLowerCase()
    return value === '1' || value === 'true' || value === 'yes'
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function versionCodeOf(version) {
    const clean = String(version || '').trim().replace(/^[vV]/, '')
    const parts = clean.split('.')
    if (parts.length < 2) return 0
    const values = [0, 0, 0, 0]
    for (let index = 0; index < Math.min(parts.length, 4); index += 1) {
        const value = Number(parts[index])
        if (!Number.isInteger(value) || value < 0) return 0
        values[index] = value
    }
    const [major, minor, patch, build] = values
    if (major < 0 || major > 9 || minor > 99 || patch > 999 || build > 999) return 0
    return major * 100000000 + minor * 1000000 + patch * 1000 + build
}

function localIpv4() {
    const interfaces = os.networkInterfaces()
    const candidates = []
    for (const [name, addresses] of Object.entries(interfaces)) {
        for (const address of addresses || []) {
            if (address.family !== 'IPv4' || address.internal) continue
            candidates.push({ name: name.toLowerCase(), address: address.address })
        }
    }
    const preferred = candidates.find((item) =>
        !/(vmware|virtualbox|vbox|hyper-v|vethernet|loopback|docker|wsl)/.test(item.name)
        && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))
    return (preferred || candidates[0] || {}).address || '127.0.0.1'
}

function windowsMachineGuid() {
    if (process.platform !== 'win32') return ''
    try {
        const output = execFileSync('reg', [
            'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
        ], { encoding: 'utf8', windowsHide: true, timeout: 2500 })
        const match = output.match(/MachineGuid\s+REG_\w+\s+([0-9a-fA-F-]+)/)
        return match ? match[1] : ''
    } catch {
        return ''
    }
}

function stableMachineId() {
    const base = process.env.LOCALAPPDATA || app.getPath('userData')
    const directory = path.join(base, 'HongUpdate')
    const file = path.join(directory, 'machine-id')
    try {
        const existing = fs.readFileSync(file, 'utf8').trim()
        if (/^[0-9a-f]{64}$/i.test(existing)) return existing
    } catch {
        // First launch.
    }
    const macs = []
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (!address.internal && address.mac && address.mac !== '00:00:00:00:00:00') {
                macs.push(address.mac)
            }
        }
    }
    const seed = [
        windowsMachineGuid(),
        os.hostname(),
        os.userInfo().username,
        ...macs.sort()
    ].join('|')
    const machineId = crypto.createHash('sha256').update(seed).digest('hex')
    try {
        fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(file, machineId, 'utf8')
    } catch {
        // A stable in-memory id is still better than failing the update check.
    }
    return machineId
}

function sanitizeFileName(name) {
    const base = path.basename(String(name || 'update-setup.exe'))
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '')
    return base || 'update-setup.exe'
}

function requestJson(serverUrl, pathname, payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const target = new URL(pathname, serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`)
        const transport = target.protocol === 'https:' ? https : http
        const body = Buffer.from(JSON.stringify(payload || {}), 'utf8')
        const request = transport.request(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': body.length,
                'User-Agent': `HongUpdater/${app.getVersion()}`
            },
            timeout: timeoutMs
        }, (response) => {
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                let parsed = null
                try {
                    parsed = text ? JSON.parse(text) : null
                } catch {
                    // Keep the raw body for the error message.
                }
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(parsed)
                    return
                }
                const message = parsed && parsed.error ? parsed.error : `更新服务返回 HTTP ${response.statusCode}`
                reject(new Error(message))
            })
        })
        request.on('timeout', () => request.destroy(new Error('连接更新服务超时')))
        request.on('error', reject)
        request.write(body)
        request.end()
    })
}

function downloadFile(url, destination, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error('下载地址重定向次数过多'))
            return
        }
        const target = new URL(url)
        const transport = target.protocol === 'https:' ? https : http
        const request = transport.get(target, {
            headers: { 'User-Agent': `HongUpdater/${app.getVersion()}` },
            timeout: 120000
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume()
                const next = new URL(response.headers.location, target).toString()
                downloadFile(next, destination, onProgress, redirects + 1).then(resolve, reject)
                return
            }
            if (response.statusCode !== 200) {
                response.resume()
                reject(new Error(`下载安装包失败：HTTP ${response.statusCode}`))
                return
            }
            const total = Number(response.headers['content-length'] || 0)
            let received = 0
            const output = fs.createWriteStream(destination)
            response.on('data', (chunk) => {
                received += chunk.length
                if (typeof onProgress === 'function') onProgress(received, total)
            })
            response.on('error', reject)
            output.on('error', reject)
            output.on('finish', () => output.close(() => resolve({ received, total })))
            response.pipe(output)
        })
        request.on('timeout', () => request.destroy(new Error('下载安装包超时')))
        request.on('error', reject)
    })
}

async function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const input = fs.createReadStream(file)
        input.on('error', reject)
        input.on('data', (chunk) => hash.update(chunk))
        input.on('end', () => resolve(hash.digest('hex')))
    })
}

class AppUpdater {
    constructor(options) {
        this.app = app
        this.dialog = dialog
        this.shell = shell
        this.programCode = options.programCode
        this.serverUrl = String(options.serverUrl || 'http://127.0.0.1:9188').replace(/\/+$/, '')
        this.stateDir = options.stateDir || app.getPath('userData')
        this.getWindow = options.getWindow || (() => null)
        this.onBeforeInstall = options.onBeforeInstall || (async () => {})
        this.log = options.log || ((message) => console.log(message))
        this.machineId = stableMachineId()
        this.lastState = { phase: 'idle', message: '尚未检查更新' }
        this.checkInFlight = false
        this.startTimer = null
        this.intervalTimer = null
    }

    stateFile() {
        return path.join(this.stateDir, 'update-state.json')
    }

    writeState(patch) {
        this.lastState = {
            ...this.lastState,
            ...patch,
            programCode: this.programCode,
            currentVersion: this.app.getVersion(),
            currentVersionCode: versionCodeOf(this.app.getVersion()),
            machineId: this.machineId,
            serverUrl: this.serverUrl,
            updatedAt: new Date().toISOString()
        }
        try {
            fs.mkdirSync(this.stateDir, { recursive: true })
            fs.writeFileSync(this.stateFile(), JSON.stringify(this.lastState, null, 2), 'utf8')
        } catch {
            // Update state is diagnostic only.
        }
        return this.lastState
    }

    getState() {
        return { ...this.lastState }
    }

    info() {
        return {
            programCode: this.programCode,
            currentVersion: this.app.getVersion(),
            currentVersionCode: versionCodeOf(this.app.getVersion()),
            machineId: this.machineId,
            loginUser: os.userInfo().username,
            localIp: localIpv4(),
            serverUrl: this.serverUrl,
            stateFile: this.stateFile()
        }
    }

    start() {
        if (envFlag('HONG_UPDATE_DISABLED')) {
            this.writeState({ phase: 'disabled', message: '更新客户端已通过环境变量停用' })
            return
        }
        const auto = envFlag('HONG_UPDATE_AUTO')
        const delayMs = Math.max(400, Number(process.env.HONG_UPDATE_CHECK_DELAY_MS || (auto ? 2500 : 12000)))
        this.log(`[update] ${this.programCode} updater started, server=${this.serverUrl}, auto=${auto}`)
        this.startTimer = setTimeout(() => {
            this.checkForUpdates({ interactive: false, auto }).catch((error) => {
                this.log(`[update] automatic check failed: ${error.message}`)
            })
        }, delayMs)
        if (this.startTimer.unref) this.startTimer.unref()
        const intervalSeconds = Math.max(600, Number(process.env.HONG_UPDATE_CHECK_INTERVAL_SECONDS || 21600))
        this.intervalTimer = setInterval(() => {
            this.checkForUpdates({ interactive: false, auto }).catch(() => {})
        }, intervalSeconds * 1000)
        if (this.intervalTimer.unref) this.intervalTimer.unref()
    }

    stop() {
        clearTimeout(this.startTimer)
        clearInterval(this.intervalTimer)
    }

    async report(taskId, status, progress, message) {
        if (!taskId) return
        try {
            await requestJson(this.serverUrl, '/api/client/progress', {
                taskId,
                machineId: this.machineId,
                status,
                progress,
                message
            }, 10000)
        } catch (error) {
            this.log(`[update] progress report failed (${status}): ${error.message}`)
        }
    }

    async checkForUpdates(options = {}) {
        const interactive = options.interactive === true
        const auto = options.auto === true || envFlag('HONG_UPDATE_AUTO')
        if (this.checkInFlight) return this.getState()
        this.checkInFlight = true
        this.writeState({ phase: 'checking', message: '正在检查更新' })
        try {
            const body = {
                machineId: this.machineId,
                programCode: this.programCode,
                currentVersion: this.app.getVersion(),
                currentVersionCode: versionCodeOf(this.app.getVersion()),
                userId: process.env.HONG_UPDATE_USER_ID || null,
                loginUser: os.userInfo().username,
                localIp: localIpv4(),
                osInfo: `${os.type()} ${os.release()} ${os.arch()}`,
                installPath: path.dirname(this.app.getPath('exe'))
            }
            const response = await requestJson(this.serverUrl, '/api/client/check', body)
            this.lastServerResponse = response
            if (response && response.update) {
                this.writeState({
                    phase: 'available',
                    message: `发现新版本 ${response.update.version}`,
                    update: response.update,
                    latestVersion: response.latestVersion || null
                })
                this.log(`[update] update available: ${response.update.version} (${response.update.versionCode})`)
                if (auto) {
                    await this.downloadAndInstall(response.update)
                } else {
                    await this.promptInstall(response.update)
                }
                return this.getState()
            }
            this.writeState({
                phase: 'up-to-date',
                message: response && response.message ? response.message : '当前已是最新版本',
                latestVersion: response ? response.latestVersion : null,
                update: null
            })
            if (interactive) {
                const latest = response && response.latestVersion
                await this.messageBox({
                    type: 'info',
                    title: '检查更新',
                    message: latest ? `当前已是最新版本 ${this.app.getVersion()}` : '当前没有可用更新',
                    detail: latest
                        ? `服务端最新版本：${latest.version}\n当前版本：${this.app.getVersion()}`
                        : '管理员尚未发布新版本，或没有给本设备分配升级任务。',
                    buttons: ['确定']
                })
            }
            return this.getState()
        } catch (error) {
            this.writeState({ phase: 'error', message: error.message })
            this.log(`[update] check failed: ${error.stack || error.message}`)
            if (interactive) {
                await this.messageBox({
                    type: 'error',
                    title: '检查更新失败',
                    message: '无法连接软件更新服务',
                    detail: `${error.message}\n\n服务地址：${this.serverUrl}`,
                    buttons: ['确定']
                })
            }
            return this.getState()
        } finally {
            this.checkInFlight = false
        }
    }

    async promptInstall(update) {
        const notes = update.releaseNotes ? `\n\n更新说明：\n${String(update.releaseNotes).slice(0, 1200)}` : ''
        const result = await this.messageBox({
            type: 'info',
            title: '发现新版本',
            message: `Hong 更新中心发现 ${update.version}`,
            detail: `当前版本：${this.app.getVersion()}\n目标版本：${update.version}（${update.versionCode}）`
                + `${update.mandatory ? '\n此版本为强制升级。' : ''}${notes}`,
            buttons: ['立即更新', '稍后'],
            defaultId: 0,
            cancelId: 1
        })
        if (result.response === 0) {
            await this.downloadAndInstall(update)
        } else {
            this.writeState({ phase: 'available', message: '用户选择稍后更新', update })
        }
    }

    async downloadAndInstall(update) {
        const taskId = update.taskId
        const tempDir = path.join(this.stateDir, 'updates')
        fs.mkdirSync(tempDir, { recursive: true })
        const fileName = sanitizeFileName(update.fileName || `Hong-${update.version}-setup.exe`)
        const destination = path.join(tempDir, fileName)
        try {
            await this.report(taskId, 'DOWNLOADING', 1, '开始下载安装包')
            this.writeState({ phase: 'downloading', message: `正在下载 ${update.version}`, progress: 0, update })
            let lastPercent = -1
            let lastReport = 0
            await downloadFile(update.downloadUrl, destination, (received, total) => {
                const percent = total > 0 ? Math.min(95, Math.round((received / total) * 90)) : 0
                if (percent !== lastPercent && Date.now() - lastReport > 1200) {
                    lastPercent = percent
                    lastReport = Date.now()
                    this.writeState({
                        phase: 'downloading',
                        message: `正在下载 ${update.version}`,
                        progress: percent,
                        received,
                        total,
                        update
                    })
                    void this.report(taskId, 'DOWNLOADING', percent, `下载中 ${percent}%`)
                }
            })

            if (update.sha256) {
                const actual = await sha256File(destination)
                if (actual.toLowerCase() !== String(update.sha256).toLowerCase()) {
                    throw new Error('安装包 SHA-256 校验失败，已阻止安装')
                }
            }
            fs.chmodSync(destination, 0o755)
            this.writeState({ phase: 'ready', message: '安装包已校验，准备安装', progress: 100, update })
            await this.report(taskId, 'INSTALLING', 100, '安装包下载并校验完成，开始安装')
            await this.install(destination, update)
        } catch (error) {
            this.log(`[update] download/install failed: ${error.stack || error.message}`)
            this.writeState({ phase: 'error', message: error.message, update })
            await this.report(taskId, 'FAILED', 0, error.message.slice(0, 900))
            if (!envFlag('HONG_UPDATE_AUTO')) {
                await this.messageBox({
                    type: 'error',
                    title: '更新失败',
                    message: '安装包下载或校验失败',
                    detail: error.message,
                    buttons: ['确定']
                })
            }
        }
    }

    async install(installerPath, update) {
        if (process.platform !== 'win32') {
            this.writeState({ phase: 'manual', message: '当前系统需要手动安装', update })
            await this.shell.openPath(installerPath)
            return
        }
        if (!this.app.isPackaged && !envFlag('HONG_UPDATE_ALLOW_DEV')) {
            throw new Error('开发模式不执行自动安装，请以打包后的程序测试升级')
        }
        const lower = installerPath.toLowerCase()
        const command = lower.endsWith('.msi') ? 'msiexec.exe' : installerPath
        const overrideArgs = String(process.env.HONG_UPDATE_INSTALL_ARGS || '').trim()
        const args = lower.endsWith('.msi')
            ? ['/i', installerPath, '/qn', '/norestart']
            : (overrideArgs ? overrideArgs.split(/\s+/) : ['/S'])
        this.writeState({ phase: 'installing', message: '正在启动安装程序', progress: 100, update })
        this.log(`[update] starting installer: ${command} ${args.join(' ')}`)
        await new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            })
            child.once('spawn', () => {
                child.unref()
                resolve()
            })
            child.once('error', reject)
        })
        try {
            await this.onBeforeInstall()
        } catch (error) {
            this.log(`[update] pre-install cleanup failed: ${error.message}`)
        }
        await delay(900)
        this.log('[update] exiting for installer')
        this.app.exit(0)
    }

    messageBox(options) {
        const parent = this.getWindow()
        if (parent && !parent.isDestroyed()) {
            return this.dialog.showMessageBox(parent, options)
        }
        return this.dialog.showMessageBox(options)
    }
}

module.exports = {
    AppUpdater,
    versionCodeOf,
    stableMachineId,
    localIpv4
}
