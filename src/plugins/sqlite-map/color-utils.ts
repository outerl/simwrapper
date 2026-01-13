// Color and encoder utilities extracted from styling.ts

import * as cartoColors from 'cartocolor'
import type { RGBA, RGB } from './types'

export const hexToRgbA = (hex: string, alpha: number = 1): RGBA => {
  const bytes = hex.replace('#', '').match(/.{1,2}/g) || ['80', '80', '80']
  return [
    parseInt(bytes[0], 16),
    parseInt(bytes[1], 16),
    parseInt(bytes[2], 16),
    Math.round(alpha * 255),
  ]
}

export const hexToRgb = (hex: string): RGB => {
  const rgba = hexToRgbA(hex, 1)
  return [rgba[0], rgba[1], rgba[2]]
}

export const hexToRgba = (hex: string, alpha: number = 1): RGBA => hexToRgbA(hex, alpha)

export const getPaletteColors = (name: string, numColors: number): string[] => {
  const palette = (cartoColors as any)[name || 'YlGn']
  if (!palette) return Array(numColors).fill('#808080')
  const sizes = Object.keys(palette)
    .map(Number)
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  const size = sizes.find(s => s >= numColors) || sizes[sizes.length - 1]
  return palette[size] || Array(numColors).fill('#808080')
}

// Small numeric helpers used by encoders
export const toNumber = (value: any): number | null => {
  const num = Number(value)
  return isNaN(num) ? null : num
}

const safeMin = (arr: number[]): number => {
  if (arr.length === 0) return 0
  let min = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i]
  }
  return min
}

const safeMax = (arr: number[]): number => {
  if (arr.length === 0) return 1
  let max = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i]
  }
  return max
}

export const buildColorEncoder = (
  values: any[],
  style: any,
  dataRange: [number, number] | null = null
) => {
  if (dataRange) {
    values = values.map(v => {
      const num = toNumber(v)
      if (num === null) return null
      return Math.max(dataRange[0], Math.min(dataRange[1], num))
    })
  }

  const nums = values.map(toNumber).filter((v): v is number => v !== null)
  const s = style || {}
  const [min, max] = s.range ? s.range : [safeMin(nums), safeMax(nums)]

  const paletteName = s.palette || 'YlGn'
  const numColors = s.numColors || 7
  const colors = getPaletteColors(paletteName, numColors).map((h: string) => hexToRgba(h, 1))

  const scale = max === min ? 0 : (numColors - 1) / (max - min)

  return (value: any) => {
    const num = toNumber(value) ?? min
    const idx = Math.round((num - min) * scale)
    return colors[Math.max(0, Math.min(numColors - 1, idx))]
  }
}

export const buildCategoryEncoder = (
  colors: Record<string, string>,
  defaultColor: string = '#808080'
) => {
  const colorMap = new Map<string, RGBA>()
  for (const [key, hex] of Object.entries(colors)) {
    colorMap.set(String(key), hexToRgbA(hex, 1))
  }
  const defaultRgba = hexToRgbA(defaultColor, 1)

  return (value: any) => colorMap.get(String(value)) || defaultRgba
}
