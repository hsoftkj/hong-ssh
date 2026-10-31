import type { HongSshApi } from '../types'
import { el } from './dom'
import { icon, logo } from './icons'

export class TitleBar {
  readonly element: HTMLElement
  private readonly maximizeButton: HTMLButtonElement
  private readonly maximizeIcon: HTMLElement
  private maximized = false
  private readonly unsubscribe: () => void

  constructor(api: HongSshApi) {
    this.maximizeIcon = el('span', { class: 'titlebar-control-icon', html: icon('maximize', 14) })
    this.maximizeButton = el(
      'button',
      {
        class: 'titlebar-control',
        type: 'button',
        title: '最大化',
        'aria-label': '最大化',
        onclick: () => void api.windowToggleMaximize()
      },
      this.maximizeIcon
    )
    const minimizeButton = el(
      'button',
      {
        class: 'titlebar-control',
        type: 'button',
        title: '最小化',
        'aria-label': '最小化',
        html: icon('minimize', 14),
        onclick: () => void api.windowMinimize()
      },
      null
    )
    const closeButton = el(
      'button',
      {
        class: 'titlebar-control is-close',
        type: 'button',
        title: '关闭',
        'aria-label': '关闭',
        html: icon('close', 14),
        onclick: () => void api.windowClose()
      },
      null
    )

    const dragArea = el(
      'div',
      { class: 'titlebar-drag' },
      el('span', { class: 'titlebar-logo', html: logo(18) }),
      el(
        'div',
        { class: 'titlebar-brand' },
        el('span', { class: 'titlebar-title', text: 'HongSSH' }),
        el('span', { class: 'titlebar-subtitle', text: 'SECURE TERMINAL' })
      )
    )
    dragArea.addEventListener('dblclick', () => void api.windowToggleMaximize())

    this.element = el(
      'header',
      { class: 'titlebar' },
      dragArea,
      el('div', { class: 'titlebar-controls' }, minimizeButton, this.maximizeButton, closeButton)
    )

    this.unsubscribe = api.onWindowMaximized((maximized) => this.setMaximized(maximized))
    void api
      .windowIsMaximized()
      .then((maximized) => this.setMaximized(maximized))
      .catch(() => {})
  }

  dispose(): void {
    this.unsubscribe()
  }

  private setMaximized(maximized: boolean): void {
    this.maximized = Boolean(maximized)
    this.maximizeIcon.innerHTML = icon(this.maximized ? 'restore' : 'maximize', 14)
    const label = this.maximized ? '还原' : '最大化'
    this.maximizeButton.title = label
    this.maximizeButton.setAttribute('aria-label', label)
  }
}
