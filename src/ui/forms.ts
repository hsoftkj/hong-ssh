import { el } from './dom'
import { icon } from './icons'

export interface FieldOptions {
  hint?: string
  required?: boolean
  wide?: boolean
}

export function field(label: string, control: HTMLElement, options: FieldOptions = {}): HTMLElement {
  return el(
    'label',
    { class: `form-field${options.wide ? ' is-wide' : ''}` },
    el(
      'span',
      { class: 'form-field-label' },
      label,
      options.required ? el('span', { class: 'required-mark', text: '*' }) : null
    ),
    control,
    options.hint ? el('span', { class: 'form-field-hint', text: options.hint }) : null
  )
}

export function textInput(options: {
  value?: string
  placeholder?: string
  type?: string
  autofocus?: boolean
  spellcheck?: boolean
  maxLength?: number
  name?: string
  disabled?: boolean
  onInput?: (value: string) => void
}): HTMLInputElement {
  const input = el('input', {
    class: 'text-input',
    type: options.type ?? 'text',
    value: options.value ?? '',
    placeholder: options.placeholder ?? '',
    autofocus: options.autofocus === true,
    spellcheck: options.spellcheck === false ? 'false' : 'true',
    maxlength: options.maxLength,
    name: options.name,
    disabled: options.disabled === true
  })
  if (options.onInput) input.addEventListener('input', () => options.onInput?.(input.value))
  return input
}

export function numberInput(options: {
  value: number
  min?: number
  max?: number
  step?: number
  name?: string
  onInput?: (value: number) => void
}): HTMLInputElement {
  const input = el('input', {
    class: 'text-input',
    type: 'number',
    value: String(options.value),
    min: options.min,
    max: options.max,
    step: options.step ?? 1,
    name: options.name
  })
  if (options.onInput) input.addEventListener('input', () => options.onInput?.(Number(input.value)))
  return input
}

export function selectInput(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange?: (value: string) => void
): HTMLSelectElement {
  const select = el('select', { class: 'select-input' })
  for (const option of options) {
    select.appendChild(el('option', { value: option.value, text: option.label, selected: option.value === value }))
  }
  if (onChange) select.addEventListener('change', () => onChange(select.value))
  return select
}

export function checkboxRow(
  label: string,
  checked: boolean,
  options: { hint?: string; disabled?: boolean; onChange?: (checked: boolean) => void } = {}
): HTMLElement {
  const input = el('input', {
    type: 'checkbox',
    checked,
    disabled: options.disabled === true
  })
  if (options.onChange) input.addEventListener('change', () => options.onChange?.(input.checked))
  return el(
    'label',
    { class: `checkbox-row${options.disabled ? ' is-disabled' : ''}` },
    input,
    el(
      'span',
      { class: 'checkbox-text' },
      el('span', { class: 'checkbox-label', text: label }),
      options.hint ? el('span', { class: 'checkbox-hint', text: options.hint }) : null
    )
  )
}

export function segmented<T extends string>(
  options: Array<{ value: T; label: string; icon?: string }>,
  value: T,
  onChange: (value: T) => void
): HTMLElement {
  const container = el('div', { class: 'segmented', role: 'radiogroup' })
  const buttons: HTMLButtonElement[] = []
  for (const option of options) {
    const button = el(
      'button',
      {
        class: `segmented-item${option.value === value ? ' is-active' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': option.value === value ? 'true' : 'false'
      },
      option.icon ? el('span', { class: 'segmented-icon', html: icon(option.icon, 16) }) : null,
      el('span', { text: option.label })
    )
    button.addEventListener('click', () => {
      for (const item of buttons) {
        item.classList.remove('is-active')
        item.setAttribute('aria-checked', 'false')
      }
      button.classList.add('is-active')
      button.setAttribute('aria-checked', 'true')
      onChange(option.value)
    })
    buttons.push(button)
    container.appendChild(button)
  }
  return container
}

export function colorSwatches(
  colors: string[],
  value: string,
  onChange: (color: string) => void
): HTMLElement {
  const container = el('div', { class: 'color-swatches', role: 'radiogroup' })
  for (const color of colors) {
    const button = el('button', {
      class: `color-swatch${color === value ? ' is-active' : ''}`,
      type: 'button',
      title: color,
      'aria-label': color,
      style: { backgroundColor: color }
    })
    button.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch').forEach((item) => item.classList.remove('is-active'))
      button.classList.add('is-active')
      onChange(color)
    })
    container.appendChild(button)
  }
  return container
}

export function formGrid(...children: Array<HTMLElement | null>): HTMLElement {
  return el('div', { class: 'form-grid' }, ...children)
}

export function formCard(title: string, subtitle: string, ...children: Array<HTMLElement | null>): HTMLElement {
  return el(
    'section',
    { class: 'form-card' },
    el(
      'header',
      { class: 'form-card-header' },
      el('h3', { class: 'form-card-title', text: title }),
      subtitle ? el('p', { class: 'form-card-subtitle', text: subtitle }) : null
    ),
    el('div', { class: 'form-card-body' }, ...children)
  )
}

export function button(
  label: string,
  options: {
    kind?: 'primary' | 'danger' | 'ghost' | 'default'
    icon?: string
    type?: 'button' | 'submit'
    disabled?: boolean
    onClick?: () => void
  } = {}
): HTMLButtonElement {
  const kind = options.kind ?? 'default'
  const btn = el(
    'button',
    {
      class: `btn btn-${kind}`,
      type: options.type ?? 'button',
      disabled: options.disabled === true
    },
    options.icon ? el('span', { class: 'btn-icon', html: icon(options.icon, 16) }) : null,
    el('span', { text: label })
  )
  if (options.onClick) btn.addEventListener('click', options.onClick)
  return btn
}

export function fieldsetMessage(kind: 'error' | 'success' | 'info', text: string): HTMLElement {
  return el('div', {
    class: `inline-message inline-message-${kind}`,
    role: kind === 'error' ? 'alert' : 'status'
  }, el('span', { html: icon(kind === 'success' ? 'check' : kind === 'error' ? 'warning' : 'info', 15) }), el('span', { text }))
}

export function setInvalid(fieldElement: HTMLElement, invalid: boolean): void {
  fieldElement.classList.toggle('is-invalid', invalid)
}
