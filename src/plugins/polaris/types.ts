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
  table: string
  /** Type of geometry (affects rendering style) */
  type: GeometryType
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
 * Configuration for data-driven color styling
 * Supports both quantitative (continuous) and categorical (discrete) color mappings
 */
export type ColorStyle = {
  /** Column name in the data to use for color encoding */
  column: string
  /** Type of color mapping to apply */
  type: 'quantitative' | 'categorical'
  /** Color scheme name (e.g., 'Viridis', 'Blues') */
  colorScheme?: string
  /** Custom color range [startColor, endColor] for quantitative mapping */
  colorRange?: [string, string]
  /** Minimum value for color scale (auto-detected if not specified) */
  min?: number
  /** Maximum value for color scale (auto-detected if not specified) */
  max?: number
}

/**
 * Configuration for data-driven numeric styling (widths, radii, heights)
 */
export type NumericStyle = {
  /** Column name in the data to use for numeric encoding */
  column: string
  /** Data value range [min, max] (auto-detected if not specified) */
  dataRange?: [number, number]
  /** Output range for visual property [min, max] */
  widthRange?: [number, number]
}

/**
 * Complete styling configuration for a layer
 * Defines how features should be visually rendered based on their data
 */
export type LayerStyle = {
  /** Fill color configuration for polygons */
  fillColor?: ColorStyle
  /** Line color configuration for lines and polygon outlines */
  lineColor?: ColorStyle
  /** Line width configuration */
  lineWidth?: NumericStyle
  /** Point radius configuration */
  pointRadius?: NumericStyle
  /** Fill height configuration for 3D visualization */
  fillHeight?: NumericStyle
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
