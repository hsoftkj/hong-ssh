import type { Connection } from '../types'
import { el } from '../ui/dom'
import { icon } from '../ui/icons'
import type { ModalHandle, ModalHost } from '../ui/modal'
import { button, checkboxRow, field, fieldsetMessage } from '../ui/forms'

interface PasswordDialogOptions {
  modal: ModalHost
  connection: Connection
  secretsEncrypted: boolean
  mode?: 'password' | 'passphrase'
}

export interface PasswordResult {
  password: string
  remember: boolean
}

export function askPassword(options: PasswordDialogOptions): Promise<PasswordResult | null> {
  const { modal, connection, secretsEncrypted } = options
  const mode = options.mode ?? 'password'
  const isPassphrase = mode === 'passphrase'
  const title = isPassphrase ? '输入私钥口令' : '输入登录密码'
  const input = el('input', {
    class: 'text-input',
    type: 'password',
    placeholder: isPassphrase ? '私钥口令' : '密码',
    autofocus: true,
    spellcheck: 'false'
  })
  const errorArea = el('div', { class: 'form-message', hidden: true })
  const remember = checkboxRow(
    isPassphrase ? '记住私钥口令' : '记住密码',
    secretsEncrypted,
    {
      hint: secretsEncrypted
        ? '使用 Windows DPAPI 加密后保存在本机。'
        : '当前系统不支持安全凭据存储，本次输入不会被保存。',
      disabled: !secretsEncrypted
    }
  )

  let settled = false
  let handle: ModalHandle
  const finish = (result: PasswordResult | null) => {
    if (settled) return
    settled = true
    handle.close()
    resolve(result)
  }

  const submit = () => {
    const value = input.value
    if (!value) {
      errorArea.hidden = false
      errorArea.replaceChildren(fieldsetMessage('error', isPassphrase ? '请输入私钥口令' : '请输入登录密码'))
      input.focus()
      return
    }
    finish({ password: value, remember: (remember.querySelector('input') as HTMLInputElement).checked })
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  })

  let resolve: (value: PasswordResult | null) => void = () => {}
  const promise = new Promise<PasswordResult | null>((res) => {
    resolve = res
  })

  handle = modal.open({
    title,
    subtitle: `${connection.username}@${connection.host}:${connection.port}`,
    icon: isPassphrase ? 'key' : 'lock',
    width: 440,
    closeOnBackdrop: false,
    body: el(
      'div',
      { class: 'password-dialog' },
      el(
        'div',
        { class: 'password-target' },
        el('span', { class: 'password-target-icon', html: icon('server', 18) }),
        el(
          'div',
          {},
          el('strong', { text: connection.name }),
          el('span', { text: `${connection.host}:${connection.port}` })
        )
      ),
      el(
        'div',
        { class: 'password-account' },
        el('span', { class: 'password-account-label', text: '用户名' }),
        el('span', { class: 'password-account-value', text: connection.username })
      ),
      errorArea,
      field(isPassphrase ? '私钥口令' : '登录密码', input, {
        hint: isPassphrase
          ? '该私钥已被加密，请输入创建密钥时设置的口令。'
          : '密码只发送给本机 SSH 进程，不会上传到任何服务器。'
      }),
      remember
    ),
    footer: el(
      'div',
      { class: 'modal-actions' },
      button('取消', { kind: 'ghost', onClick: () => finish(null) }),
      button(isPassphrase ? '解锁并连接' : '连接', {
        kind: 'primary',
        onClick: submit
      })
    ),
    onClose: () => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    }
  })

  return promise
}
