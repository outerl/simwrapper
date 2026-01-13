// Core utilities for AequilibraE plugin: YAML parsing and configuration handling

import YAML from 'yaml'
import type { VizDetails, LayerConfig } from '../sqlite-map/types'
import { resolvePath, resolvePaths } from '../sqlite-map/utils'

// Keep parseYamlConfig here as a convenience; feature builders moved to sqlite-map/feature-builder
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
    center: config.center,
    zoom: config.zoom,
    bearing: config.bearing,
    pitch: config.pitch,
    geometryLimit: config.geometryLimit,
    coordinatePrecision: config.coordinatePrecision,
    minimalProperties: config.minimalProperties,
    defaults: config.defaults,
    legend: config.legend,
  }
}

// Re-export moved builders from sqlite-map
export { buildTables, buildGeoFeatures } from '../sqlite-map/feature-builder'

// Re-export database functions from sqlite-map for convenience
export { openDb, releaseDb, getCachedJoinData } from '../sqlite-map/db'
export {
  initSql,
  releaseSql,
  acquireLoadingSlot,
  mapLoadingComplete,
  getTotalMapsLoading,
} from '../sqlite-map/loader'
