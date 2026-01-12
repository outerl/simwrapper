// Core utilities for AequilibraE plugin: loading, caching and feature building

import SPL from 'spl.js'
import YAML from 'yaml'
import type {
  VizDetails,
  LayerConfig,
  JoinConfig,
  SqliteDb,
  GeoFeature,
  SPL as SPLType,
} from './types'
import {
  getTableNames,
  getTableSchema,
  getRowCount,
  fetchGeoJSONFeatures,
  queryTable,
  getCachedJoinData,
  getCachedFile,
  getCachedFileBuffer,
  openDb,
  releaseDb,
} from './db'

export { getCachedFileBuffer, hasCachedFile, getCachedFile, openDb, releaseDb } from './db'
import {
  resolvePath,
  resolvePaths,
  getUsedColumns,
  getNeededJoinColumn,
  createJoinCacheKey,
  hasGeometryColumn,
} from './utils'

// ============================================================================
// GLOBAL LOADING QUEUE - Ensures only one map loads at a time
// This prevents memory exhaustion when loading many maps simultaneously.
// Each map must acquire the lock before loading, and release it when done.
// ============================================================================
let loadingQueue: Promise<void> = Promise.resolve()
let queueLength = 0
let totalMapsLoading = 0 // Track total maps being loaded (not just waiting)

/**
 * Acquire a slot in the loading queue. Only one map can load at a time.
 * Returns a release function that MUST be called when loading is complete.
 */
export function acquireLoadingSlot(): Promise<() => void> {
  queueLength++
  totalMapsLoading++

  let releaseSlot: () => void

  const myTurn = loadingQueue.then()

  // Create the next slot in the queue
  loadingQueue = new Promise<void>(resolve => {
    releaseSlot = () => {
      queueLength--
      resolve()
    }
  })

  return myTurn.then(() => releaseSlot!)
}

/**
 * Call when a map has fully finished loading (after extractGeometries)
 * to update the total count for memory tuning purposes.
 */
export function mapLoadingComplete(): void {
  totalMapsLoading = Math.max(0, totalMapsLoading - 1)
}

/**
 * Get the current total number of maps being loaded.
 * This can be used to adjust memory limits dynamically.
 */
export function getTotalMapsLoading(): number {
  return totalMapsLoading
}

// ============================================================================
// SHARED SPL ENGINE - Critical for memory when loading multiple maps
// The SPL (SpatiaLite) engine is ~100MB+ in memory. Instead of each map
// creating its own instance, we share a single instance across all maps.
// ============================================================================
let sharedSpl: SPLType | null = null
let splInitPromise: Promise<SPLType> | null = null
let splRefCount = 0

/**
 * Get or create the shared SPL engine.
 * Uses reference counting to know when it's safe to clean up.
 */
export async function initSql(): Promise<SPLType> {
  splRefCount++

  if (sharedSpl) {
    return sharedSpl
  }

  // If already initializing, wait for that to complete
  if (splInitPromise) {
    return splInitPromise
  }

  // Initialize the shared SPL engine
  splInitPromise = SPL().then((spl: SPLType) => {
    sharedSpl = spl
    splInitPromise = null
    return spl
  })

  return splInitPromise!
}

/**
 * Release a reference to the shared SPL engine.
 * Call this when a map component is unmounted.
 */
export function releaseSql(): void {
  splRefCount = Math.max(0, splRefCount - 1)
  // We keep the SPL engine alive even when refCount hits 0
  // because it's expensive to reinitialize. It will be GC'd
  // when the page is unloaded.
}

export async function parseYamlConfig(
  yamlText: string,
  subfolder: string | null
): Promise<VizDetails> {
  const config = YAML.parse(yamlText)
  const dbFile = config.database || config.file
  if (!dbFile) throw new Error('No database field found in YAML config')

  const databasePath = resolvePath(dbFile, subfolder)

  // Process extraDatabases paths
  let extraDatabases: Record<string, string> | undefined
  if (config.extraDatabases) {
    extraDatabases = resolvePaths(config.extraDatabases, subfolder)
  }

  return {
    title: config.title || dbFile,
    description: config.description || '',
    database: databasePath,
    extraDatabases,
    view: config.view || '',
    layers: config.layers || {},
  }
}

export async function buildTables(
  db: any,
  layerConfigs: { [k: string]: LayerConfig },
  allNames?: string[]
) {
  const names = allNames ?? (await getTableNames(db))
  const select = Object.keys(layerConfigs).length
    ? [...new Set(Object.values(layerConfigs).map(c => c.table))]
    : ['nodes', 'links', 'zones']

  const tables: Array<{ name: string; type: string; rowCount: number; columns: any[] }> = []
  let hasGeometry = false

  for (const name of names) {
    if (!select.includes(name)) continue
    const schema = await getTableSchema(db, name)
    const rowCount = await getRowCount(db, name)
    const hasGeomCol = hasGeometryColumn(schema)
    if (hasGeomCol) hasGeometry = true
    tables.push({ name, type: 'table', rowCount, columns: schema })
  }
  return { tables, hasGeometry }
}

/**
 * Load join data from an extra database and return as a lookup map.
 * Memory optimized: only queries the columns that are actually needed.
 * Supports filtering: applies WHERE clause if specified in joinConfig.filter.
 * @param extraDb - The extra database connection
 * @param joinConfig - Join configuration specifying table, keys, columns, and optional filter
 * @param neededColumn - Optional: the specific column needed for styling (further reduces memory)
 */

/**
 * Options for memory optimization when building geo features
 */
export interface GeoFeatureOptions {
  /** Maximum number of features per layer (default: 100000) */
  limit?: number
  /** Decimal precision for coordinates - lower = less memory (default: 5, which is ~1m) */
  coordinatePrecision?: number
  /** Only store properties used for styling (default: true) */
  minimalProperties?: boolean
}

/**
 * Function type for lazy loading extra databases
 * Returns the database connection, or null if not available
 */
export type LazyDbLoader = (dbName: string) => Promise<SqliteDb | null>

/**
 * Build GeoJSON features from database tables, with support for joining external data.
 *
 * Memory optimization: Extra databases are loaded lazily - only when a layer needs them.
 * Each extra DB is loaded once, reused across layers, then closed at the end.
 * Join data is cached to avoid re-querying the same table/column combinations.
 *
 * @param db - Main database connection
 * @param tables - Table metadata
 * @param layerConfigs - Layer configurations including join specs
 * @param lazyDbLoader - Function to lazily load extra databases by name
 * @param options - Memory optimization options
 */
export async function buildGeoFeatures(
  db: SqliteDb,
  tables: Array<{ name: string; type: string; rowCount: number; columns: any[] }>,
  layerConfigs: { [k: string]: LayerConfig },
  lazyDbLoader?: LazyDbLoader,
  options?: GeoFeatureOptions
): Promise<GeoFeature[]> {
  // Shallow clone layerConfigs to avoid expensive deep cloning
  const plain = Object.assign({}, layerConfigs)
  const layersToProcess = Object.keys(plain).length
    ? Object.entries(plain)
    : tables
        .filter(t => hasGeometryColumn(t.columns))
        .map(t => [t.name, { table: t.name, type: 'line' as const }])

  const features: GeoFeature[] = []

  // Cache for extra databases loaded during this call
  // This prevents loading the same database multiple times if multiple layers use it
  const loadedExtraDbs = new Map<string, SqliteDb>()

  try {
    for (const [layerName, cfg] of layersToProcess as any) {
      const layerConfig = cfg as LayerConfig
      const tableName = layerConfig.table || layerName
      const table = tables.find(t => t.name === tableName)
      if (!table) continue
      if (!hasGeometryColumn(table.columns)) continue

      // Check if this layer has a join configuration
      let joinedData: Map<any, Record<string, any>> | undefined
      let joinConfig: JoinConfig | undefined

      if (layerConfig.join && lazyDbLoader) {
        joinConfig = layerConfig.join
        const neededColumn = getNeededJoinColumn(layerConfig)

        // Create a cache key for this specific join query (for logging only)
        const cacheKey = createJoinCacheKey(
          joinConfig.database,
          joinConfig.table,
          neededColumn,
          joinConfig.filter
        )

        try {
          // Load or reuse the extra database via the provided lazy loader
          let extraDb = loadedExtraDbs.get(joinConfig.database)
          if (!extraDb) {
            const maybeDb = await lazyDbLoader(joinConfig.database)
            if (maybeDb) {
              extraDb = maybeDb
              loadedExtraDbs.set(joinConfig.database, maybeDb)
            }
          }

          if (extraDb) {
            // Centralized function will handle its own caching
            joinedData = await getCachedJoinData(extraDb, joinConfig, neededColumn)
            const colInfo = neededColumn ? ` (column: ${neededColumn})` : ''
            // Loaded joined data successfully (verbose log removed)
          } else {
            console.warn(
              `⚠️ Extra database '${joinConfig.database}' not found for layer '${layerName}'`
            )
          }
        } catch (e) {
          console.warn(
            `⚠️ Failed to load join data from ${joinConfig.database}.${joinConfig.table}:`,
            e
          )
        }
      }

      const layerFeatures = await fetchGeoJSONFeatures(
        db,
        table,
        layerName,
        cfg,
        joinedData,
        joinConfig,
        options
      )

      // Use loop instead of spread to avoid "Maximum call stack size exceeded"
      for (let i = 0; i < layerFeatures.length; i++) {
        features.push(layerFeatures[i])
      }

      // Allow GC to run between layers - longer pause to ensure cleanup
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } finally {
    // NOTE: Do NOT close extra databases here - they are managed by the global database cache
    // and may be reused by other panels. The openDb() function handles lifecycle management
    // via refCount. Only the global cache's releaseDb() function should close databases.
    loadedExtraDbs.clear()

    // No local join cache to clear — db.ts manages join caches centrally
  }

  return features
}
