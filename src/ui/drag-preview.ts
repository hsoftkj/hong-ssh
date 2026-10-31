import type { DragDownloadItem } from '../types'

const DPR = 2
const WIDTH = 320
const PADDING = 12
const ROW_HEIGHT = 46

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.arcTo(x, y + height, x, y, r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
}

function ellipsize(context: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (context.measureText(value).width <= maxWidth) return value
  let text = value
  while (text.length > 1 && context.measureText(`${text}…`).width > maxWidth) {
    text = text.slice(0, -1)
  }
  return `${text}…`
}

function drawFolderIcon(context: CanvasRenderingContext2D, x: number, y: number): void {
  context.save()
  context.shadowColor = 'rgba(130, 82, 0, 0.18)'
  context.shadowBlur = 3
  context.shadowOffsetY = 1
  context.fillStyle = '#f0b43c'
  roundedRect(context, x, y + 4, 30, 22, 4)
  context.fill()
  context.shadowColor = 'transparent'
  roundedRect(context, x, y, 20, 9, 3)
  context.fill()
  context.fillStyle = 'rgba(255, 255, 255, 0.25)'
  roundedRect(context, x + 2, y + 6, 26, 3, 1.5)
  context.fill()
  context.restore()
}

function drawFileIcon(context: CanvasRenderingContext2D, x: number, y: number): void {
  context.save()
  context.shadowColor = 'rgba(18, 60, 110, 0.16)'
  context.shadowBlur = 3
  context.shadowOffsetY = 1
  context.fillStyle = '#f7fbff'
  context.strokeStyle = '#6da8ef'
  context.lineWidth = 1.4
  context.beginPath()
  context.moveTo(x + 4, y + 1)
  context.lineTo(x + 20, y + 1)
  context.lineTo(x + 27, y + 8)
  context.lineTo(x + 27, y + 29)
  context.arcTo(x + 27, y + 31, x + 25, y + 31, 2)
  context.lineTo(x + 4, y + 31)
  context.arcTo(x + 2, y + 31, x + 2, y + 29, 2)
  context.lineTo(x + 2, y + 3)
  context.arcTo(x + 2, y + 1, x + 4, y + 1, 2)
  context.closePath()
  context.fill()
  context.stroke()
  context.shadowColor = 'transparent'
  context.fillStyle = '#cfe6ff'
  context.beginPath()
  context.moveTo(x + 20, y + 1)
  context.lineTo(x + 20, y + 8)
  context.lineTo(x + 27, y + 8)
  context.closePath()
  context.fill()
  context.strokeStyle = '#9ac5f7'
  context.lineWidth = 1
  for (let line = 0; line < 3; line += 1) {
    context.beginPath()
    context.moveTo(x + 7, y + 14 + line * 5)
    context.lineTo(x + 21, y + 14 + line * 5)
    context.stroke()
  }
  context.restore()
}

export function createDragPreview(items: DragDownloadItem[]): string {
  if (items.length === 0) return ''
  const rows = Math.min(items.length, 3)
  const extra = items.length > rows ? items.length - rows : 0
  const height = PADDING * 2 + rows * ROW_HEIGHT + (extra > 0 ? 22 : 0)
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH * DPR
  canvas.height = height * DPR
  const context = canvas.getContext('2d')
  if (!context) return ''
  context.scale(DPR, DPR)

  context.save()
  context.shadowColor = 'rgba(14, 35, 60, 0.3)'
  context.shadowBlur = 14
  context.shadowOffsetY = 5
  context.fillStyle = '#f8fbff'
  roundedRect(context, 1, 1, WIDTH - 2, height - 2, 13)
  context.fill()
  context.restore()
  context.strokeStyle = '#c8d8ea'
  context.lineWidth = 1
  roundedRect(context, 1, 1, WIDTH - 2, height - 2, 13)
  context.stroke()

  for (let index = 0; index < rows; index += 1) {
    const item = items[index]
    const top = PADDING + index * ROW_HEIGHT
    if (index > 0) {
      context.strokeStyle = '#e8eff8'
      context.beginPath()
      context.moveTo(PADDING, top)
      context.lineTo(WIDTH - PADDING, top)
      context.stroke()
    }
    const iconY = top + 8
    if (item.isDirectory) drawFolderIcon(context, PADDING, iconY)
    else drawFileIcon(context, PADDING, iconY)

    context.fillStyle = '#13243a'
    context.font = '600 13px "Segoe UI", "Microsoft YaHei UI", sans-serif'
    context.textBaseline = 'middle'
    const name = ellipsize(context, item.name, WIDTH - PADDING * 2 - 42)
    context.fillText(name, PADDING + 40, top + 17)

    context.fillStyle = '#718196'
    context.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif'
    context.fillText(item.isDirectory ? '文件夹' : '文件', PADDING + 40, top + 33)
  }

  if (extra > 0) {
    context.fillStyle = '#718196'
    context.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif'
    context.textBaseline = 'middle'
    context.fillText(
      `还有 ${extra} 项`,
      PADDING,
      PADDING + rows * ROW_HEIGHT + 11
    )
  }

  return canvas.toDataURL('image/png')
}
