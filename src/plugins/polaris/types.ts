/**
 * Type definitions for the POLARIS plugin
 * 
 * This file contains all TypeScript interfaces and types used throughout
 * the POLARIS visualization plugin. It defines data structures for:
 * - Spatial data configuration from polaris.yaml simwrapper section
 * - Styling and rendering options
 * - Database operations using ATTACH for multiple databases
 * 
 * @fileoverview POLARIS Plugin Type Definitions
 * @author SimWrapper Development Team
 */

/** Supported geometry types for spatial data visualization */
export type GeometryType = 'polygon' | 'line' | 'point'

/**
 * Configuration for a spatial data layer, defining how it should be
 * rendered and what data it should display
 */
export interface LayerConfig {
  /** Database table name containing the spatial data */
  table?: string
  /** Type of geometry (affects rendering style) */
  type?: GeometryType
  /** SQL filter clause (without WHERE keyword) */
  sqlFilter?: string
  /** Fill color for polygons (hex string) */
  fillColor?: string
  /** Stroke/outline color (hex string) */
  strokeColor?: string
  /** Line/stroke width in pixels */
  strokeWidth?: number
  /** Point radius in pixels */
  radius?: number
  /** Layer opacity (0-1) */
  opacity?: number
  /** Z-index for layer stacking */
  zIndex?: number
  /** Layer styling configuration */
  style?: LayerStyle
}

export interface DashboardMetric {
  label: string
  query: string
  db?: string
}

export interface DashboardSection {
  name: string
  metrics: DashboardMetric[]
}

/**
 * SimWrapper section within polaris.yaml
 * Defines visualization settings for POLARIS model output
 * 
 * @example
 * ```yaml
 * simwrapper:
 *   center: [-87.63, 41.88]
 *   zoom: 10
 *   layers:
 *     supply:
 *       Link:
 *         style:
 *           lineColor: { column: type, type: categorical }
 *       Zone:
 *         style:
 *           lineColor: { column: zone, type: integer }
 * ```
 */
export interface PolarisSimwrapperConfig {
  /** Map center coordinates [lon, lat] */
  center?: [number, number]
  /** Initial map zoom level (default: 10) */
  zoom?: number
  /** Map bearing/rotation in degrees */
  bearing?: number
  /** Map pitch/tilt in degrees */
  pitch?: number
  /** Layer group configurations keyed by database type (e.g., 'supply', 'demand', 'result') */
  layers?: {
    [groupName: string]: {
      [tableName: string]: LayerConfig
    }
  }
  /** Default styling values applied to all layers */
  defaults?: {
    fillColor?: string
    lineColor?: string
    lineWidth?: number
    pointRadius?: number
    fillHeight?: number
  }
  /** Manual legend configuration */
  legend?: Array<{
    label?: string
    color?: string
    size?: number
    shape?: string
    subtitle?: string
  }>
  /** Dashboard configuration (cards) */
  dashboard?: {
    sections?: DashboardSection[]
  }
  /** Memory optimization: Max features per layer (default: 100000) */
  geometryLimit?: number
  /** Memory optimization: Coordinate decimal precision (default: 5 = ~1m) */
  coordinatePrecision?: number
  /** Memory optimization: Only store properties used for styling (default: true) */
  minimalProperties?: boolean
}

/**
 * POLARIS scenario configuration from scenario_abm.json
 */
export interface PolarisScenarioConfig {
  /** Scenario description */
  description?: string
  /** Supply database filename */
  supply_database?: string
  /** Demand database filename */
  demand_database?: string
  /** Result database filename */
  result_database?: string
  /** Analysis iteration to use (default: last) */
  analysis_iteration?: number
}

/**
 * Complete visualization configuration for a POLARIS dataset.
 * This interface defines all settings needed to render spatial data
 * with proper styling, legends, and performance optimizations.
 */
export interface VizDetails {
  /** Display title for the visualization */
  title: string
  /** Descriptive text about the dataset */
  description: string
  /** Path to the supply database file */
  supplyDatabase?: string
  /** Path to the demand database file */
  demandDatabase?: string
  /** Path to the result database file */
  resultDatabase?: string
  /** Layer configurations keyed by layer name */
  layers: { [key: string]: LayerConfig }
  /** Map center coordinates [lon, lat] or comma-separated string */
  center?: [number, number] | string
  /** Initial map zoom level */
  zoom?: number
  /** Map bearing/rotation in degrees */
  bearing?: number
  /** Map pitch/tilt in degrees */
  pitch?: number
  /** Memory optimization: Max features per layer (default: 100000) */
  geometryLimit?: number
  /** Memory optimization: Coordinate decimal precision (default: 5 = ~1m) */
  coordinatePrecision?: number
  /** Memory optimization: Only store properties used for styling (default: true) */
  minimalProperties?: boolean
  /** Default styling values applied to all layers */
  defaults?: {
    fillColor?: string
    lineColor?: string
    lineWidth?: number
    pointRadius?: number
    fillHeight?: number
  }
  /** Manual legend configuration */
  legend?: Array<{
    label?: string
    color?: string
    size?: number
    shape?: string
    subtitle?: string
  }>
  /** Dashboard configuration (cards) */
  dashboard?: {
    sections?: DashboardSection[]
  }
  /** Analysis iteration to use */
  analysisIteration?: number
}

// =============================================================================
// Color and Styling Type Definitions
// =============================================================================

/** RGBA color representation with alpha channel [R, G, B, A] where each value is 0-255 */
export type RGBA = [number, number, number, number]

/** RGB color representation [R, G, B] where each value is 0-255 */
export type RGB = [number, number, number]

/**
 * Quantitative (numeric) color mapping.
 *
 * Note: runtime supports both `palette` (preferred) and legacy `colorScheme`.
 * It also supports `range` or legacy `min`/`max`.
 */
export type QuantitativeColorStyle = {
  /** Column name in the data to use for color encoding */
  column: string
  /** Optional discriminator for configs authored in YAML */
  type?: 'quantitative'
  /** Preferred palette name (CartoColor), e.g. 'Viridis', 'YlGn' */
  palette?: string
  /** Legacy synonym for palette */
  colorScheme?: string
  /** Number of colors from the palette (default handled in styling) */
  numColors?: number
  /** Data domain [min, max] for scaling */
  range?: [number, number]
  /** Legacy synonyms for data domain */
  min?: number
  max?: number
  /** Optional clamp range applied before encoding */
  dataRange?: [number, number]
}

/**
 * Categorical (discrete) color mapping.
 * Requires an explicit value->color dictionary.
 */
export type CategoricalColorStyle = {
  column: string
  type?: 'categorical'
  colors: Record<string, string>
}

/** Data-driven color styling configuration */
export type ColorStyle = QuantitativeColorStyle | CategoricalColorStyle

/** Quantitative (numeric) mapping for widths/radii/heights */
export type QuantitativeNumericStyle = {
  column: string
  dataRange?: [number, number]
  widthRange?: [number, number]
}

/** Categorical mapping for numeric widths (e.g. road class -> width) */
export type CategoricalNumericStyle = {
  column: string
  widths: Record<string, number>
}

export type NumericStyle = QuantitativeNumericStyle | CategoricalNumericStyle

/**
 * Complete styling configuration for a layer
 * Defines how features should be visually rendered based on their data
 */
export type LayerStyle = {
  /** Fill color configuration for polygons */
  fillColor?: string | ColorStyle
  /** Line color configuration for lines and polygon outlines */
  lineColor?: string | ColorStyle
  /** Line width configuration */
  lineWidth?: number | number[] | NumericStyle
  /** Point radius configuration */
  pointRadius?: number | QuantitativeNumericStyle
  /** Fill height configuration for 3D visualization */
  fillHeight?: number | QuantitativeNumericStyle
  /** Feature filtering configuration */
  filter?: { 
    column: string
    include?: any[]
    exclude?: any[]
  }
}

/**
 * Lightweight layer configuration for styling operations
 * Used internally by the styling system
 */
export type LayerConfigLite = {
  /** Optional table name */
  table?: string
  /** Optional geometry column name */
  geometry?: string
  /** Layer styling configuration */
  style?: LayerStyle
}

/**
 * Arguments passed to the style building function
 */
export type BuildArgs = {
  /** GeoJSON features to be styled */
  features: Array<{ properties: any; geometry: any }>
  /** Layer configurations keyed by layer name */
  layers: Record<string, LayerConfigLite>
  /** Default styling values */
  defaults?: {
    fillColor?: string
    lineColor?: string
    lineWidth?: number
    pointRadius?: number
    fillHeight?: number
  }
}

/**
 * Result from the style building function
 * Contains typed arrays ready for GPU rendering
 */
export type BuildResult = {
  /** RGBA fill colors for each feature */
  fillColors: Uint8ClampedArray
  /** RGB line colors for each feature */
  lineColors: Uint8ClampedArray
  /** Line widths for each feature */
  lineWidths: Float32Array
  /** Point radii for each feature */
  pointRadii: Float32Array
  /** Fill heights for 3D rendering */
  fillHeights: Float32Array
  /** Visibility filter (1=visible, 0=hidden) */
  featureFilter: Float32Array
}
