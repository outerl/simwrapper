/**
 * Type definitions for the AequilibraE plugin
 *
 * This file contains all TypeScript interfaces and types used throughout
 * the AequilibraE visualization plugin. It defines data structures for:
 * - Spatial data configuration
 * - Styling and rendering options
 * - Database joining operations
 * - Memory optimization settings
 *
 * @fileoverview AequilibraE Plugin Type Definitions
 * @author SimWrapper Development Team
 */

/** Supported geometry types for spatial data visualization */
/** Supported geometry types for spatial data visualization */
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
  /** Optional: SQL WHERE clause to filter rows in the joined table (e.g., 'volume > 100') */
  filter?: string
}

export interface LayerConfig {
  table: string
  type: GeometryType
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
  extraDatabases?: Record<string, string>
  view: 'table' | 'map' | ''
  layers: { [key: string]: LayerConfig }
  center?: [number, number] | string
  zoom?: number
  projection?: string
  bearing?: number
  pitch?: number
  geometryLimit?: number
  coordinatePrecision?: number
  minimalProperties?: boolean
  defaults?: {
    fillColor?: string
    lineColor?: string
    lineWidth?: number
    pointRadius?: number
    fillHeight?: number
  }
  legend?: Array<{
    label?: string
    color?: string
    size?: number
    shape?: string
    subtitle?: string
  }>
}

// =============================================================================
// Color and Styling Type Definitions
// =============================================================================

export type RGBA = [number, number, number, number]
export type RGB = [number, number, number]

// Quantitative color style: numeric column mapped to a palette
export type QuantitativeColorStyle = {
  column: string
  type?: 'quantitative'
  palette?: string
  numColors?: number
  // explicit range for color mapping (min, max)
  range?: [number, number]
  // optional data range override when computing encoders
  dataRange?: [number, number]
}

// Categorical color style: mapping of category -> hex color
export type CategoricalColorStyle = {
  column: string
  type?: 'categorical'
  colors: Record<string, string>
}

// ColorStyle may be a simple hex string or one of the structured styles above
export type ColorStyle = string | QuantitativeColorStyle | CategoricalColorStyle

// Numeric style may be a static number, an explicit array per-feature, or a column-driven mapping
export type NumericColumnStyle = {
  column: string
  dataRange?: [number, number]
  widthRange?: [number, number]
  // category -> width mapping
  widths?: Record<string, number>
}

export type NumericStyle = number | number[] | NumericColumnStyle

export type LayerStyle = {
  fillColor?: ColorStyle
  lineColor?: ColorStyle
  // lineWidth can be static, per-feature array, or column/category-driven
  lineWidth?: NumericStyle
  // point radius and fill height share the same flexible numeric shape
  pointRadius?: NumericStyle
  fillHeight?: NumericStyle
  filter?: {
    column: string
    include?: any[]
    exclude?: any[]
  }
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

// =============================================================================
// Runtime / DB related types
// =============================================================================

/** Lightweight representation of a GeoJSON Feature used by the plugin */
export interface GeoFeature {
  type: 'Feature'
  geometry: any
  properties: Record<string, any>
}

/** Basic shape for the SQLite DB wrapper returned by the SPL runtime */
export interface SqliteDb {
  exec: (sql: string) => { get: { objs: any[] } } | any
  close?: () => void
  [k: string]: any
}

/** SPL runtime instance interface (only the parts we use) */
export interface SPL {
  db: (arrayBuffer: ArrayBuffer) => Promise<SqliteDb> | SqliteDb
  [k: string]: any
}

/** Lazy loader for extra databases used by buildGeoFeatures */
export type LazyDbLoader = (dbName: string) => Promise<SqliteDb | null>
