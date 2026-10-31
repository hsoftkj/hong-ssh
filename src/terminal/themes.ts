import type { ITheme } from '@xterm/xterm'
import type { TerminalThemeName } from '../types'

export interface TerminalThemeDefinition {
  name: TerminalThemeName
  label: string
  description: string
  background: string
  foreground: string
  palette: string[]
  theme: ITheme
}

const xshell: ITheme = {
  background: '#000000',
  foreground: '#d7d7d7',
  cursor: '#33d17a',
  cursorAccent: '#000000',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

const solarized: ITheme = {
  background: '#002b36',
  foreground: '#93a1a1',
  cursor: '#b58900',
  cursorAccent: '#002b36',
  selectionBackground: '#0f4b5b',
  selectionForeground: '#eee8d5',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#93a1a1',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3'
}

const light: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d7ff',
  selectionForeground: '#0b1f33',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#7d4e00',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#0f6b72',
  brightWhite: '#8c959f'
}

export const TERMINAL_THEMES: Record<TerminalThemeName, TerminalThemeDefinition> = {
  xshell: {
    name: 'xshell',
    label: '经典黑',
    description: '黑底绿光标，还原 Xshell 默认终端配色',
    background: '#000000',
    foreground: '#d7d7d7',
    palette: ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5'],
    theme: xshell
  },
  solarized: {
    name: 'solarized',
    label: 'Solarized Dark',
    description: '低对比度深蓝配色，适合长时间使用',
    background: '#002b36',
    foreground: '#93a1a1',
    palette: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    theme: solarized
  },
  light: {
    name: 'light',
    label: '明亮',
    description: '白底深色文字，适合强光环境',
    background: '#ffffff',
    foreground: '#24292f',
    palette: ['#24292f', '#cf222e', '#116329', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
    theme: light
  }
}

export const TERMINAL_THEME_ORDER: TerminalThemeName[] = ['xshell', 'solarized', 'light']

export const DEFAULT_FONT_FAMILY =
  '"Cascadia Mono", Consolas, "JetBrains Mono", "Microsoft YaHei UI", "Microsoft YaHei", monospace'
