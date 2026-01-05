/**
 * Core utilities and hooks for POLARIS plugin
 * 
 * This module provides the main data loading and processing functions
 * for POLARIS visualizations. It includes memory management,
 * database caching, loading queue management, and GeoJSON feature building.
 * 
 * Key features:
 * - Shared SPL engine to reduce memory usage
 * - Database caching across multiple maps
 * - Loading queue to prevent memory exhaustion
 * - Support for ATTACH to query across supply/demand/result databases
 * 
 * @fileoverview Core POLARIS Data Processing Functions
 * @author SimWrapper Development Team
 */

import SPL from 'spl.js'
import YAML from 'yaml'
import type { VizDetails, LayerConfig, PolarisSimwrapperConfig, PolarisScenarioConfig } from './types'
import { getTableNames, getTableSchema, getRowCount, fetchGeoJSONFeatures } from './db'

function buildUniqueAttachmentName(schemaName: string): string {
  const randomId =
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${schemaName}-${randomId}.db`
}

// ============================================================================
// GLOBAL LOADING MANAGER - Ensures only one map loads at a time
// ============================================================================
class LoadingManager {
  private queue: Promise<void> = Promise.resolve()
  private queueLength = 0
  private totalMapsLoading = 0

  public async acquireSlot(): Promise<() => void> {
    this.queueLength++
    this.totalMapsLoading++
    console.log(`🔒 Queued for loading (position: ${this.queueLength}, total: ${this.totalMapsLoading})`)

    let releaseSlot: () => void

    const myTurn = this.queue.then(() => {
      console.log(`🔓 Acquired loading slot`)
    })

    this.queue = new Promise<void>(resolve => {
      releaseSlot = () => {
        this.queueLength--
        console.log(`✅ Released loading slot (remaining in queue: ${this.queueLength})`)
        resolve()
      }
    })

    return myTurn.then(() => releaseSlot!)
  }

  public complete(): void {
    this.totalMapsLoading = Math.max(0, this.totalMapsLoading - 1)
  }

  public get count(): number {
    return this.totalMapsLoading
  }
}

export const loadingManager = new LoadingManager()

/**
 * Acquire a slot in the loading queue. Only one map can load at a time.
 */
export function acquireLoadingSlot(): Promise<() => void> {
  return loadingManager.acquireSlot()
}

/**
 * Call when a map has fully finished loading
 */
export function mapLoadingComplete(): void {
  loadingManager.complete()
}

/**
 * Get the current total number of maps being loaded.
 */
export function getTotalMapsLoading(): number {
  return loadingManager.count
}

// ============================================================================
// SHARED SPL ENGINE - Critical for memory when loading multiple maps
// ============================================================================
let sharedSpl: any = null
let splInitPromise: Promise<any> | null = null
let splRefCount = 0

/**
 * Get or create the shared SPL engine.
 */
export async function initSql(): Promise<any> {
  splRefCount++

  if (sharedSpl) {
    return sharedSpl
  }

  if (splInitPromise) {
    return splInitPromise
  }

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
 */
export function releaseSql(): void {
  splRefCount = Math.max(0, splRefCount - 1)
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
 */
export async function openDb(spl: any, arrayBuffer: ArrayBuffer, path?: string): Promise<any> {
  if (!path) {
    return spl.db(arrayBuffer)
  }

  const cached = dbCache.get(path)
  if (cached) {
    cached.refCount++
    console.log(`📦 Reusing cached database: ${path} (refs: ${cached.refCount})`)
    return cached.db
  }

  const loadingPromise = dbLoadPromises.get(path)
  if (loadingPromise) {
    const db = await loadingPromise
    const nowCached = dbCache.get(path)
    if (nowCached) {
      nowCached.refCount++
      console.log(`📦 Joined loading database: ${path} (refs: ${nowCached.refCount})`)
    }
    return db
  }

  const loadPromise = (async () => {
    try {
      const db = await spl.db(arrayBuffer)
      dbCache.set(path, { db, refCount: 1, path })
      console.log(`📂 Loaded and cached database: ${path}`)
      return db
    } finally {
      // Always clear, even if SPL fails (prevents a permanently stuck rejected promise)
      dbLoadPromises.delete(path)
    }
  })()

  dbLoadPromises.set(path, loadPromise)
  return loadPromise
}

/**
 * Release a reference to a cached database.
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
 * Attach a secondary database to the main database connection.
 * This allows cross-database queries using the schema name.
 * 
 * @param db - Main database connection
 * @param spl - SPL engine
 * @param arrayBuffer - Secondary database as ArrayBuffer
 * @param schemaName - Name to use for the attached database (e.g., 'demand', 'result')
 */
export async function attachDatabase(
  db: any,
  spl: any,
  arrayBuffer: ArrayBuffer,
  schemaName: string
): Promise<string> {
  const filename = buildUniqueAttachmentName(schemaName)
  try {
    // Write buffer to virtual file system so SQLite can see it
    // SPL.js (based on various Emscripten builds) usually exposes FS or a helper
    if (typeof spl.createFile === 'function') {
      await spl.createFile(filename, new Uint8Array(arrayBuffer))
    } else if (spl.FS) {
      // Standard Emscripten FS
      const data = new Uint8Array(arrayBuffer)
      spl.FS.createDataFile('/', filename, data, true, true, true)
    } else {
      console.warn('SPL engine FS not found, attempting ATTACH without file creation (likely to fail if not memory DB)')
    }

    await db.exec(`ATTACH DATABASE '${filename}' AS ${schemaName}`)
    console.log(`📎 Attached database '${filename}' as '${schemaName}'`)
    return filename
  } catch (e) {
    console.error(`Failed to attach database ${schemaName}:`, e)
    throw e
  }
}

/**
 * Detach a previously attached database and remove its virtual file.
 */
export async function detachDatabase(
  db: any,
  spl: any,
  schemaName: string,
  filename: string
): Promise<void> {
  try {
    await db.exec(`DETACH DATABASE '${schemaName}'`)
  } catch (e) {
    console.warn(`Failed to detach database ${schemaName}:`, e)
  }

  try {
    if (typeof spl?.unlink === 'function') {
      spl.unlink(filename)
    } else if (spl?.FS?.unlink) {
      spl.FS.unlink(`/${filename}`)
    }
  } catch (e) {
    console.warn(`Failed to remove attached database file ${filename}:`, e)
  }
}

/**
 * Parse polaris.yaml configuration file
 */
export async function parsePolarisYaml(
  yamlText: string,
  subfolder: string | null
): Promise<{ simwrapper: PolarisSimwrapperConfig; scenario?: PolarisScenarioConfig }> {
  const config = YAML.parse(yamlText)

  return {
    simwrapper: config.simwrapper || {},
    scenario: config.scenario || config
  }
}

/**
 * Parse scenario_abm.json configuration file to get database paths
 */
export function parseScenarioConfig(jsonText: string): PolarisScenarioConfig {
  const config = JSON.parse(jsonText)
  return {
    description: config.description,
    supply_database: config.supply_database,
    demand_database: config.demand_database,
    result_database: config.result_database,
    analysis_iteration: config.analysis_iteration
  }
}

/**
 * Build VizDetails from POLARIS configuration
 */
export function buildVizDetails(
  simwrapperConfig: PolarisSimwrapperConfig,
  scenarioConfig: PolarisScenarioConfig | undefined,
  subfolder: string | null,
  databases: { supply?: string; demand?: string; result?: string }
): VizDetails {
  // Flatten layer configurations from grouped format to flat format
  const flatLayers: { [key: string]: LayerConfig } = {}

  if (simwrapperConfig.layers) {
    for (const [groupName, groupLayers] of Object.entries(simwrapperConfig.layers)) {
      for (const [tableName, layerConfig] of Object.entries(groupLayers)) {
        const layerName = `${groupName}_${tableName}`
        flatLayers[layerName] = {
          ...layerConfig,
          table: layerConfig.table || tableName
        }
      }
    }
  }

  // Default center: Chicago area (POLARIS is often used for Chicago models)
  const defaultCenter: [number, number] = [-87.63, 41.88]
  const defaultZoom = 10

  return {
    title: scenarioConfig?.description || 'POLARIS Model',
    description: '',
    supplyDatabase: databases.supply,
    demandDatabase: databases.demand,
    resultDatabase: databases.result,
    layers: flatLayers,
    center: simwrapperConfig.center || defaultCenter,
    zoom: simwrapperConfig.zoom ?? defaultZoom,
    bearing: simwrapperConfig.bearing,
    pitch: simwrapperConfig.pitch,
    geometryLimit: simwrapperConfig.geometryLimit,
    coordinatePrecision: simwrapperConfig.coordinatePrecision,
    minimalProperties: simwrapperConfig.minimalProperties,
    defaults: simwrapperConfig.defaults,
    legend: simwrapperConfig.legend,
    analysisIteration: scenarioConfig?.analysis_iteration
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
    : ['Link', 'Node', 'Zone'] // Default POLARIS tables

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
 * Options for memory optimization when building geo features
 */
export interface GeoFeatureOptions {
  /** Maximum number of features per layer (default: 100000) */
  limit?: number
  /** Decimal precision for coordinates (default: 5) */
  coordinatePrecision?: number
  /** Only store properties used for styling (default: true) */
  minimalProperties?: boolean
}

/**
 * Build GeoJSON features from database tables.
 */
export async function buildGeoFeatures(
  db: any,
  tables: any[],
  layerConfigs: { [k: string]: LayerConfig },
  options?: GeoFeatureOptions
) {
  const plain = JSON.parse(JSON.stringify(layerConfigs))
  const layersToProcess = Object.keys(plain).length
    ? Object.entries(plain)
    : tables
      .filter(t => t.columns.some((c: any) => c.name.toLowerCase() === 'geometry'))
      .map(t => [t.name, { table: t.name, type: 'line' as const }])

  const features: any[] = []

  for (const [layerName, cfg] of layersToProcess as any) {
    const layerConfig = cfg as LayerConfig
    const tableName = layerConfig.table || layerName
    const table = tables.find(t => t.name === tableName)
    if (!table) continue
    if (!table.columns.some((c: any) => c.name.toLowerCase() === 'geometry')) continue

    const layerFeatures = await fetchGeoJSONFeatures(
      db,
      table,
      layerName,
      cfg,
      options
    )

    for (let i = 0; i < layerFeatures.length; i++) {
      features.push(layerFeatures[i])
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  return features
}

/**
 * Auto-detect POLARIS database files in a folder
 */
export async function autoDetectDatabases(
  files: string[]
): Promise<{ supply?: string; demand?: string; result?: string }> {
  const result: { supply?: string; demand?: string; result?: string } = {}

  for (const file of files) {
    const lower = file.toLowerCase()
    if (lower.includes('supply') && (lower.endsWith('.sqlite') || lower.endsWith('.db'))) {
      result.supply = file
    } else if (lower.includes('demand') && (lower.endsWith('.sqlite') || lower.endsWith('.db'))) {
      result.demand = file
    } else if (lower.includes('result') && (lower.endsWith('.sqlite') || lower.endsWith('.db'))) {
      result.result = file
    }
  }

  return result
}
