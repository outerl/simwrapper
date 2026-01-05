/**
 * Database utilities for AequilibraE plugin
 * 
 * This module provides helper functions for interacting with SQLite databases
 * containing spatial data and results. It includes functions for schema inspection,
 * data querying, joining operations, and memory-optimized GeoJSON extraction.
 * 
 * @fileoverview Database Utility Functions for AequilibraE
 * @author SimWrapper Development Team
 */

import type { JoinConfig } from './types'

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
 * Perform an in-memory join between main data and external data
 * @param mainData - Array of records from the main table
 * @param joinData - Array of records from the join table
 * @param joinConfig - Configuration specifying join keys and type
 * @returns Merged array with joined columns added to main records
 */
export function performJoin(
  mainData: Record<string, any>[],
  joinData: Record<string, any>[],
  joinConfig: JoinConfig
): Record<string, any>[] {
  const joinLookup = new Map<any, Record<string, any>>();
  for (const row of joinData) {
    const key = row[joinConfig.rightKey];
    if (key !== undefined && key !== null) {
      joinLookup.set(key, row);
    }
  }

  const results: Record<string, any>[] = [];
  for (const mainRow of mainData) {
    const joinKey = mainRow[joinConfig.leftKey];
    const joinRow = joinLookup.get(joinKey);

    if (joinRow) {
      const joinedColumns = joinConfig.columns?.length
        ? Object.fromEntries(
            joinConfig.columns.map((col) => [col, joinRow[col]]).filter(([_, value]) => value !== undefined)
          )
        : { ...joinRow };

      results.push({ ...mainRow, ...joinedColumns });
    } else if (joinConfig.type === 'left') {
      results.push({ ...mainRow });
    }
  }

  return results;
}

// Cache for joinData
const joinDataCache: Map<string, Map<any, Record<string, any>>> = new Map();

/**
 * Get cached joinData or load it if not cached
 */
async function getCachedJoinData(
  db: any,
  joinConfig: JoinConfig
): Promise<Map<any, Record<string, any>>> {
  const cacheKey = `${joinConfig.table}::${joinConfig.rightKey}::${joinConfig.filter || ''}`;

  if (joinDataCache.has(cacheKey)) {
    return joinDataCache.get(cacheKey)!;
  }

  const joinRows = await queryTable(db, joinConfig.table, joinConfig.columns, joinConfig.filter);
  const joinData = new Map(joinRows.map((row) => [row[joinConfig.rightKey], row]));
  joinDataCache.set(cacheKey, joinData);

  return joinData;
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
  
  // Use a stack-based iterative approach to avoid recursion stack overflow
  // We process the structure and build a new simplified version
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
  // Check all style properties that might reference columns
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
 * Fetch GeoJSON features from a table, optionally merging joined data
 * Memory-optimized: only stores essential properties and simplifies coordinates
 * @param db - The main database connection
 * @param table - Table metadata with name and columns
 * @param layerName - Name of the layer for feature properties
 * @param layerConfig - Layer configuration
 * @param joinedData - Optional pre-joined data to merge into features (keyed by join column)
 * @param joinConfig - Optional join configuration specifying the key column
 * @param options - Optional settings for memory optimization
 */
export async function fetchGeoJSONFeatures(
  db: any,
  table: { name: string; columns: any[] },
  layerName: string,
  layerConfig: any,
  joinedData?: Map<any, Record<string, any>>,
  joinConfig?: JoinConfig,
  options?: {
    limit?: number
    coordinatePrecision?: number
    minimalProperties?: boolean
  }
) {
  const limit = options?.limit ?? 1000000  // Default limit
  const coordPrecision = options?.coordinatePrecision ?? 5
  const minimalProps = options?.minimalProperties ?? true

  // Resolve joined data early so we can reuse the cached Map instead of rebuilding arrays per row
  const cachedJoinedData = joinedData ?? (joinConfig ? await getCachedJoinData(db, joinConfig) : undefined)
  
  // Determine which columns we actually need
  const usedColumns = getUsedColumns(layerConfig)
  // Always include the join key if we have a join
  if (joinConfig) {
    usedColumns.add(joinConfig.leftKey)
  }
  
  // Build column list - either all columns or just the ones we need
  let columnNames: string
  if (minimalProps && usedColumns.size > 0) {
    // Only select columns that are used for styling + a few essential ones
    const essentialCols = new Set(['id', 'name', 'link_id', 'node_id', 'zone_id', 'a_node', 'b_node'])
    const colsToSelect = table.columns
      .filter((c: any) => {
        const name = c.name.toLowerCase()
        return name !== 'geometry' && 
               (usedColumns.has(c.name) || essentialCols.has(name))
      })
      .map((c: any) => `"${c.name}"`)
    
    // If no specific columns identified, fall back to all
    columnNames = colsToSelect.length > 0 
      ? colsToSelect.join(', ')
      : table.columns
          .filter((c: any) => c.name.toLowerCase() !== 'geometry')
          .map((c: any) => `"${c.name}"`)
          .join(', ')
  } else {
    columnNames = table.columns
      .filter((c: any) => c.name.toLowerCase() !== 'geometry')
      .map((c: any) => `"${c.name}"`)
      .join(', ')
  }

  // Optionally allow a custom SQL filter from the YAML config for this layer
  // e.g. layerConfig.sqlFilter = "link_type != 'centroid'"
  let filterClause = 'geometry IS NOT NULL'
  if (
    layerConfig &&
    typeof layerConfig.sqlFilter === 'string' &&
    layerConfig.sqlFilter.trim().length > 0
  ) {
    filterClause += ` AND (${layerConfig.sqlFilter})`
  }

  const query = `
    SELECT ${columnNames},
           AsGeoJSON(geometry) as geojson_geom,
           GeometryType(geometry) as geom_type
    FROM "${table.name}"
    WHERE ${filterClause}
    LIMIT ${limit};
  `
  
  // Execute query and get rows
  const queryResult = await db.exec(query)
  let rows = await queryResult.get.objs
  
  // Pre-allocate features array - will trim at end
  const features: any[] = []
  
  const joinType = joinConfig?.type || 'left'
  
  // Get the list of columns we actually selected
  const selectedColumns = minimalProps && usedColumns.size > 0
    ? table.columns.filter((c: any) => {
        const name = c.name.toLowerCase()
        const essentialCols = new Set(['id', 'link_id', 'node_id', 'zone_id', 'a_node', 'b_node'])
        return name !== 'geometry' && 
               (usedColumns.has(c.name) || essentialCols.has(name))
      })
    : table.columns.filter((c: any) => c.name.toLowerCase() !== 'geometry')

  // Process rows in small batches to allow GC to run
  const BATCH_SIZE = 5000
  
  for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, rows.length)
    
    for (let r = batchStart; r < batchEnd; r++) {
      const row = rows[r]
      if (!row.geojson_geom) {
        // Clear the row reference to help GC
        rows[r] = null
        continue
      }

      // Build minimal properties object
      // _layer is REQUIRED for styling to work correctly
      const properties: any = { _layer: layerName }
      for (const col of selectedColumns) {
        const key = col.name
        if (key !== 'geojson_geom' && key !== 'geom_type' && row[key] !== null && row[key] !== undefined) {
          properties[key] = row[key]
        }
      }

      // Merge joined data if available (Map lookup keeps this O(1) per row)
      if (cachedJoinedData && joinConfig) {
        const joinRow = cachedJoinedData.get(row[joinConfig.leftKey])

        if (joinRow) {
          for (const [key, value] of Object.entries(joinRow)) {
            if (!(key in properties)) {
              properties[key] = value
            } else if (key !== joinConfig.rightKey) {
              properties[`${joinConfig.table}_${key}`] = value
            }
          }
        } else if (joinType === 'inner') {
          continue
        }
      }

      // Parse the GeoJSON string into an object
      let geometry: any
      try {
        geometry = typeof row.geojson_geom === 'string' 
          ? JSON.parse(row.geojson_geom) 
          : row.geojson_geom
        
        // Simplify coordinates to reduce memory footprint (skip if precision is max)
        if (geometry.coordinates && coordPrecision < 15) {
          geometry.coordinates = simplifyCoordinates(geometry.coordinates, coordPrecision)
        }
      } catch (e) {
        // Clear row reference and skip
        rows[r] = null
        continue
      }

      features.push({ type: 'Feature', geometry, properties })
      
      // Clear the row reference to allow GC to reclaim memory
      rows[r] = null
    }
    
    // Yield to allow GC between batches
    if (batchEnd < rows.length) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  
  // Clear the rows array reference entirely to help GC
  rows.length = 0
  rows = null as any  // Remove reference so original array can be GC'd
  
  return features
}
