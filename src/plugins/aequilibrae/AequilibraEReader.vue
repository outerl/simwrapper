<template lang="pug">
.c-aequilibrae-viewer.flex-col(:class="{'is-thumbnail': thumbnail}")
  .loading(v-if="!isLoaded") {{ loadingText }}
  .map-viewer(v-show="isLoaded")
    DeckMapComponent(ref="deckMap" v-if="geoJsonFeatures.length && bgLayers && layerId" :features="geoJsonFeatures" :bgLayers="bgLayers" :cbTooltip="handleTooltip" :cbClickEvent="handleFeatureClick" :dark="globalState.isDarkMode" :featureFilter="featureFilter" :fillColors="fillColors" :fillHeights="fillHeights" :highlightedLinkIndex="-1" :initialView="null" :isRGBA="isRGBA" :isAtlantis="false" :lineColors="lineColors" :lineWidths="lineWidths" :mapIsIndependent="false" :opacity="1" :pointRadii="pointRadii" :redraw="redrawCounter" :screenshot="0" :viewId="layerId" :lineWidthUnits="'meters'" :pointRadiusUnits="'meters'")
    .legend-overlay(v-if="legendItems.length" :style="{background: legendBgColor}")
      LegendColors(:items="legendItems" title="Legend")
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue'
import { i18n } from './i18n'
import globalStore from '@/store'
import { FileSystemConfig } from '@/Globals'
import AequilibraEFileSystem from './AequilibraEFileSystem'
import { initSql, openDb, releaseSql, releaseDb, acquireLoadingSlot, parseYamlConfig, buildTables, buildGeoFeatures, getTotalMapsLoading, mapLoadingComplete, getCachedGeometry, getCachedFileBuffer, hasCachedFile, getCachedFile } from './useAequilibrae'
import { buildStyleArrays } from './styling'
import DeckMapComponent from '@/plugins/shape-file/DeckMapComponent.vue'
import LegendColors from '@/components/LegendColors.vue'
import BackgroundLayers from '@/js/BackgroundLayers'
import type { LayerConfig, VizDetails } from './types'

const MyComponent = defineComponent({
  name: 'AequilibraEReader', i18n,
  components: { DeckMapComponent, LegendColors },
  props: { root: { type: String, required: true }, subfolder: { type: String, required: true }, config: { type: Object as any }, resize: Object as any, thumbnail: Boolean, yamlConfig: String },
  data() {
    const uid = `id-${Math.floor(1e12 * Math.random())}`
    return {
      globalState: globalStore.state, vizDetails: {} as VizDetails, layerConfigs: {} as { [layerName: string]: LayerConfig }, loadingText: '', id: uid, layerId: `aequilibrae-layer-${uid}`, aeqFileSystem: null as any, spl: null as any, db: null as any, dbPath: '' as string, tables: [] as Array<{ name: string; type: string; rowCount: number; columns: any[] }>, isLoaded: false, geoJsonFeatures: [] as any[], hasGeometry: false, bgLayers: null as BackgroundLayers | null, featureFilter: new Float32Array(), fillColors: new Uint8ClampedArray(), fillHeights: new Float32Array(), lineColors: new Uint8ClampedArray(), lineWidths: new Float32Array(), pointRadii: new Float32Array(), redrawCounter: 0, isRGBA: false, legendItems: [] as Array<{ label: string; color: string; value: any }>
    }
  },

  computed: {
    fileSystem(): FileSystemConfig {
      const project = this.$store.state.svnProjects.find((a: FileSystemConfig) => a.slug === this.root)
      if (!project) throw new Error(`Project '${this.root}' not found`)
      return project
    },
    legendBgColor(): string { return this.globalState.isDarkMode ? 'rgba(32,32,32,0.95)' : 'rgba(255,255,255,0.95)' }
  },
  watch: { resize() { this.redrawCounter += 1 } },

  beforeUnmount() { this.cleanupMemory(); mapLoadingComplete() },
  async mounted() {
    let releaseSlot: (() => void) | null = null
    try {
      this.aeqFileSystem = new AequilibraEFileSystem(this.fileSystem, globalStore)
      await this.initBackgroundLayers()
      if (this.thumbnail) { this.$emit('isLoaded'); return }
      this.loadingText = 'Waiting for other maps to load...'
      releaseSlot = await acquireLoadingSlot()
      await this.getVizDetails(); await this.loadDatabase(); await this.extractGeometries()
      if (releaseSlot) { releaseSlot(); releaseSlot = null }
      if (this.hasGeometry) this.setMapCenter()
      this.isLoaded = true; this.buildLegend()
      this.$nextTick(() => { if (this.$refs.deckMap?.mymap) this.$refs.deckMap.mymap.resize() })
    } catch (err) {
      this.loadingText = `Error: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      if (releaseSlot) releaseSlot()
      this.$emit('isLoaded')
    }
  },

  methods: {
    async initBackgroundLayers(): Promise<void> {
      try {
        if (!this.vizDetails) this.vizDetails = {} as VizDetails
        this.bgLayers = new BackgroundLayers({ vizDetails: this.vizDetails, fileApi: this.aeqFileSystem, subfolder: this.subfolder })
        await this.bgLayers.initialLoad()
      } catch (error) { console.warn('Background layers failed to load:', error) }
    },
    resolvePath(filePath: string): string {
      if (!filePath) throw new Error('File path is required')
      return filePath.startsWith('/') ? filePath : `${this.subfolder}/${filePath}`
    },

    async loadDatabase(): Promise<void> {
      try {
        this.loadingText = 'Loading SQL engine...'
        this.spl = await initSql()

        this.loadingText = 'Loading database...'
        this.dbPath = this.vizDetails.database
        
        if (!this.dbPath) {
          throw new Error('No database path specified in configuration')
        }

        // Check cache first to avoid re-downloading from S3
        let arrayBuffer: ArrayBuffer | null = getCachedFile(this.dbPath)
        if (!arrayBuffer) {
          const blob = await this.aeqFileSystem.getFileBlob(this.dbPath)
          arrayBuffer = await blob.arrayBuffer()
          arrayBuffer = getCachedFileBuffer(this.dbPath, arrayBuffer)
        } else {
          console.log(`✅ Using cached file: ${this.dbPath}`)
        }
        
        // Pass path to enable database caching across multiple maps
        this.db = await openDb(this.spl, arrayBuffer, this.dbPath)

        this.loadingText = 'Reading tables...'
        const { tables, hasGeometry } = await buildTables(this.db, this.layerConfigs)
        this.tables = tables
        this.hasGeometry = hasGeometry
      } catch (error) {
        throw new Error(`Failed to load database: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async extractGeometries(): Promise<void> {
      if (!this.hasGeometry) {
        return
      }

      try {
        this.loadingText = 'Extracting geometries...'
        
        // Auto-scale memory limits based on concurrent map loading
        const totalMaps = getTotalMapsLoading()
        const { autoLimit, autoPrecision } = this.getMemoryLimits(totalMaps)
        
        console.log(`🗺️ Loading map (${totalMaps} total maps) - limit: ${autoLimit}, precision: ${autoPrecision}`)
        
        // Memory optimization options - YAML values override auto-scaling
        const memoryOptions = {
          limit: this.vizDetails.geometryLimit ?? autoLimit,
          coordinatePrecision: this.vizDetails.coordinatePrecision ?? autoPrecision,
          minimalProperties: this.vizDetails.minimalProperties !== false,
        }
      
        // Create a lazy loader for extra databases
        const extraDbPaths = this.vizDetails.extraDatabases || {}
        const lazyDbLoader = this.createLazyDbLoader(extraDbPaths)
        
        const features = await buildGeoFeatures(
          this.db,
          this.tables,
          this.layerConfigs,
          lazyDbLoader,
          memoryOptions
        )

        // Release main database after feature extraction
        this.releaseMainDatabase()
        
        // Give GC a chance to run before building styles
        await new Promise(resolve => setTimeout(resolve, 10))

        // Use markRaw to prevent Vue reactivity on large datasets
        this.geoJsonFeatures = markRaw(features)
        
        const styles = buildStyleArrays({
          features: this.geoJsonFeatures,
          layers: this.layerConfigs,
          defaults: this.vizDetails.defaults,
        })

        this.applyStyles(styles)
      } catch (error) {
        throw new Error(`Failed to extract geometries: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    
    getMemoryLimits(totalMaps: number): { autoLimit: number; autoPrecision: number } {
      let autoLimit = 100000, autoPrecision = 5
      if (totalMaps >= 8) { autoLimit = 25000; autoPrecision = 4 }
      else if (totalMaps >= 5) { autoLimit = 40000; autoPrecision = 4 }
      else if (totalMaps >= 3) { autoLimit = 60000; autoPrecision = 5 }
      return { autoLimit, autoPrecision }
    },

    /**
     * Create a lazy database loader for extra databases
     */
    createLazyDbLoader(extraDbPaths: Record<string, string>) {
      return async (dbName: string) => {
        const path = extraDbPaths[dbName]
        if (!path) return null
        
        try {
          this.loadingText = `Loading ${dbName} database...`
          
          // Check cache first to avoid re-downloading from S3
          let arrayBuffer: ArrayBuffer | null = getCachedFile(path)
          if (!arrayBuffer) {
            const blob = await this.aeqFileSystem.getFileBlob(path)
            arrayBuffer = await blob.arrayBuffer()
            arrayBuffer = getCachedFileBuffer(path, arrayBuffer)
          } else {
            console.log(`✅ Using cached file: ${path}`)
          }
          
          // Cache extra databases by passing the path - multiple panels may use the same results database
          return await openDb(this.spl, arrayBuffer, path)
        } catch (error) {
          console.warn(`Failed to load extra database '${dbName}':`, error)
          return null
        }
      }
    },

    applyStyles(styles: ReturnType<typeof buildStyleArrays>): void {
      Object.assign(this, { fillColors: styles.fillColors, lineColors: styles.lineColors, lineWidths: styles.lineWidths, pointRadii: styles.pointRadii, fillHeights: styles.fillHeights, featureFilter: styles.featureFilter, isRGBA: true, redrawCounter: this.redrawCounter + 1 })
    },
    releaseMainDatabase(): void {
      // Don't release database - keep it cached for reuse by other panels
      // since databases are expensive to fetch from S3
      this.db = null; this.tables = []
    },
    cleanupMemory(): void {
      this.releaseMainDatabase(); releaseSql(); this.spl = null
      this.geoJsonFeatures = []; this.tables = []
      this.fillColors = new Uint8ClampedArray(); this.lineColors = new Uint8ClampedArray()
      this.lineWidths = new Float32Array(); this.pointRadii = new Float32Array()
      this.fillHeights = new Float32Array(); this.featureFilter = new Float32Array()
    },

    async getVizDetails(): Promise<void> {
      if (this.config) {
        this.vizDetails = { ...this.config }
        this.vizDetails.database = this.resolvePath(this.config.database || this.config.file)

        if (this.config.extraDatabases) {
          this.vizDetails.extraDatabases = Object.fromEntries(
            Object.entries(this.config.extraDatabases).map(([name, path]) => [
              name,
              this.resolvePath(path as string),
            ])
          )
        }

        this.layerConfigs = this.config.layers || {}
      } else if (this.yamlConfig) {
        const yamlBlob = await this.aeqFileSystem.getFileBlob(this.resolvePath(this.yamlConfig))
        const yamlText = await yamlBlob.text()
        const parsed = await parseYamlConfig(yamlText, this.subfolder || null)
        this.vizDetails = parsed
        this.layerConfigs = parsed.layers || {}
      } else {
        throw new Error('No config or yamlConfig provided')
      }
    },

    buildLegend(): void {
      const legend = this.vizDetails.legend
      
      if (Array.isArray(legend)) {
        this.legendItems = legend.map(entry => {
          if (entry.subtitle) {
            return { type: 'subtitle', label: entry.subtitle }
          }
          
          return {
            type: entry.shape || 'line',
            label: entry.label || '',
            color: this.convertColorForLegend(entry.color),
            size: entry.size,
            value: entry.label || '',
          }
        })
      } else {
        this.legendItems = []
      }
    },

    convertColorForLegend(color?: string): string | undefined {
      return color?.replace('#', '').match(/.{1,2}/g)?.map(x => parseInt(x, 16)).join(',')
    },
    handleFeatureClick(feature: any): void { console.log('Clicked feature:', feature?.properties) },
    handleTooltip(hoverInfo: any): string {
      const props = hoverInfo?.object?.properties
      if (!props) return ''
      const EXCLUDE = new Set(['_table', '_layer', '_layerConfig', 'geometry'])
      const lines = [props._layer && `Layer: ${props._layer}`, props._table && props._table !== props._layer && `Table: ${props._table}`, ...Object.entries(props).filter(([key]) => !EXCLUDE.has(key)).slice(0, 5).map(([key, value]) => value != null && `${key}: ${value}`)].filter(Boolean)
      return lines.join('<br/>')
    },

    setMapCenter(): void {
      let { center, zoom = 9, bearing = 0, pitch = 0 } = this.vizDetails
      if (typeof center === 'string') center = center.split(',').map((c: string) => parseFloat(c.trim())) as [number, number]
      if (Array.isArray(center) && center.length === 2) globalStore.commit('setMapCamera', { longitude: center[0], latitude: center[1], zoom, bearing, pitch })
    }
  },
})

export default MyComponent
</script>

<style scoped lang="scss">
@import '@/styles.scss';
@import './reader.scss';

.c-aequilibrae-viewer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: var(--bgCardFrame);
  display: flex;
  flex-direction: column;
}

.map-viewer {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
}

.legend-overlay {
  position: absolute;
  top: 1rem;
  right: 1rem;
  z-index: 10;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  padding: 0.5rem 1rem;
  min-width: 120px;
  max-width: 240px;
}

.loading {
  padding: 2rem;
  text-align: center;
  font-size: 1.2rem;
  color: var(--textFancy);
}
</style>
