<template lang="pug">
.c-aequilibrae-viewer.flex-col(:class="{'is-thumbnail': thumbnail}")
  
  .view-toggle-bar(v-if="isLoaded && !thumbnail")
    b-button-group
      b-button(:type="viewMode === 'table' ? 'is-primary' : ''" @click="viewMode = 'table'") 📋 Tables
      b-button(:type="viewMode === 'map' ? 'is-primary' : ''" @click="viewMode = 'map'" :disabled="!hasGeometry") 🗺️ Map

  .viewer(v-show="viewMode === 'table' || !isLoaded")
    .loading(v-if="loadingText") {{ loadingText }}
    .database-content(v-if="isLoaded")
      h3 {{ vizDetails.title || 'Database Tables' }}
      p(v-if="!tables.length") No tables found
      .table-list(v-else)
        .table-item(v-for="table in tables" :key="table.name")
          h4 {{ table.name }}
          p {{ table.rowCount }} rows
          .columns
            div(v-for="col in table.columns" :key="col.name")
              | {{ col.name }} ({{ col.type }})

  .map-viewer(v-show="viewMode === 'map' && isLoaded")
    DeckMapComponent(v-if="geoJsonFeatures.length > 0 && bgLayers && layerId"
      :features="geoJsonFeatures"
      :bgLayers="bgLayers"
      :cbTooltip="handleTooltip"
      :cbClickEvent="handleFeatureClick"
      :dark="globalState.isDarkMode"
      :featureFilter="featureFilter"
      :fillColors="fillColors"
      :fillHeights="fillHeights"
      :highlightedLinkIndex="-1"
      :initialView="null"
      :isRGBA="isRGBA"
      :isAtlantis="false"
      :lineColors="lineColors"
      :lineWidths="lineWidths"
      :mapIsIndependent="false"
      :opacity="1.0"
      :pointRadii="pointRadii"
      :redraw="redrawCounter"
      :screenshot="0"
      :viewId="layerId"
    )

</template>

<script lang="ts">
const i18n = {
  messages: {
    en: {},
    de: {},
  },
}

import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import debounce from 'debounce'

import globalStore from '@/store'
import AequilibraEFileSystem from '@/plugins/aequilibrae/AequilibraEFileSystem'
import DeckMapComponent from '@/plugins/shape-file/DeckMapComponent.vue'
import BackgroundLayers from '@/js/BackgroundLayers'

import { FileSystemConfig, UI_FONT, BG_COLOR_DASHBOARD } from '@/Globals'

import SPL from 'spl.js'
import YAML from 'yaml'

interface LayerConfig {
  table: string
  type: 'polygon' | 'line' | 'point'
  fillColor?: string
  strokeColor?: string
  strokeWidth?: number
  radius?: number
  opacity?: number
  zIndex?: number
}

const MyComponent = defineComponent({
  name: 'AequilibraEReader',
  i18n,
  components: {
    DeckMapComponent,
  },
  props: {
    root: { type: String, required: true },
    subfolder: { type: String, required: true },
    config: { type: Object as any },
    resize: Object as any,
    thumbnail: Boolean,
    yamlConfig: String,
  },

  data() {
    return {
      globalState: globalStore.state,
      vizDetails: { title: '', description: '', database: '', view: '', layers: {} } as {
        title: string
        description: string
        database: string
        view: 'table' | 'map' | ''
        layers: { [key: string]: LayerConfig }
      },
      layerConfigs: {} as { [layerName: string]: LayerConfig },
      loadingText: '',
      id: `id-${Math.floor(1e12 * Math.random())}` as any,
      layerId: 'aequilibrae-layer-1' as string,
      aeqFileSystem: null as any,
      spl: null as any,
      db: null as any,
      tables: [] as Array<{name: string, type: string, rowCount: number, columns: any[]}>,
      searchTerm: '',
      isLoaded: false,
      viewMode: 'table' as 'table' | 'map',
      geoJsonFeatures: [] as any[],
      hasGeometry: false,
      // DeckMapComponent props
      bgLayers: null as BackgroundLayers | null,
      featureFilter: new Float32Array(),
      fillColors: '#59a14f' as string | Uint8ClampedArray,
      fillHeights: 0 as number,
      lineColors: '#4e79a7' as string | Uint8ClampedArray,
      lineWidths: 2 as number | Float32Array,
      pointRadii: 4 as number | Float32Array,
      redrawCounter: 0,
      isRGBA: false,
    }
  },

  watch: {
    searchTerm() {
      // Search functionality can be added later if needed
    },
  },

  computed: {
    fileSystem(): FileSystemConfig {
      const svnProject: FileSystemConfig[] = this.$store.state.svnProjects.filter(
        (a: FileSystemConfig) => a.slug === this.root
      )
      if (svnProject.length === 0) {
        console.log('no such project')
        throw Error
      }
      return svnProject[0]
    },
  },

  async mounted() {
    this.aeqFileSystem = new AequilibraEFileSystem(this.fileSystem, globalStore)
    
    // Initialize background layers
    try {
      this.bgLayers = new BackgroundLayers({
        vizDetails: this.vizDetails,
        fileApi: this.aeqFileSystem,
        subfolder: this.subfolder,
      })
      await this.bgLayers.initialLoad()
    } catch (e) {
      console.warn('⚠️  Could not load background layers:', e)
    }

    try {
      await this.getVizDetails()
      
      // only continue if we are on a real page and not the file browser
      if (this.thumbnail) {
        this.$emit('isLoaded')
        return
      }

      // Initialize spl.js with spatialite support
      if (!this.spl) {
        this.loadingText = 'Loading SQL engine with spatialite...'
        this.spl = await SPL()
      }

      // Load the database
      this.loadingText = 'Loading database...'
      const dbPath = this.vizDetails.database
      await this.loadDatabase(dbPath)
      
      // Get table information
      this.loadingText = 'Reading tables...'
      const tableNames = await this.getTableNames(this.db)
      
      // Determine which tables to load based on layer configuration
      const tablesToLoad = Object.keys(this.layerConfigs).length > 0 
        ? [...new Set(Object.values(this.layerConfigs).map(config => config.table))] // Get unique table names from layer configs
        : ['nodes', 'links', 'zones'] // Fallback to default AequilibraE tables
      
      for (const tableName of tableNames) {
        if (tablesToLoad.includes(tableName)) {
          const schema = await this.getTableSchema(this.db, tableName)
          const rowCount = await this.getRowCount(this.db, tableName)
          
          // Check if table has geometry column
          const hasGeomCol = schema.some(col => col.name.toLowerCase() === 'geometry')
          if (hasGeomCol) {
            this.hasGeometry = true
          }
          
          this.tables.push({
            name: tableName,
            type: 'table',
            rowCount,
            columns: schema,
          }) 
        }
      }

      // Extract geometry if available
      if (this.hasGeometry) {
        this.loadingText = 'Extracting geometries...'
        await this.extractGeometryData()
      } else {
        console.log('⚠️  No geometry columns found in loaded tables')
      }

      // Apply default view from config (only switch to map if geometry exists)
      if (this.vizDetails.view === 'map' && this.hasGeometry) {
        this.viewMode = 'map'
      } else if (this.vizDetails.view === 'table') {
        this.viewMode = 'table'
      }

      this.isLoaded = true
      this.loadingText = ''
      this.$emit('isLoaded')
    } catch (err) {
      const e = err as any
      console.error('❌ Error during AequilibraE loading:', e)
      console.error('  └─ Error details:', { message: e.message, stack: e.stack })
      this.loadingText = `Error: ${e.message || e}`
      this.$emit('isLoaded')
    }
  },

  methods: {
    async getVizDetails() {
      if (this.config) {
        // config came in from the dashboard and is already parsed
        this.vizDetails = { ...this.config }
        const dbFile = this.config.database || this.config.file
        this.vizDetails.database = dbFile.startsWith('/') ? dbFile : `${this.subfolder}/${dbFile}`
        // Capture view preference from config
        if (this.config.view) this.vizDetails.view = this.config.view
        
        // Populate layer configurations for rendering
        this.layerConfigs = this.config.layers || {}
        
        this.$emit('titles', this.vizDetails.title || dbFile || 'AequilibraE Database')
      } else if (this.yamlConfig) {
        // Need to load and parse the YAML file first
        const yamlPath = this.subfolder ? `${this.subfolder}/${this.yamlConfig}` : this.yamlConfig
        
        const yamlBlob = await this.aeqFileSystem.getFileBlob(yamlPath)
        
        const yamlText = await yamlBlob.text()
        
        const config = YAML.parse(yamlText)
        
        // Now get the database path from the YAML
        const dbFile = config.database || config.file
        if (!dbFile) {
          throw new Error('No database field found in YAML config')
        }
        
        const databasePath = dbFile.startsWith('/') 
          ? dbFile 
          : this.subfolder ? `${this.subfolder}/${dbFile}` : dbFile
        
        this.vizDetails = {
          title: config.title || this.yamlConfig,
          description: config.description || '',
          database: databasePath,
          view: config.view || '',
          layers: config.layers || {},
        }
        
        // Populate layer configurations for rendering
        this.layerConfigs = this.vizDetails.layers || {}
        
        this.$emit('titles', this.vizDetails.title)
      } else {
        throw new Error('No config or yamlConfig provided')
      }
    },

    async loadDatabase(filepath: string): Promise<void> {
      try {
        const blob = await this.aeqFileSystem.getFileBlob(filepath)
        const arrayBuffer = await blob.arrayBuffer()
        const spl = await SPL();
        const db = spl.db(arrayBuffer)

        this.db = db
      } catch (error) {
        console.error('  ❌ Database loading failed:', error)
        throw error
      }
    },

    async getTableNames(db: any): Promise<string[]> {
      if (!db) {
        console.error('❌ Database not loaded for getTableNames')
        throw new Error('Database not loaded')
      }
      
      const result = await db.exec(`SELECT name FROM sqlite_master WHERE type='table';`).get.objs
      const tableNames = result.map((row: any) => row.name)
      
      return tableNames
    },    
    
    async getTableSchema(db: any, tableName: string): Promise<{ name: string; type: string; nullable: boolean }[]> {
      if (!db) {
        console.error('❌ Database not loaded for getTableSchema')
        throw new Error('Database not loaded')
      }

      const result = await db.exec(`PRAGMA table_info("${tableName}");`).get.objs
      
      const schema = result.map((row: any) => ({
        name: row.name,
        type: row.type,
        nullable: row.notnull === 0,
      }))
      
      return schema
    },

    async getRowCount(db: any, tableName: string): Promise<number> {
      if (!db) {
        console.error('❌ Database not loaded for getRowCount')
        throw new Error('Database not loaded')
      }

      const result = await db.exec(`SELECT COUNT(*) as count FROM "${tableName}";`).get.objs
      const count = result.length > 0 ? result[0].count : 0
      return count
    },

    async extractGeometryData() {
      try {
        // Convert reactive object to plain object to avoid proxy issues
        const plainLayerConfigs = JSON.parse(JSON.stringify(this.layerConfigs))
        
        // Use layer configurations if available, otherwise extract from all geometry tables
        const layersToProcess = Object.keys(plainLayerConfigs).length > 0 
          ? Object.entries(plainLayerConfigs)
          : this.tables
              .filter(table => 
                table.columns.some(col => col.name.toLowerCase() === 'geometry')
              )
              .map(table => [table.name, { table: table.name, type: 'line' as const }])
        
        if (layersToProcess.length === 0) {
          return
        }
        
        this.geoJsonFeatures = []
        let totalFeatures = 0
        
        // Extract geometries from each configured layer
        for (const [layerName, layerConfig] of layersToProcess) {
          const tableName = (layerConfig as LayerConfig).table || layerName
          const table = this.tables.find(t => t.name === tableName)
          
          if (!table) continue
          
          const hasGeometry = table.columns.some(col => col.name.toLowerCase() === 'geometry')
          if (!hasGeometry) continue
          
          // Query to get all columns plus geometry as GeoJSON
          const columnNames = table.columns
            .filter(col => col.name.toLowerCase() !== 'geometry')
            .map(col => `"${col.name}"`)
            .join(', ')
          
          const query = `
            SELECT ${columnNames}, 
                   AsGeoJSON(geometry) as geojson_geom,
                   GeometryType(geometry) as geom_type
            FROM "${tableName}"
            WHERE geometry IS NOT NULL
            LIMIT 1000000;
          `
          
          const result = await this.db.exec(query).get.objs
          
          // Convert to GeoJSON features
          let layerFeatureCount = 0
          
          for (const row of result) {
            try {
              if (!row.geojson_geom) continue
              
              const geometry = row.geojson_geom
              
              // Build properties from all non-geometry columns
              const properties: any = { 
                _table: tableName,
                _layer: layerName,
                _layerConfig: layerConfig
              }
              
              for (const col of table.columns) {
                if (col.name.toLowerCase() !== 'geometry' && col.name !== 'geojson_geom' && col.name !== 'geom_type') {
                  properties[col.name] = row[col.name]
                }
              }
              
              const feature = {
                type: 'Feature',
                geometry,
                properties,
              }
              
              this.geoJsonFeatures.push(feature)
              layerFeatureCount++
            } catch (e) {
              // Skip invalid features silently
            }
          }
          
          totalFeatures += layerFeatureCount
        }
        
        // Update map visualization
        this.updateMapColors()
      } catch (err: any) {
        console.error('❌ Error extracting geometry:', err)
        console.error('  └─ Stack trace:', err.stack)
      }
    },

    handleFeatureClick(feature: any) {
      // Handle click on map features
      if (!feature) return
      console.log('Clicked feature:', feature.properties)
    },

    handleTooltip(hoverInfo: any) {
      // Handle tooltip display for DeckMapComponent
      if (!hoverInfo?.object?.properties) return ''
      
      const props = hoverInfo.object.properties
      const lines = []
      
      // Show layer and table info
      if (props._layer) lines.push(`Layer: ${props._layer}`)
      if (props._table && props._table !== props._layer) lines.push(`Table: ${props._table}`)
      
      // Show up to 5 most relevant properties
      const excludeProps = ['_table', '_layer', '_layerConfig', 'geometry']
      const relevantProps = Object.entries(props)
        .filter(([key]) => !excludeProps.includes(key))
        .slice(0, 5)
      
      for (const [key, value] of relevantProps) {
        if (value !== null && value !== undefined) {
          lines.push(`${key}: ${value}`)
        }
      }
      
      return lines.join('<br/>')
    },

    updateMapColors() {
      const featureCount = this.geoJsonFeatures.length
      
      if (featureCount === 0) {
        console.log('  ⚠️  No features to style')
        return
      }
      
      // Validate features have required structure
      const validFeatures = this.geoJsonFeatures.filter(f => f && f.geometry && f.properties)
      if (validFeatures.length !== featureCount) {
        console.warn(`⚠️  ${featureCount - validFeatures.length} invalid features found, filtering them out`)
        this.geoJsonFeatures = validFeatures
      }
      
      // Create filters (all features visible by default)
      this.featureFilter = new Float32Array(validFeatures.length).fill(1)
      
      // Apply layer-based styling
      this.applyLayerStyling()
      
      this.redrawCounter++
    },

    applyLayerStyling() {
      const featureCount = this.geoJsonFeatures.length
      
      if (featureCount === 0) {
        console.log('  ⚠️  No features to style')
        return
      }
      
      // Initialize color and size arrays
      const fillColors = new Uint8ClampedArray(featureCount * 4)
      const lineColors = new Uint8ClampedArray(featureCount * 3) // RGB only for lines
      const lineWidths = new Float32Array(featureCount)
      const pointRadii = new Float32Array(featureCount)
      
      const styleStats: any = {}
      let defaultStyles = 0
      
      // Apply styling for each feature based on its layer configuration
      this.geoJsonFeatures.forEach((feature, i) => {
        // Null safety checks
        if (!feature || !feature.properties || !feature.geometry) {
          console.warn(`  ⚠️  Invalid feature at index ${i}:`, feature)
          return
        }
        
        const layerConfig = feature.properties._layerConfig || {}
        const layerName = feature.properties._layer || 'unknown'
        const geomType = (feature.geometry.type || '').toLowerCase()
        
        // Track style statistics
        if (!styleStats[layerName]) {
          styleStats[layerName] = { count: 0, fillColor: layerConfig.fillColor, strokeColor: layerConfig.strokeColor }
        }
        styleStats[layerName].count++
        
        if (!layerConfig.fillColor && !layerConfig.strokeColor) {
          defaultStyles++
        }
        
        // Set fill colors (for polygons and points)
        const fillColor = this.parseColor(layerConfig.fillColor || '#59a14f')
        fillColors[i * 4] = fillColor.r
        fillColors[i * 4 + 1] = fillColor.g
        fillColors[i * 4 + 2] = fillColor.b
        fillColors[i * 4 + 3] = Math.round((layerConfig.opacity || 0.8) * 255)
        
        // Set line colors (for lines and polygon outlines) 
        const strokeColor = this.parseColor(layerConfig.strokeColor || layerConfig.fillColor || '#4e79a7')
        lineColors[i * 3] = strokeColor.r
        lineColors[i * 3 + 1] = strokeColor.g
        lineColors[i * 3 + 2] = strokeColor.b
        
        // Set line widths based on geometry type
        // Polygons should have thinner outlines, lines should be more prominent
        if (layerConfig.strokeWidth !== undefined) {
          lineWidths[i] = layerConfig.strokeWidth
        } else if (geomType.includes('polygon')) {
          lineWidths[i] = 1 // Thin outline for polygons
        } else if (geomType.includes('line')) {
          lineWidths[i] = 3 // Thicker for lines
        } else {
          lineWidths[i] = 2 // Default for points
        }
        
        // Set point radii
        pointRadii[i] = layerConfig.radius || 4
      })
      
      // Update component properties - always use arrays to ensure consistent rendering
      this.fillColors = fillColors
      this.lineColors = lineColors
      this.lineWidths = lineWidths
      this.pointRadii = pointRadii
      
      // Set RGBA flag when using color arrays
      this.isRGBA = true
    },

    parseColor(colorString: string): { r: number, g: number, b: number } {
      // Parse hex color string to RGB
      if (colorString.startsWith('#')) {
        const hex = colorString.slice(1)
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        return { r, g, b }
      }
      
      // Default color if parsing fails
      return { r: 89, g: 161, b: 79 }
    },




  },
})

export default MyComponent
</script>

<style scoped lang="scss">
@import '@/styles.scss';

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

.view-toggle-bar {
  padding: 0.5rem;
  border-bottom: 1px solid var(--borderColor);
  background-color: var(--bgPanel);
  z-index: 10;
}

.viewer {
  flex: 1;
  overflow: auto;
  padding: 0.5rem 1rem;
}

.map-viewer {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
}

.loading {
  padding: 2rem;
  text-align: center;
  font-size: 1.2rem;
  color: var(--textFancy);
}

.database-content {
  padding: 0.5rem 0;
  
  h3 {
    margin-bottom: 1rem;
    color: var(--textFancy);
  }
  
  h4 {
    margin-top: 1.5rem;
    margin-bottom: 0.5rem;
    color: var(--link);
    font-weight: bold;
  }
  
  p {
    margin: 0.25rem 0;
    color: var(--text);
  }
  
  .columns {
    margin-left: 1rem;
    font-size: 0.9rem;
    color: var(--textFancy);
    
    div {
      margin: 0.1rem 0;
    }
  }
}
</style>
