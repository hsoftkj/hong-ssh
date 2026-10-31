import { clear, el } from './dom'
import { icon } from './icons'

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

interface ToastOptions {
  title?: string
  duration?: number
}

export class ToastHost {
  private readonly root: HTMLElement
  private readonly container: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.root.className = 'toast-root'
    this.container = el('div', { class: 'toast-container', role: 'status', 'aria-live': 'polite' })
    this.root.appendChild(this.container)
  }

  success(message: string, options: ToastOptions = {}): void {
    this.show(message, 'success', options)
  }

  error(message: string, options: ToastOptions = {}): void {
    this.show(message, 'error', { duration: 6000, ...options })
  }

  info(message: string, options: ToastOptions = {}): void {
    this.show(message, 'info', options)
  }

  warning(message: string, options: ToastOptions = {}): void {
    this.show(message, 'warning', { duration: 5000, ...options })
  }

  show(message: string, kind: ToastKind, options: ToastOptions = {}): void {
    const duration = options.duration ?? (kind === 'error' ? 6000 : 3800)
    const item = el(
      'div',
      { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      el('div', { class: 'toast-icon', html: icon(toastIcon(kind), 18) }),
      el(
        'div',
        { class: 'toast-content' },
        options.title ? el('div', { class: 'toast-title', text: options.title }) : null,
        el('div', { class: 'toast-message', text: message })
      ),
      el(
        'button',
        {
          class: 'toast-close',
          type: 'button',
          title: '关闭',
          html: icon('close', 14),
          onclick: () => dismiss()
        }
      )
    )

    let timer: ReturnType<typeof setTimeout> | undefined
    const dismiss = () => {
      if (!item.isConnected) return
      clearTimeout(timer)
      item.classList.add('toast-leaving')
      setTimeout(() => item.remove(), 180)
    }
    this.container.appendChild(item)
    while (this.container.children.length > 5) this.container.firstElementChild?.remove()
    if (duration > 0) timer = setTimeout(dismiss, duration)
    item.addEventListener('mouseenter', () => clearTimeout(timer))
    item.addEventListener('mouseleave', () => {
      if (duration > 0) timer = setTimeout(dismiss, 1200)
    })
  }

  clear(): void {
    clear(this.container)
  }
}

function toastIcon(kind: ToastKind): string {
  if (kind === 'success') return 'check'
  if (kind === 'error') return 'warning'
  if (kind === 'warning') return 'warning'
  return 'info'
}
