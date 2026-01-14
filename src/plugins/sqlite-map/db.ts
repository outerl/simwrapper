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

import proj4 from 'proj4'
import type { JoinConfig, GeoFeature, SqliteDb, SPL } from './types'
import {
  ESSENTIAL_SPATIAL_COLUMNS,
  isGeometryColumn,
  getUsedColumns,
  simplifyCoordinates,
  createJoinCacheKey,
} from './utils'

/**
 * Retrieves all table names from a SQLite database
 *
 * @param db - SQLite database connection object
 * @returns Promise<string[]> Array of table names
 */
export async function getTableNames(db: SqliteDb): Promise<string[]> {
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
  db: SqliteDb,
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
export async function getRowCount(db: SqliteDb, tableName: string): Promise<number> {
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
  db: SqliteDb,
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
  const joinLookup = new Map<any, Record<string, any>>()
  for (const row of joinData) {
    const key = row[joinConfig.rightKey]
    if (key !== undefined && key !== null) {
      joinLookup.set(key, row)
    }
  }

  return mainData
    .map(mainRow => {
      const joinRow = joinLookup.get(mainRow[joinConfig.leftKey])

      if (!joinRow && joinConfig.type !== 'left') {
        return null // Skip non-matching rows in inner join
      }

      if (!joinRow) {
        return mainRow // Left join: keep main row without joined data
      }

      // Extract only the columns specified, or all columns
      const joinedColumns = joinConfig.columns?.length
        ? Object.fromEntries(
            joinConfig.columns
              .map(col => [col, joinRow[col]])
              .filter(([_, value]) => value !== undefined)
          )
        : { ...joinRow }

      return { ...mainRow, ...joinedColumns }
    })
    .filter((row): row is Record<string, any> => row !== null)
}

// Cache for joinData
const joinDataCache: Map<string, Map<any, Record<string, any>>> = new Map()

export function clearJoinCache(key?: string) {
  if (key) {
    joinDataCache.delete(key)
  } else {
    joinDataCache.clear()
  }
}

export function getJoinCacheStats() {
  return {
    keys: Array.from(joinDataCache.keys()),
    size: joinDataCache.size,
  }
}

/**
 * Get cached joinData or load it if not cached
 * Accepts an optional neededColumn to reduce memory by querying fewer columns.
 */
export async function getCachedJoinData(
  db: SqliteDb,
  joinConfig: JoinConfig,
  neededColumn?: string
): Promise<Map<any, Record<string, any>>> {
  const cacheKey = createJoinCacheKey(
    joinConfig.database,
    joinConfig.table,
    neededColumn || undefined,
    joinConfig.filter
  )

  if (joinDataCache.has(cacheKey)) {
    return joinDataCache.get(cacheKey)!
  }

  // Determine which columns to query - minimize memory usage
  let columnsToQuery: string[] | undefined
  if (neededColumn) {
    columnsToQuery = [joinConfig.rightKey]
    if (neededColumn !== joinConfig.rightKey) {
      columnsToQuery.push(neededColumn)
    }
  } else if (joinConfig.columns && joinConfig.columns.length > 0) {
    const colSet = new Set(joinConfig.columns)
    colSet.add(joinConfig.rightKey)
    columnsToQuery = Array.from(colSet)
  } else {
    columnsToQuery = undefined
  }

  const joinRows = await queryTable(db, joinConfig.table, columnsToQuery, joinConfig.filter)
  const joinData = new Map(joinRows.map(row => [row[joinConfig.rightKey], row]))
  joinDataCache.set(cacheKey, joinData)

  return joinData
}

// Helper: build properties object from a database row
function buildPropertiesFromRow(
  selectedColumns: any[],
  row: any,
  layerName: string
): Record<string, any> {
  const properties: Record<string, any> = { _layer: layerName }
  for (const col of selectedColumns) {
    const key = col.name
    if (key !== 'geojson_geom' && key !== 'geom_type' && row[key] != null) {
      properties[key] = row[key]
    }
  }
  return properties
}

// Helper: parse GeoJSON string/object and simplify coordinates if needed
function parseAndSimplifyGeometry(geojson: any, coordPrecision: number): any | null {
  try {
    const geometry = typeof geojson === 'string' ? JSON.parse(geojson) : geojson
    if (geometry && geometry.coordinates && coordPrecision < 15) {
      geometry.coordinates = simplifyCoordinates(geometry.coordinates, coordPrecision)
    }
    return geometry
  } catch (e) {
    return null
  }
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
  db: SqliteDb,
  table: { name: string; columns: any[] },
  layerName: string,
  layerConfig: any,
  // Backwards-compatible parameters: callers for POLARIS pass (db, table, layerName, layerConfig, options, filterConfigs)
  // AequilibraE callers pass (db, table, layerName, layerConfig, joinedData?, joinConfig?, options?)
  joinedDataOrOptions?: Map<any, Record<string, any>> | { limit?: number; coordinatePrecision?: number; minimalProperties?: boolean },
  joinConfigOrFilter?: JoinConfig | any,
  optionsMaybe?: {
    limit?: number
    coordinatePrecision?: number
    minimalProperties?: boolean
  }
): Promise<GeoFeature[]> {
  // Normalize parameters for both calling conventions
  let joinedData: Map<any, Record<string, any>> | undefined
  let joinConfig: JoinConfig | undefined
  let options = optionsMaybe as { limit?: number; coordinatePrecision?: number; minimalProperties?: boolean } | undefined

  // If the 5th arg looks like an options object (has limit or coordinatePrecision), treat it as POLARIS-style call
  if (
    joinedDataOrOptions &&
    typeof joinedDataOrOptions === 'object' &&
    !(joinedDataOrOptions instanceof Map) &&
    (('limit' in (joinedDataOrOptions as any)) || ('coordinatePrecision' in (joinedDataOrOptions as any)) || ('minimalProperties' in (joinedDataOrOptions as any)))
  ) {
    options = joinedDataOrOptions as any
    // joinConfigOrFilter in this mode is polaris' filterConfigs; we ignore it here
    joinedData = undefined
    joinConfig = undefined
  } else {
    joinedData = joinedDataOrOptions as Map<any, Record<string, any>> | undefined
    joinConfig = (joinConfigOrFilter as JoinConfig) ?? undefined
    options = options ?? optionsMaybe
  }

  const limit = options?.limit ?? 1000000 // Default limit
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
    const colsToSelect = table.columns
      .filter((c: any) => {
        const name = c.name.toLowerCase()
        return (
          !isGeometryColumn(name) &&
          (usedColumns.has(c.name) || ESSENTIAL_SPATIAL_COLUMNS.has(name))
        )
      })
      .map((c: any) => `"${c.name}"`)

    // If no specific columns identified, fall back to all
    columnNames =
      colsToSelect.length > 0
        ? colsToSelect.join(', ')
        : table.columns
            .filter((c: any) => !isGeometryColumn(c.name))
            .map((c: any) => `"${c.name}"`)
            .join(', ')
  } else {
    columnNames = table.columns
      .filter((c: any) => !isGeometryColumn(c.name))
      .map((c: any) => `"${c.name}"`)
      .join(', ')
  }

  // Determine geometry column name for this table (support 'geometry', 'geo', or other names detected by isGeometryColumn)
  function findGeometryColumn(cols: any[]): string {
    for (const c of cols) {
      const n = String(c.name).toLowerCase()
      if (isGeometryColumn(n) || n === 'geo' || n === 'geometry') return c.name
    }
    // fallback to 'geometry'
    return 'geometry'
  }

  const geomCol = findGeometryColumn(table.columns)

  // Optionally allow a custom SQL filter from the YAML config for this layer
  // e.g. layerConfig.sqlFilter = "link_type != 'centroid'"
  let filterClause = `${geomCol} IS NOT NULL`
  if (
    layerConfig &&
    typeof layerConfig.sqlFilter === 'string' &&
    layerConfig.sqlFilter.trim().length > 0
  ) {
    const sqlFilter = layerConfig.sqlFilter.trim()
    // Basic safety check: disallow obvious injection patterns and dangerous statements
    const unsafePattern =
      /;|--|\b(ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|ATTACH|DETACH|VACUUM|PRAGMA)\b/i
    if (unsafePattern.test(sqlFilter)) {
      throw new Error('Invalid sqlFilter in layer configuration')
    }
    filterClause += ` AND (${sqlFilter})`
  }

  // Escape table name to prevent breaking out of the quoted identifier
  const safeTableName = String(table.name).replace(/"/g, '""')
  // Ensure LIMIT is a safe positive integer
  const numericLimit = Number(limit)
  const safeLimit =
    Number.isFinite(numericLimit) && numericLimit > 0 ? Math.floor(numericLimit) : 1000

  const safeGeomCol = String(geomCol).replace(/"/g, '""')

  const query = `
    SELECT ${columnNames},
           AsGeoJSON("${safeGeomCol}") as geojson_geom,
           GeometryType("${safeGeomCol}") as geom_type
    FROM "${safeTableName}"
    WHERE ${filterClause}
    LIMIT ${safeLimit};
  `

  // Execute query and get rows
  const queryResult = await db.exec(query)
  let rows = await queryResult.get.objs

  // Pre-allocate features array - will trim at end
  const features: GeoFeature[] = []

  const joinType = joinConfig?.type || 'left'

  // Get the list of columns we actually selected
  const selectedColumns =
    minimalProps && usedColumns.size > 0
      ? table.columns.filter((c: any) => {
          const name = c.name.toLowerCase()
          return (
            !isGeometryColumn(name) &&
            (usedColumns.has(c.name) || ESSENTIAL_SPATIAL_COLUMNS.has(name))
          )
        })
      : table.columns.filter((c: any) => !isGeometryColumn(c.name))

  // Projection lookup for this table (if spatial metadata exists)
  const tableProjection = await getProjectionForTable(db, table.name)

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

      // Build minimal properties object and merge joined data if present
      const properties = buildPropertiesFromRow(selectedColumns, row, layerName)

      if (cachedJoinedData && joinConfig) {
        const joinRow = cachedJoinedData.get(row[joinConfig.leftKey])
        if (joinRow) {
          for (const [key, value] of Object.entries(joinRow)) {
            if (!(key in properties)) properties[key] = value
            else if (key !== joinConfig.rightKey) properties[`${joinConfig.table}_${key}`] = value
          }
        } else if (joinType === 'inner') {
          continue
        }
      }

      // Parse geometry string/object, apply projection if needed, and simplify
      let geometry = parseAndSimplifyGeometry(row.geojson_geom, coordPrecision)
      if (!geometry) {
        rows[r] = null
        continue
      }

      if (geometry.coordinates && tableProjection.transform) {
        geometry.coordinates = transformCoordinates(geometry.coordinates, tableProjection.transform)
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
  rows = null as any // Remove reference so original array can be GC'd

  return features
}

// --- Projection helpers (from polaris/db.ts) --------------------------------
type ProjectionInfo = {
  srid: number | null
  transform: ((xy: [number, number]) => [number, number]) | null
}

const tableProjectionCache = new Map<string, ProjectionInfo>()

async function lookupTableSrid(db: any, tableName: string): Promise<number | null> {
  try {
    const rows = await db.exec(
      `SELECT srid FROM geometry_columns WHERE lower(f_table_name) = lower('${tableName}') LIMIT 1;`
    ).get.objs
    return rows?.[0]?.srid ?? null
  } catch (err) {
    return null
  }
}

async function lookupProjectionDefinition(db: any, srid: number): Promise<string | null> {
  try {
    const rows = await db.exec(
      `SELECT proj4text, srtext FROM spatial_ref_sys WHERE srid = ${srid} LIMIT 1;`
    ).get.objs
    if (!rows || rows.length === 0) return null
    return rows[0].proj4text || rows[0].srtext || null
  } catch (err) {
    return null
  }
}

function transformCoordinates(
  coords: any,
  transform: (xy: [number, number]) => [number, number]
): any {
  if (!coords || !Array.isArray(coords)) return coords
  if (coords.length > 0 && typeof coords[0] === 'number') {
    const [x, y, ...rest] = coords
    const [tx, ty] = transform([x as number, y as number])
    return [tx, ty, ...rest]
  }
  return coords.map((c: any) => transformCoordinates(c, transform))
}

async function getProjectionForTable(db: any, tableName: string): Promise<ProjectionInfo> {
  const cached = tableProjectionCache.get(tableName)
  if (cached) return cached

  const srid = await lookupTableSrid(db, tableName)
  if (!srid || srid === 4326) {
    const info = { srid: srid ?? null, transform: null }
    tableProjectionCache.set(tableName, info)
    return info
  }

  const definition = await lookupProjectionDefinition(db, srid)
  if (!definition) {
    const info = { srid, transform: null }
    tableProjectionCache.set(tableName, info)
    return info
  }

  let transform: ProjectionInfo['transform'] = null
  try {
    const sourceProj = proj4(definition)
    const destProj = proj4.WGS84
    transform = (xy: [number, number]) => proj4(sourceProj, destProj, xy as any) as [number, number]
  } catch (err) {
    transform = null
  }

  const info = { srid, transform }
  tableProjectionCache.set(tableName, info)
  return info
}

interface CachedDb {
  db: any
  refCount: number
  path: string
}

const dbCache = new Map<string, CachedDb>()
const dbLoadPromises = new Map<string, Promise<SqliteDb>>()

/**
 * Open a database, using cache if available.
 * Multiple maps using the same database file will share one instance.
 */
export async function openDb(spl: SPL, arrayBuffer: ArrayBuffer, path?: string): Promise<SqliteDb> {
  // If no path provided, can't cache - just open directly
  if (!path) {
    return spl.db(arrayBuffer)
  }

  // Check cache first
  const cached = dbCache.get(path)
  if (cached) {
    cached.refCount++
    return cached.db
  }

  // Check if already loading - wait for it and increment refCount
  const loadingPromise = dbLoadPromises.get(path)
  if (loadingPromise) {
    const db = await loadingPromise
    // Increment refCount for this caller
    const nowCached = dbCache.get(path)
    if (nowCached) {
      nowCached.refCount++
    }
    return db
  }

  // Load and cache
  const loadPromise = (async () => {
    const db = await spl.db(arrayBuffer)
    dbCache.set(path, { db, refCount: 1, path })
    dbLoadPromises.delete(path)
    return db
  })()

  dbLoadPromises.set(path, loadPromise)
  return loadPromise
}

/**
 * Release a reference to a cached database.
 * The database is closed when refCount reaches 0.
 */
export function releaseDb(path: string): void {
  const cached = dbCache.get(path)
  if (!cached) return

  cached.refCount--
  if (cached.refCount <= 0) {
    try {
      if (typeof cached.db.close === 'function') {
        cached.db.close()
      }
    } catch (e) {
      console.warn(`Failed to close database ${path}:`, e)
    }
    dbCache.delete(path)
  }
}

/**
 * Force close all cached databases and clear file cache. Use with caution - only call when
 * you're sure no maps are using any databases.
 */
export function clearAllDbCaches(): void {
  for (const [path, cached] of dbCache) {
    try {
      if (cached.db && typeof cached.db.close === 'function') {
        cached.db.close()
      }
    } catch (e) {
      console.warn(`Failed to close database ${path}:`, e)
    }
  }
  dbCache.clear()
  dbLoadPromises.clear()

  // also clear the join data cache, if it exists
  if (typeof joinDataCache !== 'undefined') {
    joinDataCache.clear()
  }
}

// Backwards-compatible alias for clearing all caches
export const clearAllCaches = clearAllDbCaches

export function getDbCacheStats() {
  const entries = Array.from(dbCache.entries()).map(([path, v]) => ({ path, refCount: v.refCount }))
  return {
    size: dbCache.size,
    entries,
  }
}
