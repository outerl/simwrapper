/**
 * Core utilities and hooks for AequilibraE plugin
 * 
 * This module provides the main data loading and processing functions
 * for AequilibraE visualizations. It includes memory management,
 * database caching, loading queue management, and GeoJSON feature building.
 * 
 * Key features:
 * - Shared SPL engine to reduce memory usage
 * - Database caching across multiple maps
 * - Loading queue to prevent memory exhaustion
 * - Memory optimization for large datasets
 * 
 * @fileoverview Core AequilibraE Data Processing Functions
 * @author SimWrapper Development Team
 */

import SPL from 'spl.js'
import YAML from 'yaml'
import type { VizDetails, LayerConfig, JoinConfig } from './types'
import { getTableNames, getTableSchema, getRowCount, fetchGeoJSONFeatures, queryTable } from './db'

// ============================================================================
// GLOBAL LOADING QUEUE - Ensures only one map loads at a time
// This prevents memory exhaustion when loading many maps simultaneously.
// Each map must acquire the lock before loading, and release it when done.
// ============================================================================
let loadingQueue: Promise<void> = Promise.resolve()
let queueLength = 0
let totalMapsLoading = 0  // Track total maps being loaded (not just waiting)

/**
 * Acquire a slot in the loading queue. Only one map can load at a time.
 * Returns a release function that MUST be called when loading is complete.
 */
export function acquireLoadingSlot(): Promise<() => void> {
  queueLength++
  totalMapsLoading++
  console.log(`🔒 Queued for loading (position: ${queueLength}, total: ${totalMapsLoading})`)
  
  let releaseSlot: () => void
  
  const myTurn = loadingQueue.then(() => {
    console.log(`🔓 Acquired loading slot`)
  })
  
  // Create the next slot in the queue
  loadingQueue = new Promise<void>(resolve => {
    releaseSlot = () => {
      queueLength--
      console.log(`✅ Released loading slot (remaining in queue: ${queueLength})`)
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
let sharedSpl: any = null
let splInitPromise: Promise<any> | null = null
let splRefCount = 0

/**
 * Get or create the shared SPL engine.
 * Uses reference counting to know when it's safe to clean up.
 */
export async function initSql(): Promise<any> {
  splRefCount++
  
  if (sharedSpl) {
    return sharedSpl
  }
  
  // If already initializing, wait for that to complete
  if (splInitPromise) {
    return splInitPromise
  }
  
  // Initialize the shared SPL engine
  splInitPromise = SPL().then((spl: any) => {
    sharedSpl = spl
    splInitPromise = null
    console.log('✅ Shared SPL engine initialized')
    return spl
  })
  
  return splInitPromise
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

// ============================================================================
// DATABASE CACHE - Share database instances across maps using the same file
// ============================================================================
interface CachedDb {
  db: any
  refCount: number
  path: string
}

const dbCache = new Map<string, CachedDb>()
const dbLoadPromises = new Map<string, Promise<any>>()

/**
 * Open a database, using cache if available.
 * Multiple maps using the same database file will share one instance.
 */
export async function openDb(spl: any, arrayBuffer: ArrayBuffer, path?: string): Promise<any> {
  // If no path provided, can't cache - just open directly
  if (!path) {
    return spl.db(arrayBuffer)
  }
  
  // Check cache first
  const cached = dbCache.get(path)
  if (cached) {
    cached.refCount++
    console.log(`📦 Reusing cached database: ${path} (refs: ${cached.refCount})`)
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
      console.log(`📦 Joined loading database: ${path} (refs: ${nowCached.refCount})`)
    }
    return db
  }
  
  // Load and cache
  const loadPromise = (async () => {
    const db = await spl.db(arrayBuffer)
    dbCache.set(path, { db, refCount: 1, path })
    dbLoadPromises.delete(path)
    console.log(`📂 Loaded and cached database: ${path}`)
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
  console.log(`📉 Database refCount decreased: ${path} (refs: ${cached.refCount})`)
  if (cached.refCount <= 0) {
    try {
      if (typeof cached.db.close === 'function') {
        cached.db.close()
      }
    } catch (e) {
      console.warn(`Failed to close database ${path}:`, e)
    }
    dbCache.delete(path)
    console.log(`🗑️ Released cached database: ${path}`)
  }
}

/**
 * Force close all cached databases. Use with caution - only call when
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
  console.log('🧹 Cleared all database caches')
}

export async function parseYamlConfig(
  yamlText: string,
  subfolder: string | null
): Promise<VizDetails> {
  const config = YAML.parse(yamlText)
  const dbFile = config.database || config.file
  if (!dbFile) throw new Error('No database field found in YAML config')
  const databasePath = dbFile.startsWith('/')
    ? dbFile
    : subfolder
    ? `${subfolder}/${dbFile}`
    : dbFile

  // Process extraDatabases paths
  const extraDatabases: Record<string, string> = {}
  if (config.extraDatabases) {
    for (const [name, path] of Object.entries(config.extraDatabases)) {
      const pathStr = path as string
      extraDatabases[name] = pathStr.startsWith('/')
        ? pathStr
        : subfolder
        ? `${subfolder}/${pathStr}`
        : pathStr
    }
  }

  return {
    title: config.title || dbFile,
    description: config.description || '',
    database: databasePath,
    extraDatabases: Object.keys(extraDatabases).length > 0 ? extraDatabases : undefined,
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
    const hasGeomCol = schema.some((c: any) => c.name.toLowerCase() === 'geometry')
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
export async function loadJoinData(
  extraDb: any,
  joinConfig: JoinConfig,
  neededColumn?: string
): Promise<Map<any, Record<string, any>>> {
  const joinLookup = new Map<any, Record<string, any>>()

  // Determine which columns to query - minimize memory usage
  let columnsToQuery: string[]
  
  if (neededColumn) {
    // If we know the specific column needed for styling, only query that + the join key
    columnsToQuery = [joinConfig.rightKey]
    if (neededColumn !== joinConfig.rightKey) {
      columnsToQuery.push(neededColumn)
    }
  } else if (joinConfig.columns && joinConfig.columns.length > 0) {
    // Use the columns specified in config, ensuring rightKey is always included
    const colSet = new Set(joinConfig.columns)
    colSet.add(joinConfig.rightKey)
    columnsToQuery = Array.from(colSet)
  } else {
    // Fallback: query all columns (not recommended for large tables)
    columnsToQuery = undefined as any
  }

  // Query the join table with only needed columns and optional filter
  const joinRows = await queryTable(extraDb, joinConfig.table, columnsToQuery, joinConfig.filter)

  for (const row of joinRows) {
    const key = row[joinConfig.rightKey]
    if (key !== undefined && key !== null) {
      joinLookup.set(key, row)
    }
  }

  return joinLookup
}

/**
 * Extract the column name that a layer needs from joined data for styling.
 * This allows us to only load that specific column from the extra database.
 */
function getNeededJoinColumn(layerConfig: LayerConfig): string | undefined {
  const style = (layerConfig as any).style
  if (!style) return undefined
  
  // Check all style properties that might reference a column from joined data
  const styleProps = ['fillColor', 'lineColor', 'lineWidth', 'pointRadius', 'fillHeight', 'filter']
  for (const prop of styleProps) {
    const cfg = style[prop]
    if (cfg && typeof cfg === 'object' && 'column' in cfg) {
      return cfg.column
    }
  }
  return undefined
}

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
export type LazyDbLoader = (dbName: string) => Promise<any | null>

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
  db: any,
  tables: any[],
  layerConfigs: { [k: string]: LayerConfig },
  lazyDbLoader?: LazyDbLoader,
  options?: GeoFeatureOptions
) {
  const plain = JSON.parse(JSON.stringify(layerConfigs))
  const layersToProcess = Object.keys(plain).length
    ? Object.entries(plain)
    : tables
        .filter(t => t.columns.some((c: any) => c.name.toLowerCase() === 'geometry'))
        .map(t => [t.name, { table: t.name, type: 'line' as const }])

  const features: any[] = []
  
  // Cache for extra databases loaded during this call
  // This prevents loading the same database multiple times if multiple layers use it
  const loadedExtraDbs = new Map<string, any>()
  
  // Track which join queries we've already executed
  // Format: "dbName:tableName:column" -> Map of join data
  const joinDataCache = new Map<string, Map<any, Record<string, any>>>()
  
  try {
    for (const [layerName, cfg] of layersToProcess as any) {
      const layerConfig = cfg as LayerConfig
      const tableName = layerConfig.table || layerName
      const table = tables.find(t => t.name === tableName)
      if (!table) continue
      if (!table.columns.some((c: any) => c.name.toLowerCase() === 'geometry')) continue
      
      // Check if this layer has a join configuration
      let joinedData: Map<any, Record<string, any>> | undefined
      let joinConfig: JoinConfig | undefined

      if (layerConfig.join && lazyDbLoader) {
        joinConfig = layerConfig.join
        const neededColumn = getNeededJoinColumn(layerConfig)
        
        // Create a cache key for this specific join query
        const cacheKey = `${joinConfig.database}:${joinConfig.table}:${neededColumn || '*'}`
        
        // Check if we already have this join data cached
        if (joinDataCache.has(cacheKey)) {
          joinedData = joinDataCache.get(cacheKey)
          console.log(`📦 Reusing cached join data for ${cacheKey}`)
        } else {
          try {
            // Check if we already loaded this database
            let extraDb = loadedExtraDbs.get(joinConfig.database)
            
            if (!extraDb) {
              // Lazily load the extra database
              extraDb = await lazyDbLoader(joinConfig.database)
              if (extraDb) {
                loadedExtraDbs.set(joinConfig.database, extraDb)
              }
            }
            
            if (extraDb) {
              joinedData = await loadJoinData(extraDb, joinConfig, neededColumn)
              const colInfo = neededColumn ? ` (column: ${neededColumn})` : ''
              console.log(
                `✅ Loaded ${joinedData.size} rows from ${joinConfig.database}.${joinConfig.table}${colInfo} for joining`
              )
              
              // Cache the join data for potential reuse by other layers
              joinDataCache.set(cacheKey, joinedData)
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
    // CRITICAL: Clean up all loaded extra databases
    for (const [dbName, extraDb] of loadedExtraDbs) {
      try {
        if (extraDb && typeof extraDb.close === 'function') {
          extraDb.close()
          console.log(`🗑️ Closed extra database: ${dbName}`)
        }
      } catch (e) {
        console.warn(`Failed to close extra database ${dbName}:`, e)
      }
    }
    loadedExtraDbs.clear()
    
    // Clear join data cache
    for (const cache of joinDataCache.values()) {
      cache.clear()
    }
    joinDataCache.clear()
  }
  
  return features
}
