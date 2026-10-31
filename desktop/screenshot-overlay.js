'use strict'

const api = window.screenshot
const snapshot = document.getElementById('snapshot')
const dim = document.getElementById('dim')
const hint = document.getElementById('hint')
const selectionEl = document.getElementById('selection')
const canvas = document.getElementById('annotations')
const annotationSelection = document.getElementById('annotationSelection')
const badge = document.getElementById('sizeBadge')
const toolbar = document.getElementById('toolbar')
const toolMenu = document.getElementById('toolMenu')
const textEditor = document.getElementById('textEditor')
const textInput = document.getElementById('textInput')

const MIN_SIZE = 16
const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#111111']
const ARROW_PALETTE = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#00c7be',
  '#007aff',
  '#5856d6',
  '#af52de',
  '#ff2d55',
  '#a2845e',
  '#111111',
  '#636366',
  '#8e8e93',
  '#c7c7cc',
  '#ffffff',
  '#b3261e',
  '#1b7f3b',
  '#1e3a8a',
  '#d6009a',
  '#00a6d6'
]
const ARROW_STYLES = [
  ['solid', '实心箭头'],
  ['open', '开放式箭头'],
  ['hollow', '空心箭头'],
  ['tapered', '楔形实心箭头']
]

function defaultArrowAngle(style) {
  return style === 'solid' ? 25 : 65
}

function syncSelectedArrow() {
  if (state.menuTarget !== 'selected' || state.selected?.tool !== 'arrow') return
  state.selected.arrowStyle = state.arrowStyle
  state.selected.arrowAngle = state.arrowAngle
  redraw()
}
const TOOL_MENU_TOOLS = new Set(['rect', 'ellipse', 'pen', 'marker', 'arrow', 'text', 'mosaic'])
const TOOL_SIZES = {
  pen: [
    ['细 2px', 2],
    ['中 4px', 4],
    ['粗 8px', 8]
  ],
  marker: [
    ['细 10px', 10],
    ['中 16px', 16],
    ['粗 24px', 24]
  ],
  mosaic: [
    ['细 6px', 6],
    ['中 10px', 10],
    ['粗 16px', 16]
  ],
  text: [
    ['14px', 14],
    ['18px', 18],
    ['24px', 24],
    ['32px', 32]
  ]
}
const TEXT_FONTS = [
  ['"Microsoft YaHei UI", "Microsoft YaHei", sans-serif', '微软雅黑'],
  ['"SimSun", "Songti SC", serif', '宋体'],
  ['"SimHei", "Heiti SC", sans-serif', '黑体'],
  ['"KaiTi", "Kaiti SC", serif', '楷体'],
  ['"Consolas", "Courier New", monospace', 'Consolas'],
  ['"Arial", "Helvetica", sans-serif', 'Arial'],
  ['"Georgia", serif', 'Georgia']
]

const TOOLS = [
  ['select', '选择 / 移动', 'M5 3l14 8-6 1.2L10 19z'],
  ['pen', '画笔', 'M4 20l4-1L19 8l-3-3L5 16z M14 5l3 3'],
  ['marker', '荧光笔', 'M4 20h16 M7 16l8-8 4 4-8 8H7z'],
  ['rect', '矩形', 'M4 5h16v14H4z'],
  ['ellipse', '椭圆', 'M20 12a8 6 0 11-16 0 8 6 0 0116 0z'],
  ['arrow', '箭头', 'M4 20L20 4 M13 4h7v7'],
  ['text', '文字', 'M5 5h14 M12 5v14 M8 19h8'],
  ['mosaic', '马赛克', 'M4 4h16v16H4z M4 12h16 M12 4v16']
]

const ICONS = {
  undo: 'M9 7L4 12l5 5 M4 12h9a6 6 0 010 12',
  redo: 'M15 7l5 5-5 5 M20 12h-9a6 6 0 000 12',
  pin: 'M9 3h6l-1 6 4 4H6l4-4z M12 13v8',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  save: 'M5 3h11l3 3v15H5z M8 3v6h7V3 M8 21v-7h8v7',
  close: 'M6 6l12 12 M18 6L6 18'
}

const state = {
  display: null,
  ratio: 1,
  rect: null,
  tool: 'select',
  color: COLORS[0],
  arrowStyle: 'tapered',
  arrowAngle: 65,
  sizes: { pen: 4, marker: 16, mosaic: 10 },
  textFont: TEXT_FONTS[0][0],
  textSize: 18,
  mosaicTint: null,
  menuTool: null,
  menuTarget: null,
  selected: null,
  editOrigin: null,
  editingText: null,
  pixelCache: new Map(),
  annotations: [],
  redo: [],
  draft: null,
  mode: null,
  start: null,
  origin: null,
  handle: null,
  textPoint: null,
  sent: false
}

let toolButtons = new Map()
let arrowStyleSelect = null
let menuColorButtons = []
let mosaicNoneButton = null
let undoButton = null
let redoButton = null
let pinButton = null
let copyButton = null
let saveButton = null
let textCommitted = false

function svg(path, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function point(event) {
  return {
    x: clamp(event.clientX, 0, window.innerWidth),
    y: clamp(event.clientY, 0, window.innerHeight)
  }
}

function normalize(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

function contains(rect, p) {
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
}

function localPoint(event) {
  const rect = state.rect
  return {
    x: clamp(event.clientX - rect.x, 0, rect.width),
    y: clamp(event.clientY - rect.y, 0, rect.height)
  }
}

function cloneAnnotation(annotation) {
  return JSON.parse(JSON.stringify(annotation))
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

let measureContext = null

function textBounds(annotation) {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d')
  const fontSize = annotation.fontSize || 18
  const lines = String(annotation.text || '').split('\n')
  let width = 0
  if (measureContext) {
    measureContext.font = `600 ${fontSize}px ${annotation.fontFamily || TEXT_FONTS[0][0]}`
    for (const line of lines) width = Math.max(width, measureContext.measureText(line).width)
  }
  return {
    x: annotation.x,
    y: annotation.y,
    width: Math.max(6, width),
    height: Math.max(fontSize, lines.length * Math.round(fontSize * 1.35))
  }
}

function annotationBounds(annotation) {
  if (!annotation || !state.rect) return null
  let left = 0
  let top = 0
  let right = 0
  let bottom = 0
  if (annotation.points?.length) {
    const half = Math.max(2, (annotation.width || 4) / 2)
    const xs = annotation.points.map((point) => point.x)
    const ys = annotation.points.map((point) => point.y)
    left = Math.min(...xs) - half
    top = Math.min(...ys) - half
    right = Math.max(...xs) + half
    bottom = Math.max(...ys) + half
  } else if (annotation.tool === 'text') {
    const bounds = textBounds(annotation)
    left = bounds.x - 3
    top = bounds.y - 3
    right = bounds.x + bounds.width + 3
    bottom = bounds.y + bounds.height + 3
  } else if (annotation.tool === 'rect' || annotation.tool === 'ellipse') {
    left = Math.min(annotation.x1, annotation.x2)
    top = Math.min(annotation.y1, annotation.y2)
    right = Math.max(annotation.x1, annotation.x2)
    bottom = Math.max(annotation.y1, annotation.y2)
  } else {
    const pad = 16
    left = Math.min(annotation.x1, annotation.x2) - pad
    top = Math.min(annotation.y1, annotation.y2) - pad
    right = Math.max(annotation.x1, annotation.x2) + pad
    bottom = Math.max(annotation.y1, annotation.y2) + pad
  }
  const x = clamp(left, 0, state.rect.width)
  const y = clamp(top, 0, state.rect.height)
  const maxRight = clamp(right, 0, state.rect.width)
  const maxBottom = clamp(bottom, 0, state.rect.height)
  return {
    x,
    y,
    width: Math.max(1, maxRight - x),
    height: Math.max(1, maxBottom - y)
  }
}

function annotationHit(annotation, p) {
  if (!annotation) return false
  if (annotation.tool === 'text') {
    const bounds = textBounds(annotation)
    return p.x >= bounds.x - 3 && p.x <= bounds.x + bounds.width + 3 &&
      p.y >= bounds.y - 3 && p.y <= bounds.y + bounds.height + 3
  }
  if (annotation.tool === 'rect') {
    const left = Math.min(annotation.x1, annotation.x2)
    const right = Math.max(annotation.x1, annotation.x2)
    const top = Math.min(annotation.y1, annotation.y2)
    const bottom = Math.max(annotation.y1, annotation.y2)
    return p.x >= left - 4 && p.x <= right + 4 && p.y >= top - 4 && p.y <= bottom + 4
  }
  if (annotation.tool === 'ellipse') {
    const left = Math.min(annotation.x1, annotation.x2)
    const right = Math.max(annotation.x1, annotation.x2)
    const top = Math.min(annotation.y1, annotation.y2)
    const bottom = Math.max(annotation.y1, annotation.y2)
    const rx = Math.max(1, (right - left) / 2)
    const ry = Math.max(1, (bottom - top) / 2)
    const nx = (p.x - (left + rx)) / rx
    const ny = (p.y - (top + ry)) / ry
    return nx * nx + ny * ny <= 1.15
  }
  if (annotation.tool === 'arrow') {
    return segmentDistance(p, { x: annotation.x1, y: annotation.y1 }, { x: annotation.x2, y: annotation.y2 }) <= 11 ||
      Math.hypot(p.x - annotation.x1, p.y - annotation.y1) <= 12 ||
      Math.hypot(p.x - annotation.x2, p.y - annotation.y2) <= 28
  }
  if (annotation.points?.length) {
    const tolerance = Math.max(6, (annotation.width || 4) / 2 + 4)
    if (annotation.points.length === 1) {
      return Math.hypot(p.x - annotation.points[0].x, p.y - annotation.points[0].y) <= tolerance
    }
    for (let index = 1; index < annotation.points.length; index += 1) {
      if (segmentDistance(p, annotation.points[index - 1], annotation.points[index]) <= tolerance) return true
    }
  }
  return false
}

function hitTestAnnotation(p) {
  for (let index = state.annotations.length - 1; index >= 0; index -= 1) {
    if (annotationHit(state.annotations[index], p)) return state.annotations[index]
  }
  return null
}

function makeAnnotationHandle(kind, value, x, y) {
  const handle = document.createElement('span')
  handle.className = 'annotation-handle'
  handle.dataset[kind] = value
  if (Number.isFinite(x) && Number.isFinite(y)) {
    handle.style.left = `${x}px`
    handle.style.top = `${y}px`
  }
  return handle
}

function updateAnnotationSelection() {
  const annotation = state.selected
  if (!annotation || !state.rect) {
    annotationSelection.hidden = true
    annotationSelection.replaceChildren()
    return
  }
  const bounds = annotationBounds(annotation)
  if (!bounds) {
    annotationSelection.hidden = true
    return
  }
  annotationSelection.hidden = false
  annotationSelection.style.left = `${bounds.x}px`
  annotationSelection.style.top = `${bounds.y}px`
  annotationSelection.style.width = `${bounds.width}px`
  annotationSelection.style.height = `${bounds.height}px`
  annotationSelection.replaceChildren()
  if (annotation.tool === 'arrow') {
    annotationSelection.append(
      makeAnnotationHandle('editPoint', 'start', annotation.x1 - bounds.x, annotation.y1 - bounds.y),
      makeAnnotationHandle('editPoint', 'end', annotation.x2 - bounds.x, annotation.y2 - bounds.y)
    )
  } else if (annotation.tool === 'rect' || annotation.tool === 'ellipse') {
    for (const corner of ['nw', 'ne', 'se', 'sw']) {
      annotationSelection.append(makeAnnotationHandle('editCorner', corner))
    }
  }
}

function syncStateFromAnnotation(annotation) {
  state.color = annotation.color || COLORS[0]
  if (annotation.tool === 'pen' || annotation.tool === 'marker' || annotation.tool === 'mosaic') {
    if (Number.isFinite(annotation.width)) state.sizes[annotation.tool] = annotation.width
  }
  if (annotation.tool === 'arrow') {
    state.arrowStyle = annotation.arrowStyle || 'tapered'
    state.arrowAngle = Number.isFinite(annotation.arrowAngle) ? annotation.arrowAngle : defaultArrowAngle(state.arrowStyle)
  }
  if (annotation.tool === 'text') {
    state.textFont = annotation.fontFamily || TEXT_FONTS[0][0]
    state.textSize = annotation.fontSize || 18
  }
  if (annotation.tool === 'mosaic') state.mosaicTint = annotation.tint ?? null
}

function openSelectionMenu() {
  const annotation = state.selected
  if (!annotation) return
  state.menuTool = annotation.tool
  state.menuTarget = 'selected'
  renderToolMenu()
  toolMenu.hidden = false
  positionToolMenu()
}

function selectAnnotation(annotation) {
  if (!annotation) return
  state.selected = annotation
  syncStateFromAnnotation(annotation)
  openSelectionMenu()
  redraw()
}

function clearAnnotationSelection(options = {}) {
  state.selected = null
  state.editOrigin = null
  state.handle = null
  annotationSelection.hidden = true
  annotationSelection.replaceChildren()
  if (state.menuTarget === 'selected') closeToolMenu()
  if (!options.redraw) return
  redraw()
}

function applyAnnotationTranslation(annotation, origin, dx, dy) {
  if (origin.points) {
    annotation.points = origin.points.map((point) => ({ x: point.x + dx, y: point.y + dy }))
  } else if (origin.tool === 'text') {
    annotation.x = origin.x + dx
    annotation.y = origin.y + dy
  } else {
    annotation.x1 = origin.x1 + dx
    annotation.y1 = origin.y1 + dy
    annotation.x2 = origin.x2 + dx
    annotation.y2 = origin.y2 + dy
  }
}

function beginAnnotationMove(p, event) {
  if (!state.selected) return
  state.mode = 'annotation-move'
  state.start = p
  state.editOrigin = cloneAnnotation(state.selected)
  capture(event)
}

function beginAnnotationHandle(p, handle, event) {
  if (!state.selected) return
  state.editOrigin = cloneAnnotation(state.selected)
  state.start = p
  if (handle.editPoint) {
    state.mode = 'annotation-point'
    state.handle = handle.editPoint
  } else if (handle.editCorner) {
    state.mode = 'annotation-corner'
    state.handle = handle.editCorner
  }
  capture(event)
}

function updateAnnotationMove(p) {
  const annotation = state.selected
  const origin = state.editOrigin
  if (!annotation || !origin) return
  const bounds = annotationBounds(origin)
  if (!bounds) return
  const dx = clamp(p.x - state.start.x, -bounds.x, state.rect.width - bounds.x - bounds.width)
  const dy = clamp(p.y - state.start.y, -bounds.y, state.rect.height - bounds.y - bounds.height)
  applyAnnotationTranslation(annotation, origin, dx, dy)
  redraw()
}

function updateAnnotationPoint(p) {
  if (!state.selected || !state.editOrigin) return
  const local = {
    x: clamp(p.x - state.rect.x, 0, state.rect.width),
    y: clamp(p.y - state.rect.y, 0, state.rect.height)
  }
  if (state.handle === 'start') {
    state.selected.x1 = local.x
    state.selected.y1 = local.y
  } else {
    state.selected.x2 = local.x
    state.selected.y2 = local.y
  }
  redraw()
}

function updateAnnotationCorner(p) {
  if (!state.selected || !state.editOrigin) return
  const local = {
    x: clamp(p.x - state.rect.x, 0, state.rect.width),
    y: clamp(p.y - state.rect.y, 0, state.rect.height)
  }
  const origin = state.editOrigin
  let left = Math.min(origin.x1, origin.x2)
  let top = Math.min(origin.y1, origin.y2)
  let right = Math.max(origin.x1, origin.x2)
  let bottom = Math.max(origin.y1, origin.y2)
  if (state.handle.includes('w')) left = Math.min(local.x, right - 4)
  if (state.handle.includes('e')) right = Math.max(local.x, left + 4)
  if (state.handle.includes('n')) top = Math.min(local.y, bottom - 4)
  if (state.handle.includes('s')) bottom = Math.max(local.y, top + 4)
  state.selected.x1 = left
  state.selected.y1 = top
  state.selected.x2 = right
  state.selected.y2 = bottom
  redraw()
}

function buildToolbar() {
  const toolsGroup = document.createElement('div')
  toolsGroup.className = 'toolbar-group'
  for (const [id, title, path] of TOOLS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tool-button'
    button.title = title
    button.innerHTML = svg(path)
    button.addEventListener('click', () => {
      setTool(id)
      if (TOOL_MENU_TOOLS.has(id)) toggleToolMenu(id)
      else closeToolMenu()
    })
    toolButtons.set(id, button)
    toolsGroup.append(button)
  }

  const historyGroup = document.createElement('div')
  historyGroup.className = 'toolbar-group'
  undoButton = toolButton('撤销 (Ctrl+Z)', ICONS.undo, () => undo())
  redoButton = toolButton('重做 (Ctrl+Y)', ICONS.redo, () => redo())
  historyGroup.append(undoButton, redoButton)

  const actionGroup = document.createElement('div')
  actionGroup.className = 'toolbar-group'
  pinButton = toolButton('贴到屏幕', ICONS.pin, () => finish('pin'))
  copyButton = toolButton('复制到剪贴板 (Enter)', ICONS.copy, () => finish('copy'))
  saveButton = toolButton('保存为 PNG (Ctrl+S)', ICONS.save, () => finish('save'))
  copyButton.classList.add('primary')
  const closeButton = toolButton('取消 (Esc)', ICONS.close, () => cancel())
  actionGroup.append(pinButton, copyButton, saveButton, closeButton)

  toolbar.append(
    toolsGroup,
    separator(),
    historyGroup,
    separator(),
    actionGroup
  )
  setTool('select')
  updateHistory()
  updateActions()
}

function toggleToolMenu(tool) {
  if (toolMenu.hidden || state.menuTool !== tool) {
    state.menuTool = tool
    state.menuTarget = 'tool'
    renderToolMenu()
    toolMenu.hidden = false
    positionToolMenu()
  } else {
    closeToolMenu()
  }
}

function closeToolMenu() {
  toolMenu.hidden = true
  state.menuTool = null
  state.menuTarget = null
}

function renderToolMenu() {
  toolMenu.replaceChildren()
  arrowStyleSelect = null
  menuColorButtons = []
  mosaicNoneButton = null
  const tool = state.menuTool
  if (!tool) return

  if (tool === 'arrow') appendArrowStyles()
  if (tool === 'pen' || tool === 'marker' || tool === 'mosaic') {
    appendSizeSection(
      tool === 'mosaic' ? '马赛克大小' : '线条粗细',
      TOOL_SIZES[tool],
      state.sizes[tool],
      (value) => {
        state.sizes[tool] = value
        if (state.menuTarget === 'selected' && state.selected?.tool === tool) {
          state.selected.width = value
          redraw()
        }
      }
    )
  }
  if (tool === 'text') {
    appendFontSection()
    appendSizeSection('字号', TOOL_SIZES.text, state.textSize, (value) => {
      state.textSize = value
      if (state.menuTarget === 'selected' && state.selected?.tool === 'text') {
        state.selected.fontSize = value
        redraw()
      }
    })
  }
  appendColorSection(tool === 'mosaic')
  updateMenuColorSelection()
}

function appendArrowStyles() {
  const title = document.createElement('div')
  title.className = 'tool-menu-title'
  title.textContent = '箭头样式'
  const select = document.createElement('select')
  select.className = 'arrow-style-select'
  for (const [style, label] of ARROW_STYLES) {
    const option = document.createElement('option')
    option.value = style
    option.textContent = label
    select.append(option)
  }
  select.value = state.arrowStyle

  const angleTitle = document.createElement('div')
  angleTitle.className = 'tool-menu-title tool-angle-head'
  const angleLabel = document.createElement('span')
  angleLabel.textContent = '箭头角度'
  const angleValue = document.createElement('span')
  angleValue.className = 'tool-angle-value'
  const angleNumber = document.createElement('input')
  angleNumber.type = 'number'
  angleNumber.className = 'tool-angle-number'
  angleNumber.min = '20'
  angleNumber.max = '75'
  angleNumber.step = '1'
  angleNumber.value = String(state.arrowAngle)
  angleNumber.setAttribute('aria-label', '箭头角度')
  const angleDegree = document.createElement('span')
  angleDegree.textContent = '°'
  angleValue.append(angleNumber, angleDegree)
  angleTitle.append(angleLabel, angleValue)
  const angleRange = document.createElement('input')
  angleRange.type = 'range'
  angleRange.className = 'tool-angle-range'
  angleRange.min = '20'
  angleRange.max = '75'
  angleRange.step = '1'
  angleRange.value = String(state.arrowAngle)
  angleRange.addEventListener('input', () => {
    state.arrowAngle = Number(angleRange.value)
    angleNumber.value = String(state.arrowAngle)
    syncSelectedArrow()
  })
  angleNumber.addEventListener('input', () => {
    if (!angleNumber.value.trim()) return
    const value = Number(angleNumber.value)
    if (!Number.isFinite(value)) return
    state.arrowAngle = clamp(Math.round(value), 20, 75)
    angleRange.value = String(state.arrowAngle)
    syncSelectedArrow()
  })
  angleNumber.addEventListener('change', () => {
    const next = clamp(Math.round(Number(angleNumber.value) || state.arrowAngle), 20, 75)
    state.arrowAngle = next
    angleNumber.value = String(next)
    angleRange.value = String(next)
    syncSelectedArrow()
  })
  const angleWrap = document.createElement('div')
  angleWrap.className = 'tool-angle-wrap'
  angleWrap.append(angleTitle, angleRange)

  select.addEventListener('change', () => {
    state.arrowStyle = select.value
    state.arrowAngle = defaultArrowAngle(state.arrowStyle)
    angleNumber.value = String(state.arrowAngle)
    angleRange.value = String(state.arrowAngle)
    syncSelectedArrow()
    positionToolMenu()
  })
  arrowStyleSelect = select
  toolMenu.append(title, select, angleWrap)
}

function appendSizeSection(titleText, options, current, onPick) {
  const title = document.createElement('div')
  title.className = 'tool-menu-title'
  title.textContent = titleText
  const row = document.createElement('div')
  row.className = 'tool-size-row'
  const buttons = []
  for (const [label, value] of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tool-size'
    button.textContent = label
    button.classList.toggle('active', value === current)
    button.addEventListener('click', () => {
      onPick(value)
      for (const item of buttons) item.classList.toggle('active', item === button)
    })
    buttons.push(button)
    row.append(button)
  }
  toolMenu.append(title, row)
}

function appendFontSection() {
  const title = document.createElement('div')
  title.className = 'tool-menu-title'
  title.textContent = '字体'
  const select = document.createElement('select')
  select.className = 'text-font-select'
  for (const [value, label] of TEXT_FONTS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.append(option)
  }
  select.value = state.textFont
  select.addEventListener('change', () => {
    state.textFont = select.value
    if (state.menuTarget === 'selected' && state.selected?.tool === 'text') {
      state.selected.fontFamily = state.textFont
      redraw()
    }
  })
  toolMenu.append(title, select)
}

function appendColorSection(allowNone) {
  const head = document.createElement('div')
  head.className = 'tool-menu-color-head'
  const title = document.createElement('div')
  title.className = 'tool-menu-title'
  title.textContent = '颜色'
  head.append(title)
  if (allowNone) {
    mosaicNoneButton = document.createElement('button')
    mosaicNoneButton.type = 'button'
    mosaicNoneButton.className = 'tool-menu-link'
    mosaicNoneButton.textContent = '无着色'
    mosaicNoneButton.title = '不做颜色叠加'
    mosaicNoneButton.addEventListener('click', () => {
      state.mosaicTint = null
      if (state.menuTarget === 'selected' && state.selected?.tool === 'mosaic') {
        state.selected.tint = null
        redraw()
      }
      updateMenuColorSelection()
    })
    head.append(mosaicNoneButton)
  }
  const grid = document.createElement('div')
  grid.className = 'arrow-color-grid'
  for (const color of ARROW_PALETTE) {
    const swatch = document.createElement('button')
    swatch.type = 'button'
    swatch.className = 'arrow-color'
    swatch.title = color
    swatch.dataset.color = color
    swatch.style.background = color
    swatch.addEventListener('click', () => {
      if (state.menuTool === 'mosaic') state.mosaicTint = color
      setColor(color)
    })
    menuColorButtons.push(swatch)
    grid.append(swatch)
  }
  toolMenu.append(head, grid)
}

function updateMenuColorSelection() {
  const selected = state.menuTool === 'mosaic' ? state.mosaicTint : state.color
  for (const swatch of menuColorButtons) {
    swatch.classList.toggle('active', swatch.dataset.color === selected)
  }
  if (mosaicNoneButton) {
    mosaicNoneButton.classList.toggle('active', state.mosaicTint === null)
  }
}

function setColor(color) {
  if (state.tool === 'mosaic' || state.menuTool === 'mosaic') {
    state.mosaicTint = color
  }
  state.color = color
  if (state.menuTarget === 'selected' && state.selected) {
    state.selected.color = color
    if (state.selected.tool === 'mosaic') state.selected.tint = color
    redraw()
  }
  updateMenuColorSelection()
}

function positionToolMenu() {
  if (toolMenu.hidden) return
  const button = toolButtons.get(state.menuTool || state.tool)
  if (!button) return
  const rect = button.getBoundingClientRect()
  const width = toolMenu.offsetWidth
  const height = toolMenu.offsetHeight
  let left = rect.left
  let top = rect.bottom + 8
  if (top + height > window.innerHeight - 8) {
    const above = rect.top - 8 - height
    top = above >= 8 ? above : window.innerHeight - height - 8
  }
  left = clamp(left, 8, window.innerWidth - width - 8)
  top = clamp(top, 8, window.innerHeight - height - 8)
  toolMenu.style.left = `${Math.round(left)}px`
  toolMenu.style.top = `${Math.round(top)}px`
}

function toolButton(title, path, handler) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tool-button'
  button.title = title
  button.innerHTML = svg(path)
  button.addEventListener('click', handler)
  return button
}

function separator() {
  const line = document.createElement('span')
  line.className = 'toolbar-separator'
  return line
}

function setTool(id) {
  state.tool = id
  if (id !== 'select') clearAnnotationSelection()
  for (const [toolId, button] of toolButtons) {
    button.classList.toggle('active', toolId === id)
  }
  updateCursorStyle()
}

function updateCursorStyle() {
  document.body.style.cursor = state.tool === 'select' && state.rect ? 'default' : 'crosshair'
}

function updateHistory() {
  if (undoButton) undoButton.disabled = state.annotations.length === 0
  if (redoButton) redoButton.disabled = state.redo.length === 0
}

function updateActions() {
  const disabled = !state.rect || state.sent
  for (const button of [pinButton, copyButton, saveButton]) {
    if (button) button.disabled = disabled
  }
}

function resizeCanvas() {
  if (!state.rect) return
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(state.rect.width * dpr))
  const height = Math.max(1, Math.round(state.rect.height * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  redraw()
}

function applyRect(rect) {
  state.pixelCache.clear()
  state.rect = rect
  selectionEl.hidden = false
  selectionEl.style.left = `${rect.x}px`
  selectionEl.style.top = `${rect.y}px`
  selectionEl.style.width = `${rect.width}px`
  selectionEl.style.height = `${rect.height}px`
  selectionEl.classList.toggle('locked', state.annotations.length > 0)
  badge.hidden = false
  badge.textContent = `${Math.round(rect.width * state.ratio)} × ${Math.round(
    rect.height * state.ratio
  )} px`
  const badgeTop = rect.y > 28 ? rect.y - 26 : rect.y + 6
  badge.style.left = `${Math.max(4, rect.x)}px`
  badge.style.top = `${badgeTop}px`
  resizeCanvas()
  positionToolbar()
  updateActions()
}

function positionToolbar() {
  if (toolbar.hidden || !state.rect) return
  const width = toolbar.offsetWidth
  const height = toolbar.offsetHeight
  let left = state.rect.x + state.rect.width - width
  let top = state.rect.y + state.rect.height + 8
  if (top + height > window.innerHeight - 8) {
    const above = state.rect.y - 8 - height
    top = above >= 8 ? above : window.innerHeight - height - 8
  }
  left = clamp(left, 8, window.innerWidth - width - 8)
  top = clamp(top, 8, window.innerHeight - height - 8)
  toolbar.style.left = `${Math.round(left)}px`
  toolbar.style.top = `${Math.round(top)}px`
  positionToolMenu()
}

function commitSelection(rect) {
  applyRect(rect)
  dim.hidden = true
  hint.hidden = true
  toolbar.hidden = false
  positionToolbar()
  updateActions()
  setTool(state.tool)
}

function reset() {
  closeToolMenu()
  clearAnnotationSelection()
  state.rect = null
  state.annotations = []
  state.redo = []
  state.draft = null
  state.mode = null
  state.textPoint = null
  state.editingText = null
  state.sent = false
  selectionEl.hidden = true
  badge.hidden = true
  toolbar.hidden = true
  hint.hidden = false
  dim.hidden = !snapshot.classList.contains('ready')
  textEditor.hidden = true
  document.body.classList.remove('is-busy')
  document.body.style.cursor = 'crosshair'
  selectionEl.classList.remove('locked')
  if (snapshot.classList.contains('ready')) dim.hidden = false
  updateHistory()
  updateActions()
}

function resetForCapture() {
  state.color = COLORS[0]
  state.arrowStyle = 'tapered'
  state.arrowAngle = 65
  state.sizes = { pen: 4, marker: 16, mosaic: 10 }
  state.textFont = TEXT_FONTS[0][0]
  state.textSize = 18
  state.mosaicTint = null
  state.pixelCache.clear()
  textInput.value = ''
  textCommitted = true
  setTool('select')
  reset()
}

function beginSelection(p, event) {
  closeToolMenu()
  clearAnnotationSelection()
  state.mode = 'new'
  state.start = p
  state.rect = null
  state.annotations = []
  state.redo = []
  state.draft = null
  state.textPoint = null
  selectionEl.hidden = true
  badge.hidden = true
  toolbar.hidden = true
  hint.hidden = true
  dim.hidden = false
  selectionEl.classList.remove('locked')
  updateHistory()
  capture(event)
}

function beginMove(p, event) {
  state.mode = 'move'
  state.start = p
  state.origin = { ...state.rect }
  capture(event)
}

function beginResize(p, handle, event) {
  state.mode = 'resize'
  state.start = p
  state.origin = { ...state.rect }
  state.handle = handle
  capture(event)
}

function beginDraw(p, event) {
  state.mode = 'draw'
  const local = {
    x: clamp(p.x - state.rect.x, 0, state.rect.width),
    y: clamp(p.y - state.rect.y, 0, state.rect.height)
  }
  if (state.tool === 'pen' || state.tool === 'marker' || state.tool === 'mosaic') {
    state.draft = {
      tool: state.tool,
      points: [local],
      color: state.color,
      width: state.sizes[state.tool],
      tint: state.tool === 'mosaic' ? state.mosaicTint : null
    }
  } else {
    state.draft = {
      tool: state.tool,
      x1: local.x,
      y1: local.y,
      x2: local.x,
      y2: local.y,
      color: state.color,
      arrowStyle: state.arrowStyle,
      arrowAngle: state.arrowAngle
    }
  }
  capture(event)
}

function capture(event) {
  try {
    document.body.setPointerCapture(event.pointerId)
  } catch {}
}

function release(event) {
  try {
    document.body.releasePointerCapture(event.pointerId)
  } catch {}
}

function resizeRect(origin, handle, p) {
  let left = origin.x
  let top = origin.y
  let right = origin.x + origin.width
  let bottom = origin.y + origin.height
  if (handle.includes('w')) left = clamp(p.x, 0, right - MIN_SIZE)
  if (handle.includes('e')) right = clamp(p.x, left + MIN_SIZE, window.innerWidth)
  if (handle.includes('n')) top = clamp(p.y, 0, bottom - MIN_SIZE)
  if (handle.includes('s')) bottom = clamp(p.y, top + MIN_SIZE, window.innerHeight)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

document.addEventListener('contextmenu', (event) => event.preventDefault())

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (event.target.closest?.('#toolbar, #toolMenu, #textEditor')) return
  if (state.sent) return
  if (!snapshot.classList.contains('ready')) return
  closeToolMenu()
  event.preventDefault()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  if (!textEditor.hidden) commitText()
  const p = point(event)

  if (!state.rect) {
    beginSelection(p, event)
    return
  }

  if (state.tool === 'select') {
    if (state.annotations.length > 0) {
      if (!contains(state.rect, p)) {
        beginSelection(p, event)
        return
      }
      const editHandle = event.target.closest('.annotation-handle')
      if (editHandle && state.selected) {
        beginAnnotationHandle(p, editHandle.dataset, event)
        return
      }
      const hit = hitTestAnnotation(localPoint(event))
      if (hit) {
        selectAnnotation(hit)
        beginAnnotationMove(p, event)
        return
      }
      if (state.selected) {
        const bounds = annotationBounds(state.selected)
        const local = localPoint(event)
        if (
          bounds &&
          local.x >= bounds.x &&
          local.x <= bounds.x + bounds.width &&
          local.y >= bounds.y &&
          local.y <= bounds.y + bounds.height
        ) {
          beginAnnotationMove(p, event)
          return
        }
      }
      clearAnnotationSelection()
      return
    }
    const handle = event.target.closest('.handle')
    if (handle) {
      beginResize(p, handle.dataset.handle, event)
      return
    }
    if (contains(state.rect, p)) {
      beginMove(p, event)
    } else {
      beginSelection(p, event)
    }
    return
  }

  if (!contains(state.rect, p)) {
    beginSelection(p, event)
    return
  }
  if (state.tool === 'text') {
    beginText(p)
    return
  }
  beginDraw(p, event)
})

document.addEventListener('pointermove', (event) => {
  if (!state.mode) {
    updateCursor(event)
    return
  }
  const p = point(event)
  if (state.mode === 'new') {
    const rect = normalize(state.start, p)
    if (rect.width >= 1 && rect.height >= 1) {
      applyRect(rect)
      dim.hidden = true
    }
    return
  }
  if (state.mode === 'move') {
    const dx = p.x - state.start.x
    const dy = p.y - state.start.y
    const rect = {
      x: clamp(state.origin.x + dx, 0, window.innerWidth - state.origin.width),
      y: clamp(state.origin.y + dy, 0, window.innerHeight - state.origin.height),
      width: state.origin.width,
      height: state.origin.height
    }
    state.rect = rect
    applyRect(rect)
    return
  }
  if (state.mode === 'resize') {
    const rect = resizeRect(state.origin, state.handle, p)
    state.rect = rect
    applyRect(rect)
    return
  }
  if (state.mode === 'annotation-move') {
    updateAnnotationMove(p)
    return
  }
  if (state.mode === 'annotation-point') {
    updateAnnotationPoint(p)
    return
  }
  if (state.mode === 'annotation-corner') {
    updateAnnotationCorner(p)
    return
  }
  if (state.mode === 'draw' && state.draft) {
    const local = {
      x: clamp(p.x - state.rect.x, 0, state.rect.width),
      y: clamp(p.y - state.rect.y, 0, state.rect.height)
    }
    if (state.draft.points) {
      state.draft.points.push(local)
    } else {
      state.draft.x2 = local.x
      state.draft.y2 = local.y
    }
    redraw()
  }
})

document.addEventListener('pointerup', (event) => {
  if (!state.mode) return
  const mode = state.mode
  state.mode = null
  release(event)

  if (mode === 'new') {
    const rect = state.rect
    if (rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
      state.annotations = []
      state.redo = []
      commitSelection(rect)
    } else {
      reset()
    }
    return
  }

  if (mode === 'move' || mode === 'resize') {
    if (state.rect) {
      applyRect(state.rect)
      positionToolbar()
    }
    return
  }

  if (mode === 'annotation-move' || mode === 'annotation-point' || mode === 'annotation-corner') {
    state.editOrigin = null
    state.handle = null
    redraw()
    if (state.selected) openSelectionMenu()
    return
  }

  if (mode === 'draw' && state.draft) {
    const draft = state.draft
    state.draft = null
    if (draft.points) {
      const minimum = draft.tool === 'mosaic' ? 1 : 2
      if (draft.points.length >= minimum) {
        state.annotations.push(draft)
        state.redo = []
      }
    } else {
      const width = Math.abs(draft.x2 - draft.x1)
      const height = Math.abs(draft.y2 - draft.y1)
      if (width >= 3 || height >= 3) {
        state.annotations.push(draft)
        state.redo = []
      }
    }
    selectionEl.classList.toggle('locked', state.annotations.length > 0)
    redraw()
    updateHistory()
  }
})

document.addEventListener('pointercancel', (event) => {
  if (!state.mode) return
  state.mode = null
  state.draft = null
  state.editOrigin = null
  state.handle = null
  release(event)
  if (state.rect) {
    applyRect(state.rect)
    positionToolbar()
  }
})

function updateCursor(event) {
  if (!state.rect || state.tool !== 'select') {
    document.body.style.cursor = 'crosshair'
    return
  }
  const inRect = contains(state.rect, point(event))
  if (!inRect) {
    document.body.style.cursor = 'crosshair'
    return
  }
  if (state.annotations.length > 0) {
    const hit = hitTestAnnotation({
      x: point(event).x - state.rect.x,
      y: point(event).y - state.rect.y
    })
    document.body.style.cursor = hit ? 'move' : 'default'
    return
  }
  document.body.style.cursor = 'move'
}

function redraw() {
  if (!state.rect) return
  const dpr = window.devicePixelRatio || 1
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, state.rect.width, state.rect.height)
  const options = {
    image: snapshot,
    offsetX: state.rect.x,
    offsetY: state.rect.y,
    scale: state.ratio
  }
  for (const annotation of state.annotations) drawAnnotation(context, annotation, options)
  if (state.draft) drawAnnotation(context, state.draft, options)
  updateAnnotationSelection()
}

function strokeStyle(context, color, width) {
  context.strokeStyle = color
  context.lineWidth = width
  context.lineCap = 'round'
  context.lineJoin = 'round'
}

function arrowHeadGeometry(annotation, shaftHalf) {
  const { x1, y1, x2, y2 } = annotation
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (length < 1) return null
  const ux = dx / length
  const uy = dy / length
  const nx = -uy
  const ny = ux
  const headLength = Math.max(8, Math.min(18, length * 0.45))
  const headHalf = Math.max(7, Math.min(13, length * 0.35))
  const neckX = x2 - ux * headLength
  const neckY = y2 - uy * headLength
  const angle = (Math.max(20, Math.min(75, Number(annotation.arrowAngle) || 65)) * Math.PI) / 180
  const barbBack = Math.min(
    length * 0.35,
    Math.max(0, headHalf - shaftHalf) / Math.tan(angle)
  )
  const barbTopX = neckX + nx * headHalf - ux * barbBack
  const barbTopY = neckY + ny * headHalf - uy * barbBack
  const barbBottomX = neckX - nx * headHalf - ux * barbBack
  const barbBottomY = neckY - ny * headHalf - uy * barbBack
  return {
    x1,
    y1,
    x2,
    y2,
    ux,
    uy,
    nx,
    ny,
    headLength,
    headHalf,
    shaftHalf,
    neckX,
    neckY,
    barbTopX,
    barbTopY,
    barbBottomX,
    barbBottomY,
    midBarbX: (barbTopX + barbBottomX) / 2,
    midBarbY: (barbTopY + barbBottomY) / 2
  }
}

function solidArrowGeometry(annotation) {
  const { x1, y1, x2, y2 } = annotation
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (length < 1) return null
  const ux = dx / length
  const uy = dy / length
  const nx = -uy
  const ny = ux
  const headLength = Math.max(10, Math.min(22, length * 0.45))
  const baseHalf = Math.max(7, Math.min(13, length * 0.35))
  const angle = Math.max(20, Math.min(75, Number(annotation.arrowAngle) || 25))
  const factor = 0.55 + 0.55 * ((angle - 20) / 55)
  const headHalf = Math.max(6, Math.min(16, baseHalf * factor))
  return {
    x1,
    y1,
    x2,
    y2,
    nx,
    ny,
    headHalf,
    neckX: x2 - ux * headLength,
    neckY: y2 - uy * headLength
  }
}

function drawSolidArrow(context, annotation, color) {
  const geometry = solidArrowGeometry(annotation)
  if (!geometry) return
  strokeStyle(context, color, 2.5)
  context.beginPath()
  context.moveTo(geometry.x1, geometry.y1)
  context.lineTo(geometry.neckX, geometry.neckY)
  context.stroke()
  context.fillStyle = color
  context.beginPath()
  context.moveTo(geometry.neckX + geometry.nx * geometry.headHalf, geometry.neckY + geometry.ny * geometry.headHalf)
  context.lineTo(geometry.x2, geometry.y2)
  context.lineTo(geometry.neckX - geometry.nx * geometry.headHalf, geometry.neckY - geometry.ny * geometry.headHalf)
  context.closePath()
  context.fill()
}

function drawOpenArrow(context, annotation, color) {
  const geometry = arrowHeadGeometry(annotation, 2.2)
  if (!geometry) return
  strokeStyle(context, color, 2.5)
  context.beginPath()
  context.moveTo(geometry.x1, geometry.y1)
  context.lineTo(geometry.x2, geometry.y2)
  context.stroke()
  context.beginPath()
  context.moveTo(geometry.barbTopX, geometry.barbTopY)
  context.lineTo(geometry.x2, geometry.y2)
  context.lineTo(geometry.barbBottomX, geometry.barbBottomY)
  context.stroke()
}

function hollowArrowPoints(annotation) {
  const geometry = arrowHeadGeometry(
    annotation,
    Math.max(3, Math.min(5, Math.hypot(annotation.x2 - annotation.x1, annotation.y2 - annotation.y1) * 0.1))
  )
  if (!geometry) return null
  return [
    [geometry.x1, geometry.y1],
    [geometry.neckX + geometry.nx * geometry.shaftHalf, geometry.neckY + geometry.ny * geometry.shaftHalf],
    [geometry.barbTopX, geometry.barbTopY],
    [geometry.x2, geometry.y2],
    [geometry.barbBottomX, geometry.barbBottomY],
    [geometry.neckX - geometry.nx * geometry.shaftHalf, geometry.neckY - geometry.ny * geometry.shaftHalf]
  ]
}

function drawHollowArrow(context, annotation, color) {
  const points = hollowArrowPoints(annotation)
  if (!points) return
  strokeStyle(context, color, 2.2)
  context.beginPath()
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point[0], point[1])
    else context.lineTo(point[0], point[1])
  })
  context.closePath()
  context.stroke()
}

function drawTaperedArrow(context, annotation, color) {
  const points = hollowArrowPoints(annotation)
  if (!points) return
  context.fillStyle = color
  context.beginPath()
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point[0], point[1])
    else context.lineTo(point[0], point[1])
  })
  context.closePath()
  context.fill()
}

function drawAnnotation(context, annotation, options) {
  const color = annotation.color || COLORS[0]
  context.save()
  switch (annotation.tool) {
    case 'pen': {
      if (!annotation.points?.length) break
      strokeStyle(context, color, annotation.width || 3)
      context.beginPath()
      annotation.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      if (annotation.points.length === 1) {
        context.lineTo(annotation.points[0].x + 0.1, annotation.points[0].y + 0.1)
      }
      context.stroke()
      break
    }
    case 'marker': {
      if (!annotation.points?.length) break
      context.globalAlpha = 0.32
      strokeStyle(context, color, annotation.width || 15)
      context.beginPath()
      annotation.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      context.stroke()
      break
    }
    case 'rect': {
      strokeStyle(context, color, 2.5)
      const x = Math.min(annotation.x1, annotation.x2)
      const y = Math.min(annotation.y1, annotation.y2)
      const width = Math.abs(annotation.x2 - annotation.x1)
      const height = Math.abs(annotation.y2 - annotation.y1)
      context.strokeRect(x, y, width, height)
      break
    }
    case 'ellipse': {
      strokeStyle(context, color, 2.5)
      const x = Math.min(annotation.x1, annotation.x2)
      const y = Math.min(annotation.y1, annotation.y2)
      const width = Math.abs(annotation.x2 - annotation.x1)
      const height = Math.abs(annotation.y2 - annotation.y1)
      context.beginPath()
      context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
      context.stroke()
      break
    }
    case 'arrow': {
      const style = annotation.arrowStyle || 'tapered'
      if (style === 'open') drawOpenArrow(context, annotation, color)
      else if (style === 'hollow') drawHollowArrow(context, annotation, color)
      else if (style === 'tapered') drawTaperedArrow(context, annotation, color)
      else drawSolidArrow(context, annotation, color)
      break
    }
    case 'text': {
      context.fillStyle = color
      const fontSize = annotation.fontSize || 18
      const fontFamily = annotation.fontFamily || TEXT_FONTS[0][0]
      context.font = `600 ${fontSize}px ${fontFamily}`
      context.textBaseline = 'top'
      const lines = String(annotation.text || '').split('\n')
      lines.forEach((line, index) => {
        context.fillText(line, annotation.x, annotation.y + index * Math.round(fontSize * 1.35))
      })
      break
    }
    case 'mosaic': {
      drawMosaicStroke(context, annotation, options)
      break
    }
  }
  context.restore()
}

function getPixelCache() {
  if (!state.rect) return null
  const cached = state.pixelCache.get('mosaic')
  if (cached) return cached
  const ratio = state.ratio
  const width = Math.max(1, Math.round(state.rect.width * ratio))
  const height = Math.max(1, Math.round(state.rect.height * ratio))
  const block = 6
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.ceil(state.rect.width / block))
  small.height = Math.max(1, Math.ceil(state.rect.height / block))
  const smallContext = small.getContext('2d')
  if (!smallContext) return null
  smallContext.imageSmoothingEnabled = false
  smallContext.drawImage(
    snapshot,
    state.rect.x * ratio,
    state.rect.y * ratio,
    state.rect.width * ratio,
    state.rect.height * ratio,
    0,
    0,
    small.width,
    small.height
  )
  const cache = document.createElement('canvas')
  cache.width = width
  cache.height = height
  const context = cache.getContext('2d')
  if (!context) return null
  context.imageSmoothingEnabled = false
  context.drawImage(small, 0, 0, small.width, small.height, 0, 0, width, height)
  state.pixelCache.set('mosaic', cache)
  return cache
}

function drawMosaicStroke(context, annotation, options) {
  const points = annotation.points || []
  if (!points.length) return
  const size = Math.max(2, Number(annotation.width) || 8)
  const cache = getPixelCache()
  if (!cache) return
  const ratio = state.ratio
  const half = size / 2
  const step = Math.max(2, size * 0.35)
  const stamps = []
  if (points.length === 1) {
    stamps.push(points[0])
  } else {
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      const distance = Math.hypot(to.x - from.x, to.y - from.y)
      const count = Math.max(1, Math.ceil(distance / step))
      for (let stepIndex = 0; stepIndex <= count; stepIndex += 1) {
        const t = stepIndex / count
        stamps.push({
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t
        })
      }
    }
  }
  const tintPath = new Path2D()
  context.save()
  context.imageSmoothingEnabled = false
  for (const stamp of stamps) {
    const x = stamp.x - half
    const y = stamp.y - half
    const sx = Math.max(0, x * ratio)
    const sy = Math.max(0, y * ratio)
    const sw = Math.min(size * ratio, cache.width - sx)
    const sh = Math.min(size * ratio, cache.height - sy)
    if (sw <= 0 || sh <= 0) continue
    context.save()
    context.beginPath()
    context.arc(stamp.x, stamp.y, half, 0, Math.PI * 2)
    context.clip()
    context.drawImage(cache, sx, sy, sw, sh, sx / ratio, sy / ratio, sw / ratio, sh / ratio)
    context.restore()
    tintPath.moveTo(stamp.x + half, stamp.y)
    tintPath.arc(stamp.x, stamp.y, half, 0, Math.PI * 2)
  }
  if (annotation.tint) {
    context.globalAlpha = 0.2
    context.fillStyle = annotation.tint
    context.fill(tintPath)
  }
  context.restore()
}

function beginText(p, existing = null) {
  state.editingText = existing
  state.textPoint = existing
    ? { x: existing.x, y: existing.y }
    : {
        x: clamp(p.x - state.rect.x, 0, Math.max(0, state.rect.width - 40)),
        y: clamp(p.y - state.rect.y, 0, Math.max(0, state.rect.height - 24))
      }
  textCommitted = false
  textInput.value = existing?.text || ''
  textInput.style.fontFamily = existing?.fontFamily || state.textFont
  textInput.style.fontSize = `${existing?.fontSize || state.textSize}px`
  textEditor.hidden = false
  const left = clamp(state.rect.x + state.textPoint.x, 4, window.innerWidth - 228)
  const top = clamp(
    state.rect.y + state.textPoint.y,
    4,
    window.innerHeight - Math.max(42, (existing?.fontSize || state.textSize) + 18)
  )
  textEditor.style.left = `${left}px`
  textEditor.style.top = `${top}px`
  textInput.focus()
  textInput.select()
}

function commitText() {
  if (textCommitted || textEditor.hidden) return
  const text = textInput.value.trim()
  textCommitted = true
  textEditor.hidden = true
  const editing = state.editingText
  state.editingText = null
  if (!text) {
    if (editing) {
      const index = state.annotations.indexOf(editing)
      if (index >= 0) state.annotations.splice(index, 1)
      clearAnnotationSelection()
    }
    redraw()
    updateHistory()
    return
  }
  if (editing) {
    editing.text = text
    editing.color = state.color
    editing.fontFamily = state.textFont
    editing.fontSize = state.textSize
    state.redo = []
    redraw()
    updateHistory()
    return
  }
  if (!state.textPoint) return
  state.annotations.push({
    tool: 'text',
    x: state.textPoint.x,
    y: state.textPoint.y,
    text,
    color: state.color,
    fontFamily: state.textFont,
    fontSize: state.textSize
  })
  state.redo = []
  selectionEl.classList.toggle('locked', state.annotations.length > 0)
  redraw()
  updateHistory()
}

function cancelText() {
  textCommitted = true
  state.editingText = null
  textEditor.hidden = true
  textInput.blur()
}

textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    commitText()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancelText()
  }
})
textInput.addEventListener('blur', () => commitText())

document.addEventListener('dblclick', (event) => {
  if (event.target.closest?.('#toolbar, #toolMenu, #textEditor')) return
  if (state.tool !== 'select' || !state.rect || state.annotations.length === 0) return
  const hit = hitTestAnnotation(localPoint(event))
  if (!hit || hit.tool !== 'text') return
  event.preventDefault()
  selectAnnotation(hit)
  closeToolMenu()
  beginText(point(event), hit)
})

function undo() {
  if (!state.annotations.length) return
  const removed = state.annotations.pop()
  if (state.selected === removed) clearAnnotationSelection()
  state.redo.push(removed)
  selectionEl.classList.toggle('locked', state.annotations.length > 0)
  redraw()
  updateHistory()
}

function redo() {
  if (!state.redo.length) return
  state.annotations.push(state.redo.pop())
  selectionEl.classList.add('locked')
  redraw()
  updateHistory()
}

async function compose() {
  const rect = state.rect
  const ratio = state.ratio
  const output = document.createElement('canvas')
  output.width = Math.max(1, Math.round(rect.width * ratio))
  output.height = Math.max(1, Math.round(rect.height * ratio))
  const context = output.getContext('2d')
  if (!context) throw new Error('无法创建截图画布')
  context.drawImage(
    snapshot,
    rect.x * ratio,
    rect.y * ratio,
    rect.width * ratio,
    rect.height * ratio,
    0,
    0,
    output.width,
    output.height
  )
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  const options = { image: output, offsetX: 0, offsetY: 0, scale: ratio }
  for (const annotation of state.annotations) drawAnnotation(context, annotation, options)
  return await new Promise((resolve, reject) => {
    output.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('截图编码失败'))), 'image/png')
  })
}

async function finish(action) {
  if (state.sent || !state.rect) return
  state.sent = true
  document.body.classList.add('is-busy')
  updateActions()
  try {
    const blob = await compose()
    const png = await blob.arrayBuffer()
    api.finish({ action, png, rect: { ...state.rect } })
  } catch (error) {
    state.sent = false
    document.body.classList.remove('is-busy')
    updateActions()
    console.error(error)
  }
}

function cancel() {
  if (state.sent) return
  state.sent = true
  api.cancel()
}

window.addEventListener('resize', () => {
  if (state.rect) positionToolbar()
})

window.addEventListener('keydown', (event) => {
  if (!toolMenu.hidden && event.key === 'Escape') {
    event.preventDefault()
    closeToolMenu()
    return
  }
  if (event.target.closest?.('#toolMenu')) return
  if (event.target.closest?.('#toolbar') && (event.key === 'Enter' || event.key === ' ')) return
  if (!textEditor.hidden) return
  if (state.selected && event.key === 'Escape') {
    event.preventDefault()
    clearAnnotationSelection({ redraw: true })
    return
  }
  if (state.selected && (event.key === 'Delete' || event.key === 'Backspace')) {
    event.preventDefault()
    const index = state.annotations.indexOf(state.selected)
    if (index >= 0) state.annotations.splice(index, 1)
    state.redo = []
    clearAnnotationSelection()
    selectionEl.classList.toggle('locked', state.annotations.length > 0)
    redraw()
    updateHistory()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
    return
  }
  if (!state.rect) return
  if (event.key === 'Enter') {
    event.preventDefault()
    finish('copy')
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
    event.preventDefault()
    finish('copy')
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    finish('save')
  }
})

api.onInit((data) => {
  if (!data?.image) return
  snapshot.classList.remove('ready')
  snapshot.removeAttribute('src')
  resetForCapture()
  state.display = data.display
  let readySent = false
  const notifyReady = () => {
    if (readySent) return
    readySent = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => api.overlayReady?.())
    })
  }
  snapshot.onload = () => {
    state.ratio = snapshot.naturalWidth / Math.max(1, window.innerWidth)
    snapshot.classList.add('ready')
    dim.hidden = false
    if (typeof snapshot.decode === 'function') {
      snapshot.decode().then(notifyReady, notifyReady)
    } else {
      notifyReady()
    }
  }
  snapshot.onerror = () => {
    snapshot.classList.add('ready')
    notifyReady()
  }
  snapshot.src = `${data.image}#${Date.now()}`
})

api.onSaveCancelled(() => {
  state.sent = false
  document.body.classList.remove('is-busy')
  updateActions()
})

buildToolbar()
reset()
