import type { AppTheme } from './types'

export interface AppThemeDefinition {
  id: AppTheme
  label: string
  dark: boolean
}

export const APP_THEMES: AppThemeDefinition[] = [
  { id: 'light', label: '默认', dark: false },
  { id: 'flat', label: '扁平化', dark: false },
  { id: 'skeuomorphic', label: '拟物风', dark: false },
  { id: 'handdrawn', label: '手绘涂鸦风', dark: false },
  { id: 'watercolor', label: '水彩水墨风', dark: false },
  { id: 'pixel', label: '像素风', dark: true },
  { id: 'neumorphic', label: '新拟态', dark: false },
  { id: 'cyberpunk', label: '赛博朋克', dark: true },
  { id: 'dark', label: '深色模式', dark: true },
  { id: 'paper', label: '纸张卡片', dark: false },
  { id: 'cute', label: '可爱萌系', dark: false },
  { id: 'minimal', label: '极简主义', dark: false },
  { id: 'swiss', label: '瑞士平面', dark: false },
  { id: 'neon', label: '荧光高亮', dark: true },
  { id: 'metal', label: '金属拉丝', dark: false },
  { id: 'wood', label: '木纹竹质', dark: false },
  { id: 'fabric', label: '布料毛绒', dark: false },
  { id: 'gothic', label: '暗黑哥特', dark: true },
  { id: 'forest', label: '清新森系', dark: false },
  { id: 'luxury', label: '奢华高贵', dark: false },
  { id: 'eyecare', label: '护眼模式', dark: false }
]

export const APP_THEME_MAP = new Map(APP_THEMES.map((theme) => [theme.id, theme]))

export function isDarkAppTheme(theme: AppTheme): boolean {
  return APP_THEME_MAP.get(theme)?.dark === true
}

export function appThemeLabel(theme: AppTheme): string {
  return APP_THEME_MAP.get(theme)?.label || '默认'
}
