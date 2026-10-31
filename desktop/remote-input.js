'use strict'

const { spawn } = require('node:child_process')

// A persistent PowerShell helper receives one input command per line and uses
// Win32 APIs directly, avoiding a process spawn for every mouse move.
const HELPER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HongRemoteInput {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
try { [HongRemoteInput]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $p = $line.Split(' ')
    switch ($p[0]) {
      'M'  { [HongRemoteInput]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
      'MD' {
        $flag = @{ left = 0x0002; right = 0x0008; middle = 0x0020 }[$p[1]]
        if ($null -ne $flag) { [HongRemoteInput]::mouse_event([uint32]$flag, 0, 0, 0, [UIntPtr]::Zero) }
      }
      'MU' {
        $flag = @{ left = 0x0004; right = 0x0010; middle = 0x0040 }[$p[1]]
        if ($null -ne $flag) { [HongRemoteInput]::mouse_event([uint32]$flag, 0, 0, 0, [UIntPtr]::Zero) }
      }
      'W'  { [HongRemoteInput]::mouse_event([uint32]0x0800, 0, 0, [int]$p[1], [UIntPtr]::Zero) }
      'KD' {
        $ext = if ($p[2] -eq '1') { 0x0001 } else { 0 }
        [HongRemoteInput]::keybd_event([byte][int]$p[1], 0, [uint32]$ext, [UIntPtr]::Zero)
      }
      'KU' {
        $ext = if ($p[2] -eq '1') { 0x0001 } else { 0 }
        [HongRemoteInput]::keybd_event([byte][int]$p[1], 0, [uint32](0x0002 -bor $ext), [UIntPtr]::Zero)
      }
    }
  } catch {}
}
`

class InputInjector {
  constructor(logger) {
    this.logger = logger
    this.process = null
  }

  ensureProcess() {
    if (this.process && !this.process.killed && this.process.stdin?.writable) return true
    try {
      const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64')
      this.process = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }
      )
      this.process.on('exit', () => {
        this.process = null
      })
      this.process.on('error', (error) => {
        this.logger?.warn('remote input helper failed', error)
        this.process = null
      })
      return true
    } catch (error) {
      this.logger?.warn('could not start remote input helper', error)
      return false
    }
  }

  warmup() {
    this.ensureProcess()
  }

  send(command) {
    if (!this.ensureProcess()) return false
    try {
      this.process.stdin.write(`${command}\n`)
      return true
    } catch {
      return false
    }
  }

  move(x, y) {
    return this.send(`M ${Math.round(x)} ${Math.round(y)}`)
  }

  button(action, button) {
    const safe = button === 'right' || button === 'middle' ? button : 'left'
    return this.send(`${action === 'up' ? 'MU' : 'MD'} ${safe}`)
  }

  wheel(delta) {
    return this.send(`W ${Math.round(delta)}`)
  }

  key(action, vk, extended) {
    return this.send(`${action === 'up' ? 'KU' : 'KD'} ${vk} ${extended ? 1 : 0}`)
  }

  stop() {
    if (!this.process) return
    try {
      this.process.stdin.end()
    } catch {}
    const current = this.process
    this.process = null
    setTimeout(() => {
      try {
        current.kill()
      } catch {}
    }, 300)
  }
}

module.exports = { InputInjector }
