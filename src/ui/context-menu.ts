import { el, on } from './dom'
import { icon } from './icons'

export interface MenuItem {
  label?: string
  icon?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  action?: () => void
}

let closeCurrent: (() => void) | null = null

export function showContextMenu(items: MenuItem[], x: number, y: number): void {
  closeCurrent?.()

  const menu = el('div', { class: 'context-menu', role: 'menu' })
  const buttons: HTMLButtonElement[] = []

  for (const item of items) {
    if (item.separator) {
      menu.appendChild(el('div', { class: 'context-menu-separator', role: 'separator' }))
      continue
    }
    const button = el(
      'button',
      {
        class: `context-menu-item${item.danger ? ' is-danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled === true
      },
      item.icon ? el('span', { class: 'context-menu-icon', html: icon(item.icon, 16) }) : el('span', { class: 'context-menu-icon' }),
      el('span', { class: 'context-menu-label', text: item.label ?? '' }),
      item.shortcut ? el('span', { class: 'context-menu-shortcut', text: item.shortcut }) : null
    )
    button.addEventListener('click', () => {
      close()
      item.action?.()
    })
    buttons.push(button)
    menu.appendChild(button)
  }

  menu.style.visibility = 'hidden'
  document.body.appendChild(menu)

  const padding = 8
  const rect = menu.getBoundingClientRect()
  const left = Math.min(Math.max(padding, x), window.innerWidth - rect.width - padding)
  const top = Math.min(Math.max(padding, y), window.innerHeight - rect.height - padding)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.visibility = ''

  const onPointerDown = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) close()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  const onScroll = () => close()
  const removeListeners = [
    on(document, 'pointerdown', onPointerDown, true),
    on(document, 'keydown', onKeyDown, true),
    on(window, 'resize', onScroll),
    on(window, 'blur', onScroll)
  ]

  function close() {
    removeListeners.forEach((off) => off())
    menu.remove()
    closeCurrent = null
  }

  closeCurrent = close
  requestAnimationFrame(() => buttons[0]?.focus())
}
