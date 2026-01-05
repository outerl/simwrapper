/**
 * Database utilities for POLARIS plugin
 * 
 * This module provides helper functions for interacting with SQLite databases
 * containing spatial data. It uses ATTACH to enable cross-database queries
 * between supply, demand, and result databases.
 * 
 * @fileoverview Database Utility Functions for POLARIS
 * @author SimWrapper Development Team
 */

import type { LayerConfig } from './types'

/**
 * Retrieves all table names from a SQLite database
 * 
 * @param db - SQLite database connection object
 * @returns Promise<string[]> Array of table names
 */
export async function getTableNames(db: any): Promise<string[]> {
  const result = await db.exec("SELECT name FROM sqlite_master WHERE type='table';").get.objs
  return result.map((row: any) => row.name)
}

/**
 * Gets the schema (column information) for a specific table
 * 
 * @param db - SQLite database connection object
 * @param tableName - Name of the table to inspect
 * @returns Promise with array of column metadata (name, type, nullable)
 */
export async function getTableSchema(
  db: any,
  tableName: string
): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const result = await db.exec(`PRAGMA table_info("${tableName}");`).get.objs
  return result.map((row: any) => ({
    name: row.name,
    type: row.type,
    nullable: row.notnull === 0,
  }))
}

/**
 * Counts the number of rows in a table
 * 
 * @param db - SQLite database connection object
 * @param tableName - Name of the table to count
 * @returns Promise<number> Number of rows in the table
 */
export async function getRowCount(db: any, tableName: string): Promise<number> {
  const result = await db.exec(`SELECT COUNT(*) as count FROM "${tableName}";`).get.objs
  return result.length > 0 ? result[0].count : 0
}

/**
 * Query a table and return all rows as objects
 * 
 * @param db - SQLite database connection object
 * @param tableName - Name of the table to query
 * @param columns - Optional array of column names to select (default: all columns)
 * @param whereClause - Optional WHERE clause to filter results (without the WHERE keyword)
 * @returns Promise<Record<string, any>[]> Array of row objects
 */
export async function queryTable(
  db: any,
  tableName: string,
  columns?: string[],
  whereClause?: string
): Promise<Record<string, any>[]> {
  const columnList = columns ? columns.map(c => `"${c}"`).join(', ') : '*'
  const whereCondition = whereClause ? ` WHERE ${whereClause}` : ''
  const query = `SELECT ${columnList} FROM "${tableName}"${whereCondition};`
  const result = await db.exec(query).get.objs
  return result
}

/**
 * Simplify coordinates by reducing precision (removes ~30-50% memory for coordinates)
 * Uses iterative approach to avoid stack overflow with large/nested geometries
 * @param coords - Coordinate array to simplify
 * @param precision - Number of decimal places to keep (default 6 = ~0.1m precision)
 */
function simplifyCoordinates(coords: any, precision: number = 6): any {
  if (!coords || !Array.isArray(coords)) return coords
  
  const factor = Math.pow(10, precision)
  
  const simplifyValue = (val: any): any => {
    if (typeof val === 'number') {
      return Math.round(val * factor) / factor
    }
    if (!Array.isArray(val)) {
      return val
    }
    // Check if this is a coordinate (array of numbers)
    if (val.length > 0 && typeof val[0] === 'number') {
      return val.map((n: number) => Math.round(n * factor) / factor)
    }
    // Otherwise it's a nested array - process each element
    return val.map((item: any) => simplifyValue(item))
  }
  
  return simplifyValue(coords)
}

/**
 * Identify columns that are actually used for styling in the layer config
 */
function getUsedColumns(layerConfig: any): Set<string> {
  const used = new Set<string>()
  if (!layerConfig?.style) return used
  
  const style = layerConfig.style
  const styleProps = ['fillColor', 'lineColor', 'lineWidth', 'pointRadius', 'fillHeight', 'filter']
  for (const prop of styleProps) {
    const cfg = style[prop]
    if (cfg && typeof cfg === 'object' && 'column' in cfg) {
      used.add(cfg.column)
    }
  }
  return used
}

/**
 * Fetch GeoJSON features from a table
 * Memory-optimized: only stores essential properties and simplifies coordinates
 * @param db - The database connection
 * @param table - Table metadata with name and columns
 * @param layerName - Name of the layer for feature properties
 * @param layerConfig - Layer configuration
 * @param options - Optional settings for memory optimization
 */
export async function fetchGeoJSONFeatures(
  db: any,
  table: { name: string; columns: any[] },
  layerName: string,
  layerConfig: any,
  options?: {
    limit?: number
    coordinatePrecision?: number
    minimalProperties?: boolean
  }
) {
  const limit = options?.limit ?? 100000
  const coordPrecision = options?.coordinatePrecision ?? 5
  const minimalProps = options?.minimalProperties ?? true
  
  const usedColumns = getUsedColumns(layerConfig)
  
  // Build column list - either all columns or just the ones we need
  let columnNames: string
  if (minimalProps && usedColumns.size > 0) {
    const essentialCols = new Set(['id', 'name', 'link', 'node', 'zone', 'type'])
    const colsToSelect = table.columns
      .filter((c: any) => {
        const name = c.name.toLowerCase()
        return name !== 'geo' && 
               (usedColumns.has(c.name) || essentialCols.has(name))
      })
      .map((c: any) => `"${c.name}"`)
    
    columnNames = colsToSelect.length > 0 
      ? colsToSelect.join(', ')
        : table.columns
          .filter((c: any) => c.name.toLowerCase() !== 'geo')
          .map((c: any) => `"${c.name}"`)
          .join(', ')
  } else {
    columnNames = table.columns
        .filter((c: any) => c.name.toLowerCase() !== 'geo')
      .map((c: any) => `"${c.name}"`)
      .join(', ')
  }

      let filterClause = 'geo IS NOT NULL'
  if (
    layerConfig &&
    typeof layerConfig.sqlFilter === 'string' &&
    layerConfig.sqlFilter.trim().length > 0
  ) {
    filterClause += ` AND (${layerConfig.sqlFilter})`
  }

  const query = `
    SELECT ${columnNames},
           AsGeoJSON(geo) as geojson_geom,
           GeometryType(geo) as geom_type
    FROM "${table.name}"
    WHERE ${filterClause}
    LIMIT ${limit};
  `
  
  const queryResult = await db.exec(query)
  let rows = await queryResult.get.objs
  
  const features: any[] = []
  
  const selectedColumns = minimalProps && usedColumns.size > 0
    ? table.columns.filter((c: any) => {
        const name = c.name.toLowerCase()
        const essentialCols = new Set(['id', 'name', 'link', 'node', 'zone', 'type'])
        return name !== 'geo' && 
               (usedColumns.has(c.name) || essentialCols.has(name))
      })
    : table.columns.filter((c: any) => c.name.toLowerCase() !== 'geo')

  const BATCH_SIZE = 5000
  
  for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, rows.length)
    
    for (let r = batchStart; r < batchEnd; r++) {
      const row = rows[r]
      if (!row.geojson_geom) {
        rows[r] = null
        continue
      }

      const properties: any = { _layer: layerName }
      for (const col of selectedColumns) {
        const key = col.name
        if (key !== 'geojson_geom' && key !== 'geom_type' && row[key] !== null && row[key] !== undefined) {
          properties[key] = row[key]
        }
      }

      let geometry: any
      try {
        geometry = typeof row.geojson_geom === 'string' 
          ? JSON.parse(row.geojson_geom) 
          : row.geojson_geom
        
        if (geometry.coordinates && coordPrecision < 15) {
          geometry.coordinates = simplifyCoordinates(geometry.coordinates, coordPrecision)
        }
      } catch (e) {
        rows[r] = null
        continue
      }

      features.push({ type: 'Feature', geometry, properties })
      rows[r] = null
    }
    
    if (batchEnd < rows.length) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  
  rows.length = 0
  rows = null as any
  
  return features
}
