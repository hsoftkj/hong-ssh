import { clear, el } from './dom'
import { icon } from './icons'

export interface ModalOptions {
  title: string
  subtitle?: string
  body: Node | DocumentFragment
  footer?: Node | null
  width?: number
  icon?: string
  danger?: boolean
  closeOnBackdrop?: boolean
  onClose?: () => void
}

export interface ModalHandle {
  element: HTMLElement
  body: HTMLElement
  footer: HTMLElement
  close: () => void
}

export interface ConfirmOptions {
  title: string
  message: string
  detail?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export class ModalHost {
  private readonly root: HTMLElement
  private current: { element: HTMLElement; close: () => void } | null = null

  constructor(root: HTMLElement) {
    this.root = root
    this.root.className = 'modal-root'
  }

  open(options: ModalOptions): ModalHandle {
    this.current?.close()
    const previousFocus = document.activeElement as HTMLElement | null

    const body = el('div', { class: 'modal-body' })
    body.append(options.body)

    const footer = el('div', { class: 'modal-footer' })
    if (options.footer) footer.append(options.footer)

    const closeButton = el(
      'button',
      {
        class: 'modal-close',
        type: 'button',
        title: '关闭 (Esc)',
        'aria-label': '关闭',
        html: icon('close', 18)
      },
      null
    )

    const dialog = el(
      'div',
      {
        class: `modal${options.danger ? ' is-danger' : ''}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': options.title,
        style: { width: `${options.width ?? 560}px` }
      },
      el(
        'div',
        { class: 'modal-header' },
        options.icon
          ? el('div', { class: 'modal-header-icon', html: icon(options.icon, 20) })
          : null,
        el(
          'div',
          { class: 'modal-heading' },
          el('h2', { class: 'modal-title', text: options.title }),
          options.subtitle ? el('p', { class: 'modal-subtitle', text: options.subtitle }) : null
        ),
        closeButton
      ),
      body,
      footer.childElementCount > 0 ? footer : null
    )

    const backdrop = el('div', { class: 'modal-backdrop' }, dialog)
    this.root.appendChild(backdrop)
    document.body.classList.add('has-modal')
    const stopDrag = enableModalDrag(dialog, dialog.querySelector('.modal-header') as HTMLElement)

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      stopDrag()
      document.removeEventListener('keydown', onKeyDown, true)
      backdrop.classList.add('is-closing')
      setTimeout(() => {
        backdrop.remove()
        if (this.root.childElementCount === 0) document.body.classList.remove('has-modal')
      }, 160)
      previousFocus?.focus?.()
      this.current = null
      options.onClose?.()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ].filter((element) => element.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    closeButton.addEventListener('click', close)
    if (options.closeOnBackdrop !== false) {
      backdrop.addEventListener('pointerdown', (event) => {
        if (event.target === backdrop) close()
      })
    }
    document.addEventListener('keydown', onKeyDown, true)
    this.current = { element: backdrop, close }

    requestAnimationFrame(() => {
      const autoFocus = dialog.querySelector<HTMLElement>('[autofocus]')
      const firstInput = dialog.querySelector<HTMLElement>(
        'input:not([type="hidden"]), select, textarea'
      )
      ;(autoFocus || firstInput || closeButton).focus()
    })

    return { element: backdrop, body, footer, close }
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean, close: () => void) => {
        if (settled) return
        settled = true
        resolve(value)
        close()
      }
      const handle = this.open({
        title: options.title,
        icon: options.danger ? 'warning' : 'info',
        width: 460,
        danger: options.danger,
        closeOnBackdrop: false,
        body: el(
          'div',
          { class: 'confirm-content' },
          el('p', { class: 'confirm-message', text: options.message }),
          options.detail ? el('p', { class: 'confirm-detail', text: options.detail }) : null
        ),
        footer: el(
          'div',
          { class: 'modal-actions' },
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              text: options.cancelText ?? '取消',
              autofocus: true,
              onclick: () => finish(false, handle.close)
            },
            null
          ),
          el(
            'button',
            {
              class: `btn ${options.danger ? 'btn-danger' : 'btn-primary'}`,
              type: 'button',
              text: options.confirmText ?? '确定',
              onclick: () => finish(true, handle.close)
            },
            null
          )
        ),
        onClose: () => {
          if (!settled) {
            settled = true
            resolve(false)
          }
        }
      })
    })
  }

  alert(title: string, message: string, detail?: string): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.open({
        title,
        icon: 'info',
        width: 460,
        body: el(
          'div',
          { class: 'confirm-content' },
          el('p', { class: 'confirm-message', text: message }),
          detail ? el('p', { class: 'confirm-detail', text: detail }) : null
        ),
        footer: el(
          'div',
          { class: 'modal-actions' },
          el(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              text: '知道了',
              autofocus: true,
              onclick: () => handle.close()
            },
            null
          )
        ),
        onClose: () => resolve()
      })
    })
  }

  close(): void {
    this.current?.close()
  }

  get isOpen(): boolean {
    return this.current !== null
  }

  clear(): void {
    clear(this.root)
    this.current = null
    document.body.classList.remove('has-modal')
  }
}

function enableModalDrag(dialog: HTMLElement, handle: HTMLElement): () => void {
  let dragging = false
  let startX = 0
  let startY = 0
  let startLeft = 0
  let startTop = 0
  let width = 0
  let height = 0

  const clampLeft = (value: number) =>
    Math.min(Math.max(8, value), Math.max(8, window.innerWidth - width - 8))
  const clampTop = (value: number) =>
    Math.min(Math.max(8, value), Math.max(8, window.innerHeight - height - 8))

  const pinToViewport = () => {
    const rect = dialog.getBoundingClientRect()
    width = rect.width
    height = rect.height
    startLeft = clampLeft(rect.left)
    startTop = clampTop(rect.top)
    dialog.style.position = 'fixed'
    dialog.style.left = `${startLeft}px`
    dialog.style.top = `${startTop}px`
    dialog.style.margin = '0'
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return
    dialog.style.left = `${clampLeft(startLeft + event.clientX - startX)}px`
    dialog.style.top = `${clampTop(startTop + event.clientY - startY)}px`
  }

  const finishDrag = () => {
    if (!dragging) return
    dragging = false
    dialog.classList.remove('is-dragging')
    document.body.classList.remove('is-dragging-modal')
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', finishDrag)
    window.removeEventListener('pointercancel', finishDrag)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, [data-no-drag]')) return
    event.preventDefault()
    pinToViewport()
    startX = event.clientX
    startY = event.clientY
    dragging = true
    dialog.classList.add('is-dragging')
    document.body.classList.add('is-dragging-modal')
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
  }

  const onResize = () => {
    if (!dialog.style.position) return
    const rect = dialog.getBoundingClientRect()
    width = rect.width
    height = rect.height
    dialog.style.left = `${clampLeft(rect.left)}px`
    dialog.style.top = `${clampTop(rect.top)}px`
  }

  handle.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('resize', onResize)

  return () => {
    finishDrag()
    handle.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('resize', onResize)
  }
}

export function formRow(label: string, control: HTMLElement, hint?: string): HTMLElement {  return el(
    'label',
    { class: 'form-row' },
    el('span', { class: 'form-label', text: label }),
    el('span', { class: 'form-control' }, control, hint ? el('span', { class: 'form-hint', text: hint }) : null)
  )
}

export function formSection(title: string, ...children: (Node | null)[]): HTMLElement {
  return el(
    'section',
    { class: 'form-section' },
    el('h3', { class: 'form-section-title', text: title }),
    ...children
  )
}
