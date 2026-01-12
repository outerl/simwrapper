import { markRaw } from 'vue'
import { buildStyleArrays } from './styling'
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
    redrawCounter: vm.redrawCounter + 1,
  })
}

export function releaseMainDbFromVm(vm: any) {
  vm.db = null
  vm.tables = []
}

export async function loadDbWithCache(
  spl: any,
  aeqFileSystem: any,
  getCachedFile: (p: string) => ArrayBuffer | null,
  getCachedFileBuffer: (p: string, b: ArrayBuffer) => ArrayBuffer,
  openDb: (spl: any, b: ArrayBuffer, p?: string) => Promise<SqliteDb>,
  path: string
) {
  let arrayBuffer: ArrayBuffer | null = getCachedFile(path)
  if (!arrayBuffer) {
    const blob = await aeqFileSystem.getFileBlob(path)
    arrayBuffer = await blob.arrayBuffer()
    arrayBuffer = getCachedFileBuffer(path, arrayBuffer)
  }
  // arrayBuffer is now guaranteed
  return await openDb(spl, arrayBuffer as ArrayBuffer, path)
}
