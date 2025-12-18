import * as cartoColors from 'cartocolor'
import { RGBA, RGB, ColorStyle, NumericStyle, LayerStyle, BuildArgs, BuildResult } from './types'

const hexToRgb = (hex: string): RGB => {
  const match = hex.replace('#', '').match(/.{1,2}/g) || ['80', '80', '80']
  return [parseInt(match[0], 16), parseInt(match[1], 16), parseInt(match[2], 16)]
}

const hexToRgba = (hex: string, alpha: number = 1): RGBA => {
  const match = hex.replace('#', '').match(/.{1,2}/g) || ['80', '80', '80']
  return [
    parseInt(match[0], 16),
    parseInt(match[1], 16),
    parseInt(match[2], 16),
    Math.round(alpha * 255),
  ]
}

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

const toNumber = (value: any): number | null => {
  const num = Number(value)
  return isNaN(num) ? null : num
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
  const [min, max] =
    'range' in style && style.range
      ? style.range
      : [nums.length ? Math.min(...nums) : 0, nums.length ? Math.max(...nums) : 1]

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
  const nums = values.filter((v): v is number => v !== null)
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
        const encoder = buildCategoryEncoder(style.fillColor.colors, '#808080')
        for (let j = 0; j < idxs.length; j++) {
          fillColors.set(encoder(propsArr[j]?.[style.fillColor.column]), idxs[j] * 4)
        }
      } else if ('column' in style.fillColor) {
        // Column-based encoding
        const encoder = buildColorEncoder(
          propsArr.map(p => p?.[style.fillColor!.column]),
          style.fillColor,
          style.fillColor.dataRange
        )
        for (let j = 0; j < idxs.length; j++) {
          fillColors.set(encoder(propsArr[j]?.[style.fillColor.column]), idxs[j] * 4)
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
        const encoder = buildCategoryEncoder(style.lineColor.colors, '#808080')
        for (let j = 0; j < idxs.length; j++) {
          lineColors.set(encoder(propsArr[j]?.[style.lineColor.column]), idxs[j] * 3)
        }
      } else if ('column' in style.lineColor) {
        // Column-based encoding
        const encoder = buildColorEncoder(
          propsArr.map(p => p?.[style.lineColor!.column]),
          style.lineColor,
          style.lineColor.dataRange
        )
        for (let j = 0; j < idxs.length; j++) {
          const [r, g, b] = encoder(propsArr[j]?.[style.lineColor.column])
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
          const v = propsArr[j]?.[style.lineWidth.column]
          lineWidths[idxs[j]] = widthMap[v] ?? defaultWidth
        }
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
        for (let j = 0; j < idxs.length; j++) {
          pointRadii[idxs[j]] = style.pointRadius
        }
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
        for (let j = 0; j < idxs.length; j++) {
          fillHeights[idxs[j]] = style.fillHeight
        }
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
