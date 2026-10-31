import assert from 'node:assert/strict'
import test from 'node:test'

import { clampInspectionThreshold, parseDfOutput } from '../../desktop/inspection.js'

const SAMPLE = [
  'Filesystem     1024-blocks     Used Available Capacity Mounted on',
  '/dev/sda1          1024000   655360    368640      64% /',
  '/dev/sdb1          2048000  1945600    102400      95% /data',
  'tmpfs                16384        0     16384       0% /dev/shm',
  '/dev/loop0          102400   102400         0     100% /snap/core/1',
  'overlay            4096000  2048000   2048000      50% /var/lib/docker',
  '/dev/sdc1           512000   256000    256000      50% /mnt/my disk',
  '/dev/sdc1           512000   256000    256000      50% /mnt/my disk',
  'filesystem-with-a-long-name 1000 900 100 90% /srv',
  ''
].join('\r\n')

test('parses POSIX df output and keeps real mounts only', () => {
  const disks = parseDfOutput(SAMPLE)
  assert.deepEqual(
    disks.map((disk) => disk.mount),
    ['/data', '/srv', '/', '/var/lib/docker', '/mnt/my disk']
  )
  const data = disks[0]
  assert.equal(data.filesystem, '/dev/sdb1')
  assert.equal(data.sizeKb, 2048000)
  assert.equal(data.usedKb, 1945600)
  assert.equal(data.availableKb, 102400)
  assert.equal(data.usagePercent, 95)
  assert.equal(
    disks.some((disk) => disk.mount === '/dev/shm' || disk.mount.startsWith('/snap/')),
    false
  )
})

test('tolerates empty and malformed df output', () => {
  assert.deepEqual(parseDfOutput(''), [])
  assert.deepEqual(parseDfOutput('df: command not found\n'), [])
  assert.deepEqual(parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on\n'), [])
})

test('clamps the configurable threshold to a usable percentage', () => {
  assert.equal(clampInspectionThreshold(90), 90)
  assert.equal(clampInspectionThreshold('85'), 85)
  assert.equal(clampInspectionThreshold(0), 1)
  assert.equal(clampInspectionThreshold(101), 100)
  assert.equal(clampInspectionThreshold(90.6), 91)
  assert.equal(clampInspectionThreshold('nope'), 90)
})
