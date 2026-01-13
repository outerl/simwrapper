// Shared utilities: path resolution, column analysis, and caching helpers

import type { LayerConfig, JoinConfig } from './types'

// Helper type for column metadata returned by PRAGMA table_info
export type ColumnInfo = { name: string; type?: string; nullable?: boolean }

// ============================================================================
// Constants
// ============================================================================

/** Standard column name for geometry in spatial databases */
export const GEOMETRY_COLUMN = 'geometry'

/** Essential spatial column names that should always be included */
export const ESSENTIAL_SPATIAL_COLUMNS = new Set([
  'id',
  'name',
  'link_id',
  'node_id',
  'zone_id',
  'a_node',
  'b_node',
])

/** Style properties that may reference data columns */
export const STYLE_PROPERTIES = [
  'fillColor',
  'lineColor',
  'lineWidth',
  'pointRadius',
  'fillHeight',
  'filter',
]

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve a file path, making it absolute if needed
 * Handles both absolute paths (starting with /) and relative paths
 *
 * @param filePath - The file path to resolve
 * @param subfolder - Optional subfolder to prepend for relative paths
 * @returns Resolved absolute path
 */
export function resolvePath(filePath: string, subfolder?: string | null): string {
  if (!filePath) throw new Error('File path is required')

  if (filePath.startsWith('/')) {
    return filePath
  }

  if (subfolder) {
    return `${subfolder}/${filePath}`
  }

  return filePath
}

/**
 * Resolve multiple paths at once
 *
 * @param paths - Record of path names to file paths
 * @param subfolder - Optional subfolder to prepend for relative paths
 * @returns Record with resolved paths
 */
export function resolvePaths(
  paths: Record<string, string>,
  subfolder?: string | null
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [name, path] of Object.entries(paths)) {
    resolved[name] = resolvePath(path, subfolder)
  }
  return resolved
}

// ============================================================================
// Column/Style Analysis
// ============================================================================

/**
 * Extract all columns that are used for styling in a layer configuration.
 * This identifies which columns from the database need to be loaded.
 *
 * @param layerConfig - Layer configuration with styling rules
 * @returns Set of column names used for styling
 */
export function getUsedColumns(layerConfig: Partial<LayerConfig> | any): Set<string> {
  const used = new Set<string>()
  if (!layerConfig?.style) return used

  const style = layerConfig.style

  for (const prop of STYLE_PROPERTIES) {
    const cfg = style[prop]
    if (cfg && typeof cfg === 'object' && 'column' in cfg) {
      used.add(cfg.column)
    }
  }

  return used
}

/**
 * Extract the specific column needed from a join for a layer's styling.
 * This allows optimized loading - only fetching the columns that are actually needed.
 *
 * @param layerConfig - Layer configuration with styling rules
 * @returns Column name needed from join data, or undefined if none
 */
export function getNeededJoinColumn(layerConfig: Partial<LayerConfig> | any): string | undefined {
  const style = (layerConfig as any).style
  if (!style) return undefined

  for (const prop of STYLE_PROPERTIES) {
    const cfg = style[prop]
    if (cfg && typeof cfg === 'object' && 'column' in cfg) {
      return cfg.column
    }
  }

  return undefined
}

/**
 * Check if a column is the geometry column
 *
 * @param columnName - Name of the column to check
 * @returns True if this is a geometry column
 */
export function isGeometryColumn(columnName: string): boolean {
  return columnName.toLowerCase() === GEOMETRY_COLUMN
}

/**
 * Filter columns, excluding the geometry column
 *
 * @param columns - Array of column metadata objects with 'name' property
 * @returns Filtered array without geometry columns
 */
export function filterOutGeometryColumns(columns: Array<ColumnInfo>): Array<ColumnInfo> {
  return columns.filter(c => !isGeometryColumn(c.name))
}

/**
 * Check if any column in the list is a geometry column
 *
 * @param columns - Array of column metadata objects with 'name' property
 * @returns True if at least one geometry column is found
 */
export function hasGeometryColumn(columns: Array<ColumnInfo>): boolean {
  return columns.some(c => isGeometryColumn(c.name))
}

/**
 * Build a set of columns to select from the database.
 * Includes used columns, essential spatial columns, and optionally all columns.
 *
 * @param allColumns - All available columns in the table
 * @param usedColumns - Set of columns needed for styling
 * @param includeAll - If true, include all columns; if false, only include used + essential
 * @returns Set of column names to select
 */
export function buildColumnSelection(
  allColumns: Array<ColumnInfo>,
  usedColumns: Set<string>,
  includeAll: boolean = false
): Set<string> {
  const selection = new Set<string>()

  if (includeAll) {
    // Include all columns except geometry
    for (const col of allColumns) {
      if (!isGeometryColumn(col.name)) {
        selection.add(col.name)
      }
    }
  } else {
    // Include used columns + essential spatial columns
    for (const col of allColumns) {
      const name = col.name
      if (
        !isGeometryColumn(name) &&
        (usedColumns.has(name) || ESSENTIAL_SPATIAL_COLUMNS.has(name.toLowerCase()))
      ) {
        selection.add(name)
      }
    }
  }

  return selection
}

// ============================================================================
// Caching Utilities
// ============================================================================

/**
 * Create a cache key for join operations
 *
 * @param database - Database name
 * @param table - Table name
 * @param column - Column name (optional)
 * @param filter - Filter clause (optional)
 * @returns Cache key string
 */
export function createJoinCacheKey(
  database: string,
  table: string,
  column?: string,
  filter?: string
): string {
  const parts = [database, table, column || '*', filter || '']
  return parts.join('::')
}

/**
 * Create a cache key for geometry data
 *
 * @param dbPath - Database file path
 * @param tableName - Table name
 * @returns Cache key string
 */
export function createGeometryCacheKey(dbPath: string, tableName: string): string {
  return `${dbPath}::${tableName}`
}

/**
 * Simplify coordinates by reducing precision (removes ~30-50% memory for coordinates)
 * Uses iterative approach to avoid stack overflow with large/nested geometries
 * @param coords - Coordinate array to simplify
 * @param precision - Number of decimal places to keep (default 6)
 */
export function simplifyCoordinates(coords: unknown, precision: number = 6): unknown {
  if (!coords || !Array.isArray(coords)) return coords

  const factor = Math.pow(10, precision)

  const simplifyValue = (val: unknown): unknown => {
    if (typeof val === 'number') {
      return Math.round(val * factor) / factor
    }
    if (!Array.isArray(val)) {
      return val
    }
    // Coordinate array of numbers
    if (val.length > 0 && typeof val[0] === 'number') {
      return val.map((n: number) => Math.round(n * factor) / factor)
    }
    // Nested arrays
    return val.map((item: any) => simplifyValue(item))
  }

  return simplifyValue(coords)
}
