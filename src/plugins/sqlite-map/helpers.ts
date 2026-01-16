import { markRaw } from 'vue'
import { buildStyleArrays } from './styling/styling'
import type { SqliteDb, VizDetails } from './types'

export function applyStylesToVm(
  vm: any,
  features: any[],
  vizDetails: VizDetails,
  layerConfigs: any
) {
  vm.geoJsonFeatures = markRaw(features)
  const styles = buildStyleArrays({
    features: vm.geoJsonFeatures,
    layers: layerConfigs,
    defaults: vizDetails.defaults,
  })
  Object.assign(vm, {
    fillColors: styles.fillColors,
    lineColors: styles.lineColors,
    lineWidths: styles.lineWidths,
    pointRadii: styles.pointRadii,
    fillHeights: styles.fillHeights,
    featureFilter: styles.featureFilter,
    isRGBA: true,
    redrawCounter: (vm.redrawCounter ?? 0) + 1,
  })
}

/**
 * Release the main database connection and clear related data.
 *
 * @param vm - Vue component instance to update
 */
export function releaseMainDbFromVm(vm: any) {
  vm.db = null
  vm.tables = []
}

/**
 * Load a database from file.
 * Abstracts away the file I/O details.
 *
 * @param spl - SPL engine instance
 * @param fileApi - File system API with getFileBlob method
 * @param openDb - Function to open database from buffer
 * @param path - Path to database file
 * @returns Opened database connection
 */
export async function loadDbWithCache(
  spl: any,
  fileApi: any,
  openDb: (spl: any, b: ArrayBuffer, p?: string) => Promise<SqliteDb>,
  path: string
) {
  const blob = await fileApi.getFileBlob(path)
  const arrayBuffer = await blob.arrayBuffer()
  return await openDb(spl, arrayBuffer, path)
}

/**
 * Create a lazy database loader function for extra databases.
 * Returns a function that can be passed to buildGeoFeatures.
 *
 * @param spl - SPL engine instance
 * @param fileApi - File system API
 * @param openDb - Database open function
 * @param extraDbPaths - Map of database names to file paths
 * @param onLoadingText - Optional callback to update loading message
 * @returns Lazy loader function for use with buildGeoFeatures
 */
export function createLazyDbLoader(
  spl: any,
  fileApi: any,
  openDb: (spl: any, b: ArrayBuffer, p?: string) => Promise<SqliteDb>,
  extraDbPaths: Record<string, string>,
  onLoadingText?: (msg: string) => void
) {
  return async (dbName: string) => {
    const path = extraDbPaths[dbName]
    if (!path) return null

    try {
      if (onLoadingText) {
        onLoadingText(`Loading ${dbName} database...`)
      }

      const blob = await fileApi.getFileBlob(path)
      const arrayBuffer = await blob.arrayBuffer()
      return await openDb(spl, arrayBuffer, path)
    } catch (error) {
      console.warn(`Failed to load extra database '${dbName}':`, error)
      return null
    }
  }
}

/**
 * Calculate memory limits based on number of concurrent maps loading.
 * Used to auto-tune geometry extraction for better memory efficiency.
 *
 * @param totalMaps - Total number of maps currently loading
 * @returns Object with autoLimit (max features) and autoPrecision (coordinate precision)
 */
export function getMemoryLimits(totalMaps: number): { autoLimit: number; autoPrecision: number } {
  let autoLimit = 100000,
    autoPrecision = 5
  if (totalMaps >= 8) {
    autoLimit = 25000
    autoPrecision = 4
  } else if (totalMaps >= 5) {
    autoLimit = 40000
    autoPrecision = 4
  } else if (totalMaps >= 3) {
    autoLimit = 60000
    autoPrecision = 5
  }
  return { autoLimit, autoPrecision }
}
