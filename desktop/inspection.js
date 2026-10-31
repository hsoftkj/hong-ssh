'use strict'

/**
 * Disk inspection shared between the SSH manager and unit tests. The command
 * uses the POSIX output format so parsing stays stable across distributions.
 */
const INSPECTION_COMMAND = 'LC_ALL=C df -P -k 2>/dev/null || df -P -k 2>/dev/null'

const PSEUDO_FILESYSTEMS = new Set([
  'tmpfs',
  'devtmpfs',
  'udev',
  'shm',
  'none',
  'efivarfs',
  'squashfs'
])

const PSEUDO_MOUNTS = new Set(['/dev', '/proc', '/sys', '/run'])

function clampInspectionThreshold(value) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return 90
  return Math.min(100, Math.max(1, number))
}

function isPseudoMount(mount) {
  if (PSEUDO_MOUNTS.has(mount)) return true
  return mount.startsWith('/snap/')
}

function parseDfOutput(output) {
  const disks = []
  const seenMounts = new Set()
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/)
    if (!match) continue
    const filesystem = match[1]
    const sizeKb = Number(match[2])
    const usedKb = Number(match[3])
    const availableKb = Number(match[4])
    const usagePercent = Number(match[5])
    const mount = match[6].trim()
    if (!mount || seenMounts.has(mount)) continue
    if (PSEUDO_FILESYSTEMS.has(filesystem.toLowerCase())) continue
    if (isPseudoMount(mount)) continue
    if (!Number.isFinite(sizeKb) || sizeKb <= 0) continue
    if (!Number.isFinite(usedKb) || usedKb < 0) continue
    if (!Number.isFinite(availableKb) || availableKb < 0) continue
    if (!Number.isFinite(usagePercent)) continue
    seenMounts.add(mount)
    disks.push({
      filesystem,
      mount,
      sizeKb,
      usedKb,
      availableKb,
      usagePercent: Math.min(100, Math.max(0, usagePercent))
    })
  }
  return disks.sort((left, right) => right.usagePercent - left.usagePercent)
}

module.exports = {
  INSPECTION_COMMAND,
  clampInspectionThreshold,
  parseDfOutput
}
