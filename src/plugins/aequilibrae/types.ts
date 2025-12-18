export type GeometryType = 'polygon' | 'line' | 'point'

/**
 * Configuration for joining data from an external database table
 * to a layer's features. This allows visualization of results data
 * (e.g., simulation outputs) on top of network geometry.
 */
export interface JoinConfig {
  /** Key referencing an entry in extraDatabases */
  database: string
  /** Table name in the external database to join from */
  table: string
  /** Column name in the main layer table to join on */
  leftKey: string
  /** Column name in the external table to join on */
  rightKey: string
  /** Join type: 'left' keeps all main records, 'inner' only keeps matches. Default: 'left' */
  type?: 'left' | 'inner'
  /** Optional: specific columns to include from the joined table (default: all) */
  columns?: string[]
}

export interface LayerConfig {
  table: string
  type: GeometryType
  /** Optional join configuration to merge external data into this layer */
  join?: JoinConfig
  fillColor?: string
  strokeColor?: string
  strokeWidth?: number
  radius?: number
  opacity?: number
  zIndex?: number
}

export interface VizDetails {
  title: string
  description: string
  database: string
  /** Additional databases available for joining. Keys are reference names, values are file paths */
  extraDatabases?: Record<string, string>
  view: 'table' | 'map' | ''
  layers: { [key: string]: LayerConfig }
  center?: [number, number]
  zoom?: number
  projection?: string
  bearing?: number
  pitch?: number
}

// Color and styling types
export type RGBA = [number, number, number, number]
export type RGB = [number, number, number]

export type ColorStyle = {
  column: string
  type: 'quantitative' | 'categorical'
  colorScheme?: string
  colorRange?: [string, string]
  min?: number
  max?: number
}

export type NumericStyle = {
  column: string
  dataRange?: [number, number]
  widthRange?: [number, number]
}

export type LayerStyle = {
  fillColor?: ColorStyle
  lineColor?: ColorStyle
  lineWidth?: NumericStyle
  pointRadius?: NumericStyle
  fillHeight?: NumericStyle
  filter?: { column: string; include?: any[]; exclude?: any[] }
}

export type LayerConfigLite = {
  table?: string
  geometry?: string
  style?: LayerStyle
}

export type BuildArgs = {
  features: Array<{ properties: any; geometry: any }>
  layers: Record<string, LayerConfigLite>
  defaults?: {
    fillColor?: string
    lineColor?: string
    lineWidth?: number
    pointRadius?: number
    fillHeight?: number
  }
}

export type BuildResult = {
  fillColors: Uint8ClampedArray
  lineColors: Uint8ClampedArray
  lineWidths: Float32Array
  pointRadii: Float32Array
  fillHeights: Float32Array
  featureFilter: Float32Array
}
