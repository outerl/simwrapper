// Core utilities for AequilibraE plugin: YAML parsing and configuration handling

import YAML from 'yaml'
import type { VizDetails, LayerConfig } from '../sqlite-map/types'
import { resolvePath, resolvePaths, hasGeometryColumn } from '../sqlite-map/utils'
import { getTableNames, getTableSchema, getRowCount, fetchGeoJSONFeatures } from '../sqlite-map/db'
import type { SqliteDb } from '../sqlite-map/types'

/**
 * Parse YAML configuration file for AequilibraE visualization.
 * Resolves relative paths and validates database configuration.
 *
 * @param yamlText - Raw YAML content
 * @param subfolder - Base folder for resolving relative paths
 * @returns Parsed and validated VizDetails
 */
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

/**
 * Build table metadata from database for layers.
 * Identifies tables with geometry columns for visualization.
 *
 * @param db - Database connection
 * @param layerConfigs - Layer configuration mapping
 * @param allNames - Optional list of all table names (if already fetched)
 * @returns Table metadata and whether any tables have geometry
 */
export async function buildTables(
  db: SqliteDb,
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
) {
  // Import here to avoid circular dependency
  const { getCachedJoinData } = await import('../sqlite-map/db')
  const { getNeededJoinColumn, createJoinCacheKey } = await import('../sqlite-map/utils')

  // Shallow clone layerConfigs to avoid expensive deep cloning
  const plain = Object.assign({}, layerConfigs)
  const layersToProcess = Object.keys(plain).length
    ? Object.entries(plain)
    : tables
        .filter(t => hasGeometryColumn(t.columns))
        .map(t => [t.name, { table: t.name, type: 'line' as const }])

  const features: any[] = []

  // Cache for extra databases loaded during this call
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

      if (layerConfig.join && lazyDbLoader) {
        const neededColumn = getNeededJoinColumn(layerConfig)

        try {
          // Load or reuse the extra database via the provided lazy loader
          let extraDb = loadedExtraDbs.get(layerConfig.join.database)
          if (!extraDb) {
            const maybeDb = await lazyDbLoader(layerConfig.join.database)
            if (maybeDb) {
              extraDb = maybeDb
              loadedExtraDbs.set(layerConfig.join.database, maybeDb)
            }
          }

          if (extraDb) {
            joinedData = await getCachedJoinData(extraDb, layerConfig.join, neededColumn)
          } else {
            console.warn(
              `⚠️ Extra database '${layerConfig.join.database}' not found for layer '${layerName}'`
            )
          }
        } catch (e) {
          console.warn(
            `⚠️ Failed to load join data from ${layerConfig.join.database}.${layerConfig.join.table}:`,
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
        layerConfig.join,
        options
      )

      // Use loop instead of spread to avoid "Maximum call stack size exceeded"
      for (let i = 0; i < layerFeatures.length; i++) {
        features.push(layerFeatures[i])
      }

      // Allow GC to run between layers
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } finally {
    loadedExtraDbs.clear()
  }

  return features
}

// Re-export database functions from sqlite-map for convenience
export { openDb, releaseDb } from '../sqlite-map/db'
export { initSql, releaseSql, acquireLoadingSlot, mapLoadingComplete, getTotalMapsLoading } from '../sqlite-map/loader'
