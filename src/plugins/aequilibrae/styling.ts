import * as cartoColors from 'cartocolor'
import { RGBA, RGB, ColorStyle, LayerStyle, BuildArgs, BuildResult } from './types'

// Local helper types
type ColumnProperties = Record<string, any>
type PropertiesArray = ColumnProperties[]

// Unified hex -> RGB(A) parser
const hexToRgbA = (hex: string, alpha: number = 1): RGBA => {
  const bytes = hex.replace('#', '').match(/.{1,2}/g) || ['80', '80', '80']
  return [
    parseInt(bytes[0], 16),
    parseInt(bytes[1], 16),
    parseInt(bytes[2], 16),
    Math.round(alpha * 255),
  ]
}

const hexToRgb = (hex: string): RGB => {
  const rgba = hexToRgbA(hex, 1)
  return [rgba[0], rgba[1], rgba[2]]
}

const hexToRgba = (hex: string, alpha: number = 1): RGBA => hexToRgbA(hex, alpha)

/**
 * Gets color palette from CartoColor library
 *
 * @param name - Name of the color palette (e.g., 'YlGn', 'Viridis')
 * @param numColors - Number of colors needed
 * @returns Array of hex color strings
 */
const getPaletteColors = (name: string, numColors: number): string[] => {
  const palette = (cartoColors as any)[name || 'YlGn']
  if (!palette) return Array(numColors).fill('#808080')
  const sizes = Object.keys(palette)
    .map(Number)
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  const size = sizes.find(s => s >= numColors) || sizes[sizes.length - 1]
  return palette[size] || Array(numColors).fill('#808080')
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

const buildCategoryEncoder = (colors: Record<string, string>, defaultColor: string = '#808080') => {
  const colorMap = new Map<string, RGBA>()
  for (const [key, hex] of Object.entries(colors)) {
    colorMap.set(String(key), hexToRgbA(hex, 1))
  }
  const defaultRgba = hexToRgbA(defaultColor, 1)

  return (value: any) => colorMap.get(String(value)) || defaultRgba
}

const applyQuantitativeMapping = (
  values: (number | null)[],
  dataRange: [number, number],
  outputRange: [number, number],
  target: Float32Array,
  stride: number,
  offset: number
) => {
  const [dataMin, dataMax] = dataRange
  const [outMin, outMax] = outputRange
  const scale = dataMax === dataMin ? 0 : 1 / (dataMax - dataMin)

  for (let i = 0; i < values.length; i++) {
    const num = values[i]
    const normalized = num === null ? 0 : (num - dataMin) * scale
    target[i * stride + offset] = Math.max(
      outMin,
      Math.min(outMax, normalized * (outMax - outMin) + outMin)
    )
  }
}

// Helper to write either a scalar or an array value into a typed array
function writeValue(
  target: ArrayLike<number>,
  baseIndex: number,
  stride: number,
  offset: number,
  value: number | number[]
) {
  if (Array.isArray(value)) {
    for (let k = 0; k < value.length; k++) {
      ;(target as any)[baseIndex + stride * 0 + offset + k] = value[k]
    }
  } else {
    ;(target as any)[baseIndex + offset] = value
  }
}

const applyStaticValue = <T extends number[] | Uint8ClampedArray | Float32Array>(
  indices: number[],
  value: T extends Uint8ClampedArray ? RGBA | RGB : number,
  target: T,
  stride: number = 1,
  offset: number = 0
) => {
  for (let j = 0; j < indices.length; j++) {
    const base = indices[j] * stride
    writeValue(target, base, 1, offset, value as any)
  }
}

const applyEncodedValue = <T extends number[] | Uint8ClampedArray | Float32Array>(
  indices: number[],
  properties: any[],
  column: string,
  encoder: (value: any) => T extends Uint8ClampedArray ? RGBA | RGB : number,
  target: T,
  stride: number = 1,
  offset: number = 0
) => {
  for (let j = 0; j < indices.length; j++) {
    const base = indices[j] * stride
    const encoded = encoder(properties[j]?.[column]) as any
    writeValue(target, base, 1, offset, encoded)
  }
}

const applyStaticNumeric = (indices: number[], value: number, target: Float32Array) => {
  applyStaticValue(indices, value as any, target as any, 1, 0)
}

/**
 * Apply numeric values from an array to features at given indices
 */
// Unified numeric writer: writes a scalar or array value into a Float32Array
const writeNumeric = (
  target: Float32Array,
  indices: number[],
  getValue: (i: number) => number | undefined,
  defaultValue: number
) => {
  for (let j = 0; j < indices.length; j++) {
    const value = getValue(j)
    target[indices[j]] = value ?? defaultValue
  }
}

const applyNumericArray = (
  indices: number[],
  values: (number | undefined)[],
  target: Float32Array,
  defaultValue: number
) => {
  writeNumeric(target, indices, i => values[i], defaultValue)
}

/**
 * Apply category-based numeric mapping
 */
const applyNumericCategory = (
  indices: number[],
  properties: any[],
  column: string,
  mapping: Record<any, number>,
  target: Float32Array,
  defaultValue: number
) => {
  writeNumeric(target, indices, i => mapping[properties[i]?.[column]], defaultValue)
}

/**
 * Apply feature filter based on include/exclude lists
 */
const applyFeatureFilter = (
  indices: number[],
  properties: any[],
  column: string,
  include: any[] | undefined,
  exclude: any[] | undefined,
  target: Float32Array
) => {
  for (let j = 0; j < indices.length; j++) {
    const i = indices[j]
    const v = properties[j]?.[column]
    let visible = true
    if (include && include.length) visible = include.includes(v)
    if (exclude && exclude.length) visible = visible && !exclude.includes(v)
    target[i] = visible ? 1 : 0
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
  for (const bucket of Array.from(buckets.values())) {
    const style = bucket.style
    const idxs = bucket.idxs
    const propsArr = bucket.props

    if (!style) continue

    // filter
    if (style.filter && 'column' in style.filter) {
      const col = (style.filter as any).column
      const include: any[] | undefined = (style.filter as any).include
      const exclude: any[] | undefined = (style.filter as any).exclude
      applyFeatureFilter(idxs, propsArr, col, include, exclude, featureFilter)
    }

    // Helper to apply color style to a target typed array
    const applyColorStyle = (
      idxs: number[],
      propsArr: any[],
      styleVal: any,
      target: Uint8ClampedArray,
      stride: number,
      offset: number,
      defaultHex: string
    ) => {
      if (!styleVal) return
      if (typeof styleVal === 'string') {
        const color = stride === 3 ? hexToRgb(styleVal) : hexToRgba(styleVal, 1)
        applyStaticValue(idxs, color as any, target as any, stride, offset)
      } else if ('colors' in styleVal) {
        const encoder = buildCategoryEncoder(styleVal.colors, '#808080')
        applyEncodedValue(
          idxs,
          propsArr,
          styleVal.column,
          encoder as any,
          target as any,
          stride,
          offset
        )
      } else if ('column' in styleVal) {
        const encoder = buildColorEncoder(
          propsArr.map((p: any) => p?.[styleVal.column]),
          styleVal,
          styleVal.dataRange
        )
        applyEncodedValue(
          idxs,
          propsArr,
          styleVal.column,
          encoder as any,
          target as any,
          stride,
          offset
        )
      }
    }

    applyColorStyle(idxs, propsArr, style.fillColor, fillColors, 4, 0, '#808080')
    applyColorStyle(idxs, propsArr, style.lineColor, lineColors, 3, 0, '#808080')

    // lineWidth - handle static, array, category, and column-based
    if (style.lineWidth) {
      const lw = style.lineWidth as any
      if (Array.isArray(lw)) {
        applyNumericArray(idxs, lw, lineWidths, defaultWidth)
      } else if (typeof lw === 'number') {
        applyStaticNumeric(idxs, lw, lineWidths)
      } else if (typeof lw === 'object' && 'widths' in lw && 'column' in lw) {
        applyNumericCategory(idxs, propsArr, lw.column, lw.widths || {}, lineWidths, defaultWidth)
      } else if ('column' in lw) {
        const values = propsArr.map((p: any) => toNumber(p?.[lw.column]))
        applyQuantitativeMapping(
          values,
          lw.dataRange ?? [1, 6],
          lw.widthRange ?? [1, 6],
          lineWidths,
          1,
          0
        )
      }
    }

    // pointRadius - handle both static and column-based
    if (style.pointRadius) {
      const pr = style.pointRadius as any
      if (typeof pr === 'number') {
        applyStaticNumeric(idxs, pr, pointRadii)
      } else if ('column' in pr) {
        const values = propsArr.map((p: any) => toNumber(p?.[pr.column]))
        applyQuantitativeMapping(
          values,
          pr.dataRange ?? [2, 12],
          pr.widthRange ?? [2, 12],
          pointRadii,
          1,
          0
        )
      }
    }

    // fillHeight - handle both static and column-based
    if (style.fillHeight) {
      const fh = style.fillHeight as any
      if (typeof fh === 'number') {
        applyStaticNumeric(idxs, fh, fillHeights)
      } else if ('column' in fh) {
        const values = propsArr.map((p: any) => toNumber(p?.[fh.column]))
        applyQuantitativeMapping(
          values,
          fh.dataRange ?? [0, 100],
          fh.widthRange ?? [0, 100],
          fillHeights,
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
