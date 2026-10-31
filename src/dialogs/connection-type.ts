import { el } from '../ui/dom'
import { icon } from '../ui/icons'
import type { ModalHost } from '../ui/modal'
import { button } from '../ui/forms'

export type ConnectionType = 'ssh' | 'remoteDesktop'

interface ConnectionTypeDialogOptions {
  folderLabel?: string
  onSelect: (type: ConnectionType) => void
}

export function chooseConnectionType(
  modal: ModalHost,
  options: ConnectionTypeDialogOptions
): void {
  const sshCard = typeCard(
    'SSH 终端',
    '连接 Linux、Unix 或开启了 OpenSSH 的 Windows 主机，使用命令行终端。',
    'terminal'
  )
  const remoteCard = typeCard(
    'Windows 远程桌面',
    '控制另一台安装了 HongSSH 的 Windows 电脑，可看屏幕、用键鼠并传文件。',
    'layout'
  )
  const handle = modal.open({
    title: '新建连接',
    subtitle: options.folderLabel
      ? `选择连接类型，将创建在“${options.folderLabel}”中。`
      : '先选择连接类型，再填写对应的连接信息。',
    icon: 'plus',
    width: 560,
    body: el(
      'div',
      { class: 'connection-type-choices' },
      sshCard.element,
      remoteCard.element
    ),
    footer: el(
      'div',
      { class: 'modal-actions' },
      button('取消', { kind: 'ghost', onClick: () => handle.close() })
    )
  })
  sshCard.element.addEventListener('click', () => {
    handle.close()
    options.onSelect('ssh')
  })
  remoteCard.element.addEventListener('click', () => {
    handle.close()
    options.onSelect('remoteDesktop')
  })
}

function typeCard(
  title: string,
  description: string,
  iconName: string
): { element: HTMLButtonElement } {
  const element = el(
    'button',
    { class: 'connection-type-card', type: 'button' },
    el('span', { class: 'connection-type-icon', html: icon(iconName, 22) }),
    el(
      'span',
      { class: 'connection-type-text' },
      el('span', { class: 'connection-type-title', text: title }),
      el('span', { class: 'connection-type-desc', text: description })
    ),
    el('span', { class: 'connection-type-arrow', html: icon('chevronRight', 16) })
  )
  return { element }
}
