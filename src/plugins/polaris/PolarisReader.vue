<template lang="pug">
.c-polaris-viewer.flex-col(:class="{'is-thumbnail': thumbnail, 'is-dashboard': itemType === 'dashboard', 'is-map-view': itemType === 'map'}")
  .loading(v-if="!isLoaded") {{ loadingText }}
  .dashboard(v-if="isLoaded && showDashboard && dashboardSections.length")
    .dashboard-section(v-for="section in dashboardSections" :key="section.name")
      h4 {{ section.name }}
      .dashboard-cards
        .dashboard-card(v-for="row in section.rows" :key="row.label" :class="{'is-alt': (section.rows.indexOf(row) % 2) === 1}")
          .card-label {{ row.label }}
          .card-value {{ row.value }}
  .map-viewer(v-if="showMap && isLoaded")
    DeckMapComponent(ref="deckMap" v-if="geoJsonFeatures.length && bgLayers && layerId" :features="geoJsonFeatures" :bgLayers="bgLayers" :cbTooltip="handleTooltip" :cbClickEvent="handleFeatureClick" :dark="globalState.isDarkMode" :featureFilter="featureFilter" :fillColors="fillColors" :fillHeights="fillHeights" :highlightedLinkIndex="-1" :initialView="null" :isRGBA="isRGBA" :isAtlantis="false" :lineColors="lineColors" :lineWidths="lineWidths" :mapIsIndependent="false" :opacity="1" :pointRadii="pointRadii" :redraw="redrawCounter" :screenshot="0" :viewId="layerId" :lineWidthUnits="'meters'" :pointRadiusUnits="'meters'")
    .legend-overlay(v-if="legendItems.length" :style="{background: legendBgColor}")
      LegendColors(:items="legendItems" title="Legend")
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue'
import { i18n } from './i18n'
import globalStore from '@/store'
import { FileSystemConfig } from '@/Globals'
import PolarisFileSystem from './PolarisFileSystem'
import { initSql, openDb, releaseSql, releaseDb, acquireLoadingSlot, parsePolarisYaml, buildVizDetails, buildTables, buildGeoFeatures, getTotalMapsLoading, mapLoadingComplete, autoDetectDatabases, attachDatabase, detachDatabase } from './usePolaris'
import { buildStyleArrays, getPaletteColors } from './styling'
import DeckMapComponent from '@/plugins/shape-file/DeckMapComponent.vue'
import LegendColors from '@/components/LegendColors.vue'
import BackgroundLayers from '@/js/BackgroundLayers'
import type { LayerConfig, VizDetails } from './types'

const MyComponent = defineComponent({
  name: 'PolarisReader', i18n,
  components: { DeckMapComponent, LegendColors },
  props: { root: { type: String, required: true }, subfolder: { type: String, required: true }, config: { type: Object as any }, resize: Object as any, thumbnail: Boolean, yamlConfig: String, itemType: { type: String, default: '' } },
  data() {
    const uid = `id-${Math.floor(1e12 * Math.random())}`
    return {
      globalState: globalStore.state, vizDetails: {} as VizDetails, layerConfigs: {} as { [layerName: string]: LayerConfig }, loadingText: '', id: uid, layerId: `polaris-layer-${uid}`, polarisFileSystem: null as any, spl: null as any, db: null as any, dbPath: '' as string, tables: [] as Array<{ name: string; type: string; rowCount: number; columns: any[] }>, isLoaded: false, geoJsonFeatures: [] as any[], hasGeometry: false, bgLayers: null as BackgroundLayers | null, featureFilter: new Float32Array(), fillColors: new Uint8ClampedArray(), fillHeights: new Float32Array(), lineColors: new Uint8ClampedArray(), lineWidths: new Float32Array(), pointRadii: new Float32Array(), redrawCounter: 0, isRGBA: false, legendItems: [] as Array<{ label: string; color: string; value: any }>, hasSignaledLoadComplete: false, hasAcquiredLoadingSlot: false, attachments: [] as Array<{ schema: string; filename: string }>, dashboardSections: [] as Array<{ name: string; rows: Array<{ label: string; value: any }> }>, metricDbs: {} as Record<string, { db: any; path: string }>
    }
  },

  computed: {
    fileSystem(): FileSystemConfig {
      const project = this.$store.state.svnProjects.find((a: FileSystemConfig) => a.slug === this.root)
      if (!project) throw new Error(`Project '${this.root}' not found`)
      return project
    },
    // Show dashboard: when itemType is 'dashboard' OR when standalone (no itemType) and has dashboard config
    showDashboard(): boolean {
      if (this.itemType === 'dashboard') return true
      if (this.itemType === 'map') return false
      // Standalone mode: show dashboard if it exists
      return !!this.vizDetails?.dashboard?.sections?.length
    },
    // Show map: when itemType is 'map' OR when standalone (no itemType) and has geometry
    showMap(): boolean {
      if (this.itemType === 'map') return true
      if (this.itemType === 'dashboard') return false
      // Standalone mode: show map if geometry exists
      return this.hasGeometry
    },
    dashboardTitle(): string {
      return this.config?.title || this.config?.item || this.vizDetails?.dashboard?.title || ''
    },
    legendBgColor(): string { return this.globalState.isDarkMode ? 'rgba(32,32,32,0.95)' : 'rgba(255,255,255,0.95)' }
  },
  watch: { resize() { this.redrawCounter += 1 } },

  beforeUnmount() { this.cleanupMemory(); this.signalLoadComplete() },
  async mounted() {
    let releaseSlot: (() => void) | null = null
    try {
      this.polarisFileSystem = new PolarisFileSystem(this.fileSystem, globalStore)
      if (this.thumbnail) { this.$emit('isLoaded'); return }
      this.loadingText = 'Waiting for other maps to load...'
      releaseSlot = await acquireLoadingSlot()
      this.hasAcquiredLoadingSlot = true
      await this.getVizDetails()
      await this.initBackgroundLayers()
      await this.loadDatabase()
      await this.extractGeometries()
      if (releaseSlot) { releaseSlot(); releaseSlot = null }
      if (this.hasGeometry) this.setMapCenter()
      this.isLoaded = true; this.buildLegend()
      this.$nextTick(() => { if (this.$refs.deckMap?.mymap) this.$refs.deckMap.mymap.resize() })
    } catch (err) {
      this.loadingText = `Error: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      if (releaseSlot) releaseSlot()
      this.signalLoadComplete()
      this.$emit('isLoaded')
    }
  },

  methods: {
    signalLoadComplete(): void {
      if (!this.hasAcquiredLoadingSlot || this.hasSignaledLoadComplete) return
      mapLoadingComplete()
      this.hasSignaledLoadComplete = true
    },
    async initBackgroundLayers(): Promise<void> {
      try {
        if (!this.vizDetails) this.vizDetails = {} as VizDetails
        this.bgLayers = new BackgroundLayers({ vizDetails: this.vizDetails, fileApi: this.polarisFileSystem, subfolder: this.subfolder })
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

        this.loadingText = 'Loading supply database...'
        this.dbPath = this.vizDetails.supplyDatabase || ''
        
        if (!this.dbPath) {
          throw new Error('No supply database path found')
        }

        const blob = await this.polarisFileSystem.loadPolarisDatabase(this.dbPath)
        if (!blob) throw new Error(`Failed to load supply database: ${this.dbPath}`)
        
        const mainDb = await openDb(this.spl, blob, this.dbPath)
        this.db = markRaw(mainDb)

        // Attach optional databases
        if (this.vizDetails.demandDatabase) {
          this.loadingText = 'Attaching demand database...'
          const demandBlob = await this.polarisFileSystem.loadPolarisDatabase(this.vizDetails.demandDatabase)
          if (demandBlob) {
            const filename = await attachDatabase(this.db, this.spl, demandBlob, 'demand')
            this.attachments.push({ schema: 'demand', filename })
          }
        }

        if (this.vizDetails.resultDatabase) {
          this.loadingText = 'Attaching result database...'
          const resultBlob = await this.polarisFileSystem.loadPolarisDatabase(this.vizDetails.resultDatabase)
          if (resultBlob) {
            const filename = await attachDatabase(this.db, this.spl, resultBlob, 'result')
            this.attachments.push({ schema: 'result', filename })
          }
        }

        this.loadingText = 'Reading tables...'
        const { tables, hasGeometry } = await buildTables(this.db, this.layerConfigs)
        this.tables = tables
        this.hasGeometry = hasGeometry
      } catch (error) {
        // Ensure detailed error is shown
        const msg = error instanceof Error ? error.message : String(error)
        this.loadingText = `Error loading database: ${msg}`
        console.error(error)
        throw error // Propagate to mounted handler
      }
    },

    async extractGeometries(): Promise<void> {
      try {
        this.loadingText = 'Extracting geometries...'

        // For dashboard type, just load metrics and skip geometry
        if (this.itemType === 'dashboard') {
          await this.loadDashboardMetrics()
          await this.releaseMainDatabase()
          return
        }

        if (!this.hasGeometry) {
          await this.loadDashboardMetrics()
          await this.releaseMainDatabase()
          return
        }
        
        const totalMaps = getTotalMapsLoading()
        const { autoLimit, autoPrecision } = this.getMemoryLimits(totalMaps)
        
        console.log(`🗺️ Loading map (${totalMaps} total maps) - limit: ${autoLimit}, precision: ${autoPrecision}`)
        
        const memoryOptions = {
          limit: this.vizDetails.geometryLimit ?? autoLimit,
          coordinatePrecision: this.vizDetails.coordinatePrecision ?? autoPrecision,
          minimalProperties: this.vizDetails.minimalProperties === true,
        }
      
        const features = await buildGeoFeatures(
          this.db,
          this.tables,
          this.layerConfigs,
          memoryOptions
        )

        if (!this.vizDetails.center) {
          const autoCenter = this.computeMapCenter(features)
          if (autoCenter) this.vizDetails.center = autoCenter
        }

        await this.loadDashboardMetrics()

        await this.releaseMainDatabase()
        
        await new Promise(resolve => setTimeout(resolve, 10))

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

    applyStyles(styles: ReturnType<typeof buildStyleArrays>): void {
      Object.assign(this, { fillColors: styles.fillColors, lineColors: styles.lineColors, lineWidths: styles.lineWidths, pointRadii: styles.pointRadii, fillHeights: styles.fillHeights, featureFilter: styles.featureFilter, isRGBA: true, redrawCounter: this.redrawCounter + 1 })
    },
    computeMapCenter(features: any[]): [number, number] | null {
      // Use all features to compute bounding box center
      if (!features.length) return null

      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity

      const update = (coords: any): void => {
        if (!Array.isArray(coords)) return
        if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
          const [lon, lat] = coords as [number, number]
          if (Number.isFinite(lon) && Number.isFinite(lat)) {
            if (lon < minLon) minLon = lon
            if (lon > maxLon) maxLon = lon
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
          }
          return
        }
        for (const c of coords) update(c)
      }

      for (const f of features) {
        update(f?.geometry?.coordinates)
      }

      if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
        return null
      }

      return [ (minLon + maxLon) / 2, (minLat + maxLat) / 2 ]
    },
    async releaseMainDatabase(): Promise<void> {
      await this.detachAttachedDatabases()
      await this.releaseMetricDbs()
      if (this.dbPath) { releaseDb(this.dbPath); this.dbPath = '' }
      this.db = null; this.tables = []
    },
    async cleanupMemory(): Promise<void> {
      await this.releaseMainDatabase(); releaseSql(); this.spl = null
      this.geoJsonFeatures = []; this.tables = []
      this.fillColors = new Uint8ClampedArray(); this.lineColors = new Uint8ClampedArray()
      this.lineWidths = new Float32Array(); this.pointRadii = new Float32Array()
      this.fillHeights = new Float32Array(); this.featureFilter = new Float32Array()
    },
    async detachAttachedDatabases(): Promise<void> {
      if (!this.db || !this.spl || !this.attachments.length) return
      const currentDb = this.db
      const currentSpl = this.spl
      const attachments = [...this.attachments]
      this.attachments = []
      for (const { schema, filename } of attachments) {
        try {
          await detachDatabase(currentDb, currentSpl, schema, filename)
        } catch (e) {
          console.warn(`Failed to detach ${schema} (${filename}):`, e)
        }
      }
    },

    async releaseMetricDbs(): Promise<void> {
      const entries = Object.values(this.metricDbs)
      this.metricDbs = {}
      for (const entry of entries) {
        try {
          releaseDb(entry.path)
        } catch (e) {
          console.warn(`Failed to release metric DB ${entry.path}:`, e)
        }
      }
    },

    async getVizDetails(): Promise<void> {
      if (this.config) {
        // Direct config from item in YAML array
        this.vizDetails = { ...this.config } as VizDetails
        
        // For dashboard type, extract dashboard config from sections
        if (this.itemType === 'dashboard' && this.config.sections) {
          this.vizDetails.dashboard = {
            title: this.config.title || this.config.item,
            sections: this.config.sections
          }
        }
        
        // For map type, extract layer configs
        if (this.itemType === 'map' && this.config.layers) {
          this.layerConfigs = {}
          for (const [layerName, layerDef] of Object.entries(this.config.layers)) {
            const def = layerDef as any
            const styleObj = def.style || def
            // Map shorthand YAML keys to standard layer config keys
            this.layerConfigs[layerName] = {
              table: styleObj.table || layerName,
              type: styleObj.type || 'line',
              style: {
                lineColor: styleObj.color || styleObj.lineColor,
                lineWidth: styleObj.width ?? styleObj.lineWidth,
                fillColor: styleObj.fill || styleObj.fillColor,
                pointRadius: styleObj.radius ?? styleObj.pointRadius,
              }
            }
          }
        }
        
        // Auto-detect databases if not specified
        const { files } = await this.polarisFileSystem.getDirectory(this.subfolder)
        const detected = await autoDetectDatabases(files)
        if (!this.vizDetails.supplyDatabase && detected.supply) {
          this.vizDetails.supplyDatabase = this.resolvePath(detected.supply)
        }
        if (!this.vizDetails.demandDatabase && detected.demand) {
          this.vizDetails.demandDatabase = this.resolvePath(detected.demand)
        }
        if (!this.vizDetails.resultDatabase && detected.result) {
          this.vizDetails.resultDatabase = this.resolvePath(detected.result)
        }
      } else {
        // Auto-detect from polaris.yaml in the folder
        await this.loadPolarisConfig()
      }
    },

    async loadPolarisConfig(): Promise<void> {
      // Look for polaris.yaml (or polaris.yml) in the subfolder
      const polarisYamlPath = `${this.subfolder}/polaris.yaml`
      const polarisYmlPath = `${this.subfolder}/polaris.yml`
      
      try {
        const yamlBlob =
          (await this.polarisFileSystem.getFileBlob(polarisYamlPath)) ||
          (await this.polarisFileSystem.getFileBlob(polarisYmlPath))

        if (!yamlBlob) {
          throw new Error(`No polaris.yaml/polaris.yml found in ${this.subfolder}`)
        }

        const yamlText = await yamlBlob.text()
        const { webpolaris, scenario } = await parsePolarisYaml(yamlText, this.subfolder)
        
        // Get database files from scenario or auto-detect
        let databases: { supply?: string; demand?: string; result?: string } = {}
        
        if (scenario?.supply_database) {
          databases.supply = this.resolvePath(scenario.supply_database)
        }
        if (scenario?.demand_database) {
          databases.demand = this.resolvePath(scenario.demand_database)
        }
        if (scenario?.result_database) {
          databases.result = this.resolvePath(scenario.result_database)
        }
        
        // Auto-detect if not specified in scenario
        if (!databases.supply) {
          const { files } = await this.polarisFileSystem.getDirectory(this.subfolder)
          const detected = await autoDetectDatabases(files)
          if (detected.supply) databases.supply = this.resolvePath(detected.supply)
          if (detected.demand && !databases.demand) databases.demand = this.resolvePath(detected.demand)
          if (detected.result && !databases.result) databases.result = this.resolvePath(detected.result)
        }
        
        // Handle webpolaris as array (new format) or object (legacy format)
        if (Array.isArray(webpolaris)) {
          // New array format: merge all items into vizDetails
          this.vizDetails = {
            title: 'POLARIS Model',
            description: '',
            supplyDatabase: databases.supply,
            demandDatabase: databases.demand,
            resultDatabase: databases.result,
            layers: {},
          } as any
          
          // Process each item in the array
          for (const item of webpolaris) {
            if (item.type === 'dashboard' && item.sections) {
              this.vizDetails.dashboard = {
                title: item.item || item.title,
                sections: item.sections
              }
            }
            if (item.type === 'map' && item.layers) {
              for (const [layerName, layerDef] of Object.entries(item.layers)) {
                const def = layerDef as any
                const styleObj = def.style || def
                
                // Preserve full nested objects for color/width configurations
                const lineColor = styleObj.color || styleObj.lineColor
                const lineWidth = styleObj.width ?? styleObj.lineWidth
                const fillColor = styleObj.fill || styleObj.fillColor
                const pointRadius = styleObj.radius ?? styleObj.pointRadius
                
                // Map shorthand YAML keys to standard layer config keys
                this.layerConfigs[layerName] = {
                  table: styleObj.table || layerName,
                  type: styleObj.type,
                  style: {
                    // Preserve objects as-is (for quantitative/categorical configs)
                    lineColor: lineColor,
                    lineWidth: lineWidth,
                    fillColor: fillColor,
                    pointRadius: pointRadius,
                  }
                }
                
                console.log(`[PolarisReader] Layer "${layerName}" config:`, JSON.stringify(this.layerConfigs[layerName], null, 2))
              }
              this.vizDetails.layers = this.layerConfigs
            }
          }
        } else {
          // Legacy object format
          this.vizDetails = buildVizDetails(webpolaris || {}, scenario, this.subfolder, databases)
          this.layerConfigs = this.vizDetails.layers || {}
        }
      } catch (error) {
        throw new Error(`Failed to load polaris.yaml: ${error instanceof Error ? error.message : String(error)}`)
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
        this.legendItems = this.generateAutoLegend()
      }
    },

    generateAutoLegend(): Array<any> {
      const items: any[] = []
      
      for (const [layerName, config] of Object.entries(this.layerConfigs)) {
        const style = config.style
        if (!style) continue

        // Determine shape based on style properties
        let shape = config.type
        if (!shape) {
           if (style.pointRadius) shape = 'circle'
           else if (style.fillColor) shape = 'polygon'
           else if (style.lineColor) shape = 'line'
           else shape = 'polygon'
        }
        
        // Add header if multiple layers
        if (Object.keys(this.layerConfigs).length > 1) {
             items.push({ type: 'subtitle', label: layerName })
        }

        // Logic for Colors - use fillColor for polygons/points, lineColor for lines
        const colorStyle = (shape === 'line') ? style.lineColor : (style.fillColor || style.lineColor)
        
        if (colorStyle) {
          if (typeof colorStyle === 'string') {
             // Static
             items.push({ 
               type: shape, 
               label: layerName, 
               color: this.convertColorForLegend(colorStyle),
               size: this.getDefaultSize(style, shape)
             })
          } else if ('colors' in colorStyle) {
             // Categorical
             if (Object.keys(this.layerConfigs).length <= 1) {
                 items.push({ type: 'subtitle', label: (colorStyle as any).column })
             }
             
             for (const [val, hex] of Object.entries((colorStyle as any).colors)) {
               items.push({
                 type: shape,
                 label: String(val),
                 color: this.convertColorForLegend(hex as string),
                 size: this.getDefaultSize(style, shape)
               })
             }
          } else if ('palette' in colorStyle || 'column' in colorStyle) {
             // Quantitative
             const cs = colorStyle as any
             const palette = cs.palette || 'YlGn'
             const range = cs.dataRange || cs.range || [0, 100]
             
             if (Object.keys(this.layerConfigs).length <= 1) {
                 items.push({ type: 'subtitle', label: cs.column })
             }
             
             const steps = 5
             const colors = getPaletteColors(palette, steps)
             // Safety check for empty colors
             if (!colors || colors.length === 0) continue

             const stepSize = (range[1] - range[0]) / (steps - 1)
             
             for (let i = 0; i < steps; i++) {
               const val = range[0] + (stepSize * i)
               const label = val >= 1000 ? (val/1000).toFixed(1) + 'k' : (val % 1 === 0 ? val.toFixed(0) : val.toFixed(1))
               
               items.push({
                 type: shape,
                 label: label,
                 color: this.convertColorForLegend(colors[i]),
                 size: this.getDefaultSize(style, shape)
               })
             }
          }
        }
        
        // Logic for Widths (Categorical) - only for line shapes
        if (shape === 'line' && style.lineWidth && typeof style.lineWidth === 'object' && 'widths' in style.lineWidth) {
             items.push({ type: 'subtitle', label: (style.lineWidth as any).column || 'Width' })
             const widths = (style.lineWidth as any).widths
             const widthValues = Object.values(widths).map(Number)
             const maxWidth = Math.max(...widthValues)
             const minWidth = Math.min(...widthValues)
             const widthScale = maxWidth > 0 ? 8 / maxWidth : 1
             
             for (const [val, width] of Object.entries(widths)) {
                 const w = Number(width)
                 // Scale proportionally: smallest width = 2px, largest = 10px
                 const scaledSize = Math.max(2, Math.round(w * widthScale) + 2)
                 items.push({
                     type: 'line',
                     label: String(val),
                     color: '128,128,128',
                     size: scaledSize
                 })
             }
        }
      }
      return items
    },

    getDefaultSize(style: any, shape: string): number {
        if (shape === 'line') {
          // Map units are meters, but Legend is pixels. 
          // Scale down significantly to represent relative thickness without being huge.
          const width = typeof style.lineWidth === 'number' ? style.lineWidth : 4
          return Math.max(2, Math.min(width / 3, 8))
        }
        if (shape === 'circle') return typeof style.pointRadius === 'number' ? style.pointRadius : 6
        return 12 // polygon
    },

    convertColorForLegend(color?: string): string {
      const parts = color?.replace('#', '').match(/.{1,2}/g)
      if (!parts || parts.length < 3) return '128,128,128'
      const nums = parts.slice(0, 3).map(x => {
        const n = parseInt(x, 16)
        return Number.isFinite(n) ? n : 128
      })
      return nums.join(',')
    },
    handleFeatureClick(feature: any): void { console.log('Clicked feature:', feature?.properties) },
    handleTooltip(index: number, feature: any): string {
      let props = feature?.properties
      
      // Fallback: If feature has no properties (e.g. line segments), look up by index
      if (!props && index >= 0 && this.geoJsonFeatures[index]) {
        props = this.geoJsonFeatures[index].properties
      }

      if (!props) return ''
      const EXCLUDE = new Set(['_table', '_layer', '_layerConfig', 'geometry', 'geo'])
      const lines: string[] = []
      
      // Add layer/table header
      if (props._layer) lines.push(`<b>${props._layer}</b>`)
      
      // Add all properties (not just first 5)
      for (const [key, value] of Object.entries(props)) {
        if (EXCLUDE.has(key) || key.startsWith('_')) continue
        if (value == null) continue
        const displayValue = typeof value === 'number' ? value.toLocaleString('en-US') : value
        lines.push(`${key}: ${displayValue}`)
      }
      return lines.join('<br/>')
    },

    async loadDashboardMetrics(): Promise<void> {
      const dashboard = this.vizDetails?.dashboard
      if (!dashboard?.sections || !dashboard.sections.length || !this.db) {
        this.dashboardSections = []
        return
      }

      const results: Array<{ name: string; rows: Array<{ label: string; value: any }> }> = []

      for (const section of dashboard.sections) {
        const rows: Array<{ label: string; value: any }> = []
        if (!section?.metrics?.length) continue

        for (const metric of section.metrics) {
          let value: any = '-'
          const sql = metric.query
          try {
            const targetDb = await this.getDbForMetric(metric.db)
            // SPL uses chained .get.objs pattern (consistent with db.ts)
            const objs = await targetDb.exec(sql).get.objs
            if (objs?.length) {
              const firstObj = objs[0]
              const firstKey = firstObj && Object.keys(firstObj)[0]
              if (firstKey !== undefined) value = firstObj[firstKey]
            }
            if (value === undefined || value === null || Number.isNaN(value)) value = '-'
            if (value !== '-') value = this.formatMetricValue(value)
          } catch (e) {
            console.warn(`Dashboard metric failed (${metric.label})`, { sql, db: metric.db || 'supply', error: e })
            value = '-'
          }
          rows.push({ label: metric.label, value })
        }

        results.push({ name: section.name || 'Dashboard', rows })
      }

      this.dashboardSections = results
    },

    async getDbForMetric(dbKey?: string): Promise<any> {
      const key = (dbKey || 'supply').toLowerCase()
      if (key === 'supply' || !dbKey) return this.db

      const path = key === 'demand' ? this.vizDetails.demandDatabase : key === 'result' ? this.vizDetails.resultDatabase : undefined
      if (!path) return this.db

      if (this.metricDbs[key]) {
        return this.metricDbs[key].db
      }

      try {
        const blob = await this.polarisFileSystem.loadPolarisDatabase(path)
        if (!blob) return this.db
        const dbConn = await openDb(this.spl, blob, path)
        const rawDb = markRaw(dbConn)
        this.metricDbs[key] = { db: rawDb, path }
        return rawDb
      } catch (e) {
        console.warn(`Failed to load metric DB '${key}'`, e)
        return this.db
      }
    },

    formatMetricValue(value: any): any {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(numeric)) {
        return numeric.toLocaleString('en-US')
      }
      return value
    },

    setMapCenter(): void {
      let { center, zoom = 12, bearing = 0, pitch = 0 } = this.vizDetails
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

.c-polaris-viewer {
  background-color: var(--bgCardFrame);
  display: flex;
  flex-direction: column;
  width: 100%;
}

.c-polaris-viewer.is-dashboard {
  // Dashboard items size to content
  height: auto;
  min-height: auto;
}

.c-polaris-viewer.is-map-view {
  // Map items fill container
  height: 100%;
  min-height: inherit;
}

.map-viewer {
  position: relative;
  flex: 1;
  width: 100%;
  min-height: 360px;
  z-index: 0;
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

.dashboard {
  padding: 1rem;
  overflow: auto;
}

.dashboard-section {
  margin-bottom: 1.25rem;
}

.dashboard-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.dashboard-card {
  background: var(--bgCardFrame);
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  box-shadow: 0 2px 6px rgba(0,0,0,0.05);
  transition: transform 120ms ease;
}

.dashboard-card.is-alt {
  background: linear-gradient(135deg, rgba(78,121,167,0.08), rgba(89,161,79,0.08));
}

.dashboard-card:hover {
  transform: translateY(-2px);
}

.dashboard-card .card-label {
  font-size: 0.9rem;
  color: var(--textMuted, #666);
  margin-bottom: 0.35rem;
}

.dashboard-card .card-value {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--textFancy, #111);
}
</style>

<!-- Global style for DeckGL tooltip to prevent flickering/interaction blocking -->
<style lang="scss">
.deck-tooltip {
  pointer-events: none !important;
  user-select: none !important;
}
</style>
