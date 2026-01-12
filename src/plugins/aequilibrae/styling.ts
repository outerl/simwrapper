/**
 * Styling utilities for AequilibraE plugin
 *
 * This module provides functions for building visual styles from data.
 * It handles color encoding, size mapping, filtering, and the creation
 * of typed arrays optimized for WebGL rendering.
 *
 * @fileoverview Data-Driven Styling System for AequilibraE
 * @author SimWrapper Development Team
 */

import * as cartoColors from 'cartocolor'
import { RGBA, RGB, ColorStyle, LayerStyle, BuildArgs, BuildResult } from './types'

// Local helper types
type ColumnProperties = Record<string, any>
type PropertiesArray = ColumnProperties[]

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
  style: ColorStyle,
  dataRange: [number, number] | null = null
) => {
  if (dataRange) {
    // clamp the values to within the data range
    values = values.map(v => {
      const num = toNumber(v)
      if (num === null) return null
      return Math.max(dataRange[0], Math.min(dataRange[1], num))
    })
  }

  const nums = values.map(toNumber).filter((v): v is number => v !== null)
  const [min, max] = 'range' in style && style.range ? style.range : [safeMin(nums), safeMax(nums)]

  const paletteName = 'palette' in style ? style.palette : 'YlGn'
  const numColors = 'numColors' in style ? style.numColors : 7
  const colors = getPaletteColors(paletteName, numColors).map(h => hexToRgba(h, 1))

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
    colorMap.set(String(key), hexToRgb(hex))
  }
  const defaultRgba = hexToRgb(defaultColor)

  return (value: any) => {
    return colorMap.get(String(value)) || defaultRgba
  }
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

/**
 * Apply a static value to all features at given indices
 * Common pattern for setting color, width, height, radius
 */
const applyStaticValue = <T extends number[] | Uint8ClampedArray | Float32Array>(
  indices: number[],
  value: T extends Uint8ClampedArray ? RGBA | RGB : number,
  target: T,
  stride: number = 1,
  offset: number = 0
) => {
  for (let j = 0; j < indices.length; j++) {
    const i = indices[j]
    if (Array.isArray(value)) {
      // For color arrays (RGB/RGBA)
      for (let k = 0; k < value.length; k++) {
        target[i * stride + offset + k] = value[k]
      }
    } else {
      // For numeric values
      target[i * stride + offset] = value as any
    }
  }
}

/**
 * Apply an encoder function to features, mapping values from properties
 */
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
    const i = indices[j]
    const encoded = encoder(properties[j]?.[column])
    if (Array.isArray(encoded)) {
      // For color arrays
      for (let k = 0; k < encoded.length; k++) {
        target[i * stride + offset + k] = encoded[k]
      }
    } else {
      // For numeric values
      target[i * stride + offset] = encoded as any
    }
  }
}

/**
 * Apply a static numeric value to features at given indices
 */
const applyStaticNumeric = (indices: number[], value: number, target: Float32Array) => {
  for (let j = 0; j < indices.length; j++) {
    target[indices[j]] = value
  }
}

/**
 * Apply numeric values from an array to features at given indices
 */
const applyNumericArray = (
  indices: number[],
  values: (number | undefined)[],
  target: Float32Array,
  defaultValue: number
) => {
  for (let j = 0; j < indices.length; j++) {
    target[indices[j]] = values[j] ?? defaultValue
  }
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
  for (let j = 0; j < indices.length; j++) {
    const v = properties[j]?.[column]
    target[indices[j]] = mapping[v] ?? defaultValue
  }
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
  for (const bucket of buckets.values()) {
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

    if (style.fillColor) {
      if (typeof style.fillColor === 'string') {
        // Static hex color
        const color = hexToRgba(style.fillColor, 1)
        applyStaticValue(idxs, color, fillColors, 4, 0)
      } else if ('colors' in style.fillColor) {
        const encoder = buildCategoryEncoder(style.fillColor.colors, '#808080')
        applyEncodedValue(idxs, propsArr, style.fillColor.column, encoder, fillColors, 4, 0)
      } else if ('column' in style.fillColor) {
        // Column-based encoding
        const encoder = buildColorEncoder(
          propsArr.map(p => p?.[style.fillColor!.column]),
          style.fillColor,
          style.fillColor.dataRange
        )
        applyEncodedValue(idxs, propsArr, style.fillColor.column, encoder, fillColors, 4, 0)
      }
    }

    if (style.lineColor) {
      if (typeof style.lineColor === 'string') {
        // Static hex color
        const rgb = hexToRgb(style.lineColor)
        applyStaticValue(idxs, rgb, lineColors, 3, 0)
      } else if ('colors' in style.lineColor) {
        const encoder = buildCategoryEncoder(style.lineColor.colors, '#808080')
        applyEncodedValue(idxs, propsArr, style.lineColor.column, encoder, lineColors, 3, 0)
      } else if ('column' in style.lineColor) {
        // Column-based encoding
        const encoder = buildColorEncoder(
          propsArr.map(p => p?.[style.lineColor!.column]),
          style.lineColor,
          style.lineColor.dataRange
        )
        applyEncodedValue(idxs, propsArr, style.lineColor.column, encoder, lineColors, 3, 0)
      }
    }

    // lineWidth - handle static, array, category, and column-based
    if (style.lineWidth) {
      if (Array.isArray(style.lineWidth)) {
        applyNumericArray(idxs, style.lineWidth, lineWidths, defaultWidth)
      } else if (typeof style.lineWidth === 'number') {
        applyStaticNumeric(idxs, style.lineWidth, lineWidths)
      } else if (
        typeof style.lineWidth === 'object' &&
        'widths' in style.lineWidth &&
        'column' in style.lineWidth
      ) {
        // Category-based mapping: { column, widths }
        applyNumericCategory(
          idxs,
          propsArr,
          style.lineWidth.column,
          style.lineWidth.widths || {},
          lineWidths,
          defaultWidth
        )
      } else if ('column' in style.lineWidth) {
        const values = propsArr.map(p => toNumber(p?.[style.lineWidth!.column]))
        applyQuantitativeMapping(
          values,
          style.lineWidth.dataRange ?? [1, 6],
          style.lineWidth.widthRange ?? [1, 6],
          lineWidths,
          1,
          0
        )
      }
    }

    // pointRadius - handle both static and column-based
    if (style.pointRadius) {
      if (typeof style.pointRadius === 'number') {
        applyStaticNumeric(idxs, style.pointRadius, pointRadii)
      } else if ('column' in style.pointRadius) {
        const values = propsArr.map(p => toNumber(p?.[style.pointRadius!.column]))
        applyQuantitativeMapping(
          values,
          style.pointRadius.dataRange ?? [2, 12],
          style.pointRadius.widthRange ?? [2, 12],
          pointRadii,
          1,
          0
        )
      }
    }

    // fillHeight - handle both static and column-based
    if (style.fillHeight) {
      if (typeof style.fillHeight === 'number') {
        applyStaticNumeric(idxs, style.fillHeight, fillHeights)
      } else if ('column' in style.fillHeight) {
        const values = propsArr.map(p => toNumber(p?.[style.fillHeight!.column]))
        applyQuantitativeMapping(
          values,
          style.fillHeight.dataRange ?? [0, 100],
          style.fillHeight.widthRange ?? [0, 100],
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
