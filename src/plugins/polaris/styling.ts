/**
 * Styling utilities for POLARIS plugin
 * 
 * This module provides functions for building visual styles from feature data.
 * It handles color encoding, size mapping, filtering, and the creation
 * of typed arrays optimized for WebGL rendering.
 * 
 * @fileoverview Data-Driven Styling System for POLARIS
 */

import * as cartoColors from 'cartocolor'
import type {
  RGBA,
  RGB,
  ColorStyle,
  QuantitativeColorStyle,
  NumericStyle,
  LayerStyle,
  BuildArgs,
  BuildResult,
} from './types'


/**
 * Converts a hex color string to RGB array
 * 
 * @param hex - Hex color string (with or without #)
 * @returns RGB array [R, G, B] with values 0-255
 */
const hexToRgb = (hex: string): RGB => {
  const match = hex.replace('#', '').match(/.{1,2}/g) || ['80', '80', '80']
  return [parseInt(match[0], 16), parseInt(match[1], 16), parseInt(match[2], 16)]
}

/**
 * Converts a hex color string to RGBA array
 * 
 * @param hex - Hex color string (with or without #)
 * @param alpha - Alpha value (0-1), default 1 (opaque)
 * @returns RGBA array [R, G, B, A] with values 0-255
 */
const hexToRgba = (hex: string, alpha: number = 1): RGBA => {
  const match = hex.replace('#', '').match(/.{1,2}/g) || ['80', '80', '80']
  return [
    parseInt(match[0], 16),
    parseInt(match[1], 16),
    parseInt(match[2], 16),
    Math.round(alpha * 255),
  ]
}

/**
 * Gets color palette from CartoColor library
 * 
 * @param name - Name of the color palette (e.g., 'YlGn', 'Viridis')
 * @param numColors - Number of colors needed
 * @returns Array of hex color strings
 */
export const getPaletteColors = (name: string, numColors: number): string[] => {
  // Normalize palette name - CartoColors uses specific casing
  let paletteName = name || 'YlGn'

  // Debug: print available palettes
  const allPalettes = (cartoColors as any).default || cartoColors;

  // Map common lowercase names to proper CartoColors names
  const paletteMap: Record<string, string> = {
    'viridis': 'Viridis',
    'plasma': 'Plasma', 
    'inferno': 'Inferno',
    'magma': 'Magma',
    'blues': 'Blues',
    'greens': 'Greens',
    'reds': 'Reds',
    'oranges': 'Oranges',
    'purples': 'Purples',
    'ylgn': 'YlGn',
    'ylgnbu': 'YlGnBu',
    'gnbu': 'GnBu',
    'bugn': 'BuGn',
    'pubugn': 'PuBuGn',
    'pubu': 'PuBu',
    'bupu': 'BuPu',
    'rdpu': 'RdPu',
    'purd': 'PuRd',
    'orrd': 'OrRd',
    'ylorbr': 'YlOrBr',
    'ylorrd': 'YlOrRd',
    'peach': 'Peach',
    'pinkyl': 'PinkYl',
    'mint': 'Mint',
    'burgyl': 'BurgYl',
    'burg': 'Burg',
    'sunset': 'Sunset',
    'sunsetdark': 'SunsetDark',
    'agolagn': 'AgolaGn',
    'brwnyl': 'BrwnYl',
    'teal': 'Teal',
    'tealgrn': 'TealGrn',
    'purp': 'Purp',
    'purpor': 'PurpOr',
    'emrld': 'Emrld',
  }
  
  const lowerName = paletteName.toLowerCase()
  if (paletteMap[lowerName]) {
    paletteName = paletteMap[lowerName]
  }
  
  let palette = (cartoColors as any)[paletteName]
  // Handle CommonJS default export if needed
  if (!palette && (cartoColors as any).default) {
    palette = (cartoColors as any).default[paletteName]
  }
  
  // If still not found, try case-insensitive search
  if (!palette) {
    const allPalettes = (cartoColors as any).default || cartoColors
    const foundKey = Object.keys(allPalettes).find(k => k.toLowerCase() === lowerName)
    if (foundKey) palette = allPalettes[foundKey]
  }
  
  if (!palette) {
    console.warn(`[styling] Palette "${name}" not found, using fallback grey`)
    return Array(numColors).fill('#808080')
  }
  
  const sizes = Object.keys(palette)
    .map(Number)
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  const size = sizes.find(s => s >= numColors) || sizes[sizes.length - 1]
  return palette[size] || Array(numColors).fill('#808080')
}

/**
 * Generate a deterministic random color from a string seed (for categorical values)
 * 
 * @param seed - String value to generate color from
 * @returns RGBA array [R, G, B, A]
 */
export const generateRandomColor = (seed: string): RGBA => {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  }
  // Use golden ratio to spread colors evenly in hue space
  const hue = ((hash & 0xffff) / 0xffff) * 360
  const saturation = 0.65 + ((hash >> 16) & 0xff) / 255 * 0.25
  const lightness = 0.45 + ((hash >> 24) & 0xff) / 255 * 0.15
  
  // HSL to RGB conversion
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1))
  const m = lightness - c / 2
  let r = 0, g = 0, b = 0
  if (hue < 60) { r = c; g = x; b = 0 }
  else if (hue < 120) { r = x; g = c; b = 0 }
  else if (hue < 180) { r = 0; g = c; b = x }
  else if (hue < 240) { r = 0; g = x; b = c }
  else if (hue < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
    255
  ]
}

/**
 * Build categorical encoder with auto-generated random colors
 * 
 * @param values - Array of categorical values
 * @returns Encoder function that maps values to RGBA colors
 */
export const buildAutoCategoryEncoder = (values: any[]): ((value: any) => RGBA) => {
  const unique = [...new Set(values.map(String))]
  const colorMap = new Map<string, RGBA>()
  for (const val of unique) {
    colorMap.set(val, generateRandomColor(val))
  }
  return (value: any) => colorMap.get(String(value)) || [128, 128, 128, 255]
}

/**
 * Build continuous gradient encoder for numeric values
 * 
 * @param values - Array of numeric values to determine range
 * @param colors - Start and end colors for gradient (hex strings)
 * @returns Encoder function that maps numeric values to RGBA colors
 */
export const buildGradientEncoder = (
  values: number[],
  colors: [string, string] = ['#ffffcc', '#006837']
): ((value: number) => RGBA) => {
  const min = safeMin(values)
  const max = safeMax(values)
  const range = max - min || 1
  const startRgba = hexToRgba(colors[0])
  const endRgba = hexToRgba(colors[1])

  return (value: number) => {
    const t = Math.max(0, Math.min(1, (value - min) / range))
    return [
      Math.round(startRgba[0] + t * (endRgba[0] - startRgba[0])),
      Math.round(startRgba[1] + t * (endRgba[1] - startRgba[1])),
      Math.round(startRgba[2] + t * (endRgba[2] - startRgba[2])),
      255,
    ]
  }
}

/**
 * Safely converts a value to number, returning null for invalid values
 * 
 * @param value - Value to convert to number
 * @returns Number or null if conversion fails
 */
const toNumber = (value: any): number | null => {
  const num = Number(value)
  return isNaN(num) ? null : num
}

/**
 * Safe minimum function that avoids stack overflow on large arrays
 * 
 * @param arr - Array of numbers
 * @returns Minimum value, or 0 if array is empty
 */
const safeMin = (arr: number[]): number => {
  if (arr.length === 0) return 0
  let min = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i]
  }
  return min
}

/**
 * Safe maximum function that avoids stack overflow on large arrays
 * 
 * @param arr - Array of numbers
 * @returns Maximum value, or 1 if array is empty
 */
const safeMax = (arr: number[]): number => {
  if (arr.length === 0) return 1
  let max = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i]
  }
  return max
}

const buildColorEncoder = (
  values: any[],
  style: QuantitativeColorStyle,
  dataRange: [number, number] | null = null
) => {
  // Use dataRange from style if provided
  const effectiveRange = dataRange || (style as any).dataRange || null
  
  if (effectiveRange) {
    // clamp the values to within the data range
    values = values.map(v => {
      const num = toNumber(v)
      if (num === null) return null
      return Math.max(effectiveRange[0], Math.min(effectiveRange[1], num))
    })
  }

  const nums = values.map(toNumber).filter((v): v is number => v !== null)

  const hasLegacyMinMax =
    typeof style.min === 'number' &&
    Number.isFinite(style.min) &&
    typeof style.max === 'number' &&
    Number.isFinite(style.max)

  const [min, max] = effectiveRange
    ? effectiveRange
    : style.range
      ? style.range
      : hasLegacyMinMax
        ? [style.min!, style.max!]
        : [safeMin(nums), safeMax(nums)]

  const paletteName = style.palette || style.colorScheme || 'YlGn'
  const numColors = 'numColors' in style ? style.numColors : 7
  const colors = getPaletteColors(paletteName, numColors).map(h => hexToRgba(h, 1))

  const scale = max === min ? 0 : (numColors - 1) / (max - min)

  return (value: any) => {
    const num = toNumber(value) ?? min
    const idx = Math.round((num - min) * scale)
    return colors[Math.max(0, Math.min(numColors - 1, idx))]
  }
}

const buildCategoryEncoderRgb = (colors: Record<string, string>, defaultColor: string = '#808080') => {
  const colorMap = new Map<string, RGB>()
  for (const [key, hex] of Object.entries(colors)) {
    colorMap.set(String(key), hexToRgb(hex))
  }
  const defaultRgb = hexToRgb(defaultColor)

  return (value: any): RGB => {
    return colorMap.get(String(value)) || defaultRgb
  }
}

const getProp = (props: any, key: string): any => {
  if (!props) return null
  if (key in props) return props[key]
  // Case-insensitive fallback
  const lower = key.toLowerCase()
  const found = Object.keys(props).find(k => k.toLowerCase() === lower)
  return found ? props[found] : null
}

const buildCategoryEncoderRgba = (colors: Record<string, string>, defaultColor: string = '#808080') => {
  const colorMap = new Map<string, RGBA>()
  for (const [key, hex] of Object.entries(colors)) {
    colorMap.set(String(key), hexToRgba(hex, 1))
  }
  const defaultRgba = hexToRgba(defaultColor, 1)

  return (value: any): RGBA => {
    return colorMap.get(String(value)) || defaultRgba
  }
}

const applyQuantitativeMapping = (
  values: (number | null)[],
  dataRange: [number, number],
  outputRange: [number, number],
  target: Float32Array,
  idxs: number[],
  stride: number,
  offset: number
) => {
  const [dataMin, dataMax] = dataRange
  const [outMin, outMax] = outputRange
  const scale = dataMax === dataMin ? 0 : 1 / (dataMax - dataMin)

  for (let j = 0; j < values.length; j++) {
    const targetIndex = idxs[j]
    if (targetIndex === undefined) continue
    const num = values[j]
    const normalized = num === null ? 0 : (num - dataMin) * scale
    target[targetIndex * stride + offset] = Math.max(
      outMin,
      Math.min(outMax, normalized * (outMax - outMin) + outMin)
    )
  }
}

/**
 * Builds typed arrays for efficient WebGL rendering from feature data and styling rules
 * 
 * This is the main function that converts GeoJSON features and layer styling
 * configurations into the typed arrays needed for high-performance map rendering.
 * It handles color encoding, size mapping, filtering, and optimization for GPU rendering.
 * 
 * @param args - Build arguments containing features, layer configs, and defaults
 * @returns BuildResult with typed arrays ready for WebGL rendering
 */
export function buildStyleArrays(args: BuildArgs): BuildResult {
  const { features, layers, defaults = {} } = args

  const N = features.length
  const fillColors = new Uint8ClampedArray(N * 4)
  const lineColors = new Uint8ClampedArray(N * 3) // RGB only
  const lineWidths = new Float32Array(N)
  const pointRadii = new Float32Array(N)
  const fillHeights = new Float32Array(N)
  const featureFilter = new Float32Array(N)

  // Pre-index features by layer name in properties._layer to allow per-layer style
  // Fallback to globalstyle if properties._layer isn’t present.
  type LayerBucket = { idxs: number[]; props: any[]; style?: LayerStyle }
  const buckets = new Map<string, LayerBucket>()
  for (let i = 0; i < N; i++) {
    const props = features[i]?.properties || {}
    const layerName = props._layer || 'GLOBAL'
    const bucket = buckets.get(layerName) || {
      idxs: [],
      props: [],
      style: layers[layerName]?.style,
    }
    bucket.idxs.push(i)
    bucket.props.push(props)
    bucket.style = layers[layerName]?.style || bucket.style
    buckets.set(layerName, bucket)
  }

  // Global defaults used if no layer style present
  const defaultFill = hexToRgba(defaults.fillColor || '#59a14f', 1)
  const defaultLine = hexToRgb(defaults.lineColor || '#4e79a7')
  const defaultWidth = defaults.lineWidth ?? 2
  const defaultRadius = defaults.pointRadius ?? 4
  const defaultHeight = defaults.fillHeight ?? 0

  // Initialize everything to defaults first
  for (let i = 0; i < N; i++) {
    fillColors.set(defaultFill, i * 4)
    lineColors.set(defaultLine, i * 3) // RGB offset
    lineWidths[i] = defaultWidth
    pointRadii[i] = defaultRadius
    fillHeights[i] = defaultHeight
    featureFilter[i] = 1 // visible by default
  }

  // Apply per-layer styles
  for (const [layerName, bucket] of buckets.entries()) {
    const style = bucket.style
    const idxs = bucket.idxs
    const propsArr = bucket.props

    if (!style) continue

    // filter
    if (style.filter && 'column' in style.filter) {
      const col = (style.filter as any).column
      const include: any[] | undefined = (style.filter as any).include
      const exclude: any[] | undefined = (style.filter as any).exclude
      for (let j = 0; j < idxs.length; j++) {
        const i = idxs[j]
        const v = propsArr[j]?.[col]
        let visible = true
        if (include && include.length) visible = include.includes(v)
        if (exclude && exclude.length) visible = visible && !exclude.includes(v)
        featureFilter[i] = visible ? 1 : 0
      }
    }

    if (style.fillColor) {
      if (typeof style.fillColor === 'string') {
        // Static hex color
        const color = hexToRgba(style.fillColor, 1)
        for (let j = 0; j < idxs.length; j++) {
          fillColors.set(color, idxs[j] * 4)
        }
      } else if ('colors' in style.fillColor) {
        const encoder = buildCategoryEncoderRgba(style.fillColor.colors, '#808080')
        for (let j = 0; j < idxs.length; j++) {
          fillColors.set(encoder(getProp(propsArr[j], style.fillColor.column)), idxs[j] * 4)
        }
      } else if ('column' in style.fillColor || 'palette' in style.fillColor) {
        // Column-based (quantitative) encoding
        const fcStyle = style.fillColor as any
        const clampRange = fcStyle.dataRange || fcStyle.range || null
        
        const encoder = buildColorEncoder(
          propsArr.map(p => getProp(p, fcStyle.column)),
          style.fillColor as QuantitativeColorStyle,
          clampRange
        )
        for (let j = 0; j < idxs.length; j++) {
          const val = getProp(propsArr[j], fcStyle.column)
          const color = encoder(val)
          fillColors.set(color, idxs[j] * 4)
        }
      }
    }

    if (style.lineColor) {
      if (typeof style.lineColor === 'string') {
        // Static hex color
        const rgb = hexToRgb(style.lineColor)
        for (let j = 0; j < idxs.length; j++) {
          lineColors[idxs[j] * 3] = rgb[0]
          lineColors[idxs[j] * 3 + 1] = rgb[1]
          lineColors[idxs[j] * 3 + 2] = rgb[2]
        }
      } else if ('colors' in style.lineColor) {
        const encoder = buildCategoryEncoderRgb(style.lineColor.colors, '#808080')
        for (let j = 0; j < idxs.length; j++) {
          lineColors.set(encoder(getProp(propsArr[j], style.lineColor.column)), idxs[j] * 3)
        }
      } else if ('column' in style.lineColor) {
        // Column-based encoding
        const clampRange =
          (style.lineColor as any).dataRange ||
          (style.lineColor as any).range ||
          (typeof (style.lineColor as any).min === 'number' && typeof (style.lineColor as any).max === 'number'
            ? [(style.lineColor as any).min, (style.lineColor as any).max]
            : null)
        const encoder = buildColorEncoder(
          propsArr.map(p => getProp(p, style.lineColor!.column)),
          style.lineColor as QuantitativeColorStyle,
          clampRange
        )
        for (let j = 0; j < idxs.length; j++) {
          const [r, g, b] = encoder(getProp(propsArr[j], style.lineColor.column))
          lineColors[idxs[j] * 3] = r
          lineColors[idxs[j] * 3 + 1] = g
          lineColors[idxs[j] * 3 + 2] = b
        }
      }
    }

    // lineWidth - handle static, array, category, and column-based
    if (style.lineWidth) {
      if (Array.isArray(style.lineWidth)) {
        // Assign each width in the array to the corresponding feature
        for (let j = 0; j < idxs.length; j++) {
          lineWidths[idxs[j]] = style.lineWidth[j] ?? defaultWidth
        }
      } else if (typeof style.lineWidth === 'number') {
        for (let j = 0; j < idxs.length; j++) {
          lineWidths[idxs[j]] = style.lineWidth
        }
      } else if (
        typeof style.lineWidth === 'object' &&
        'widths' in style.lineWidth &&
        'column' in style.lineWidth
      ) {
        // Category-based mapping: { column, widths }
        const widthMap = style.lineWidth.widths || {}
        for (let j = 0; j < idxs.length; j++) {
          const v = getProp(propsArr[j], style.lineWidth.column)
          lineWidths[idxs[j]] = widthMap[v] ?? defaultWidth
        }
      } else if ('column' in style.lineWidth) {
        const values = propsArr.map(p => toNumber(getProp(p, style.lineWidth!.column)))
        applyQuantitativeMapping(
          values,
          style.lineWidth.dataRange ?? [1, 6],
          style.lineWidth.widthRange ?? [1, 6],
          lineWidths,
          idxs,
          1,
          0
        )
      }
    }

    // pointRadius - handle static and column-based
    if (style.pointRadius) {
      if (typeof style.pointRadius === 'number') {
        for (let j = 0; j < idxs.length; j++) {
          pointRadii[idxs[j]] = style.pointRadius
        }
      } else if ('column' in style.pointRadius) {
        const values = propsArr.map(p => toNumber(getProp(p, style.pointRadius!.column)))
        applyQuantitativeMapping(
          values,
          style.pointRadius.dataRange ?? [2, 12],
          style.pointRadius.widthRange ?? [2, 12],
          pointRadii,
          idxs,
          1,
          0
        )
      }
    }

    // fillHeight - handle both static and column-based
    if (style.fillHeight) {
      if (typeof style.fillHeight === 'number') {
        for (let j = 0; j < idxs.length; j++) {
          fillHeights[idxs[j]] = style.fillHeight
        }
      } else if ('column' in style.fillHeight) {
        const values = propsArr.map(p => toNumber(getProp(p, style.fillHeight!.column)))
        applyQuantitativeMapping(
          values,
          style.fillHeight.dataRange ?? [0, 100],
          style.fillHeight.widthRange ?? [0, 100],
          fillHeights,
          idxs,
          1,
          0
        )
      }
    }
  }

  return {
    fillColors,
    lineColors,
    lineWidths,
    pointRadii,
    fillHeights,
    featureFilter,
  }
}
