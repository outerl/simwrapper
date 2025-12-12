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
      :lineWidthUnits="'meters'"
    )

</template>

<script lang="ts">
import { i18n } from './i18n'

import { defineComponent } from 'vue'
import type { PropType } from 'vue'
// removed debounce (unused)

import globalStore from '@/store'
import AequilibraEFileSystem from '@/plugins/aequilibrae/AequilibraEFileSystem'
import DeckMapComponent from '@/plugins/shape-file/DeckMapComponent.vue'
import BackgroundLayers from '@/js/BackgroundLayers'

import { FileSystemConfig } from '@/Globals'

import { initSql, openDb, parseYamlConfig, buildTables, buildGeoFeatures } from './useAequilibrae'
import { buildStyleArrays } from './styling'
import type { LayerConfig, VizDetails } from './types'

// moved to types.ts

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
    const uniqueId = `id-${Math.floor(1e12 * Math.random())}`
    return {
      globalState: globalStore.state,
      vizDetails: { title: '', description: '', database: '', view: '', layers: {} } as VizDetails,
      layerConfigs: {} as { [layerName: string]: LayerConfig },
      loadingText: '',
      id: uniqueId as any,
      layerId: `aequilibrae-layer-${uniqueId}` as string,
      aeqFileSystem: null as any,
      spl: null as any,
      db: null as any,
      extraDbs: new Map() as Map<string, any>,
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

      this.loadingText = 'Loading SQL engine with spatialite...'
      this.spl = await initSql()

      // Load the main database
      this.loadingText = 'Loading database...'
      const dbPath = this.vizDetails.database
      const blob = await this.aeqFileSystem.getFileBlob(dbPath)
      const arrayBuffer = await blob.arrayBuffer()
      this.db = await openDb(this.spl, arrayBuffer)
      
      // Load extra databases for joins
      if (this.vizDetails.extraDatabases) {
        this.loadingText = 'Loading extra databases for joins...'
        for (const [name, path] of Object.entries(this.vizDetails.extraDatabases)) {
          try {
            const extraBlob = await this.aeqFileSystem.getFileBlob(path)
            const extraArrayBuffer = await extraBlob.arrayBuffer()
            const extraDb = await openDb(this.spl, extraArrayBuffer)
            this.extraDbs.set(name, extraDb)
            console.log(`✅ Loaded extra database '${name}' from ${path}`)
          } catch (e) {
            console.warn(`⚠️ Failed to load extra database '${name}' from ${path}:`, e)
          }
        }
      }
      
      // Get table information
      this.loadingText = 'Reading tables...'
      const { tables, hasGeometry } = await buildTables(this.db, this.layerConfigs)
      this.tables = tables
      this.hasGeometry = hasGeometry

      if (this.hasGeometry) {
        this.loadingText = 'Extracting geometries...'
        // Pass extra databases for join processing
        const features = await buildGeoFeatures(this.db, this.tables, this.layerConfigs, this.extraDbs)
        this.geoJsonFeatures = features.filter((f: any) => f && f.geometry && f.properties)

        const styles = buildStyleArrays({
          features: this.geoJsonFeatures,
          layers: this.layerConfigs,
          defaults: {
            fillColor: '#59a14f',
            lineColor: '#4e79a7',
            lineWidth: 2,
            pointRadius: 4,
            fillHeight: 0,
          },
        })
        this.fillColors = styles.fillColors
        this.lineColors = styles.lineColors
        this.lineWidths = styles.lineWidths
        this.pointRadii = styles.pointRadii
        this.fillHeights = styles.fillHeights
        this.featureFilter = styles.featureFilter
        this.isRGBA = true
        this.redrawCounter++
      } else {
        console.log('⚠️  No geometry columns found in loaded tables')
      }

      // Apply default view from config (only switch to map if geometry exists)
      if (this.vizDetails.view === 'map' && this.hasGeometry) {
        this.viewMode = 'map'
        this.setMapCenter()
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
        
        // Process extraDatabases paths
        if (this.config.extraDatabases) {
          const extraDatabases: Record<string, string> = {}
          for (const [name, path] of Object.entries(this.config.extraDatabases)) {
            const pathStr = path as string
            extraDatabases[name] = pathStr.startsWith('/') 
              ? pathStr 
              : `${this.subfolder}/${pathStr}`
          }
          this.vizDetails.extraDatabases = extraDatabases
        }
        
        // Populate layer configurations for rendering (includes join configs)
        this.layerConfigs = this.config.layers || {}
        // Example layer styling with joins:
        // layers:
        //   links:
        //     table: links
        //     geometry: geom
        //     join:
        //       database: results         # Key from extraDatabases
        //       table: car_skims_results
        //       leftKey: link_id          # Column in links table
        //       rightKey: link_id         # Column in results table
        //       type: left                # left or inner
        //     style:
        //       fillColor: { column: 'link_type', scheme: 'Category10' }
        //       lineColor: { column: 'travel_time_ratio', scheme: 'RdYlGn' }
        //       lineWidth: { column: 'lanes', range: [1, 6] }
      } else if (this.yamlConfig) {
        // Need to load and parse the YAML file first
        const yamlPath = this.subfolder ? `${this.subfolder}/${this.yamlConfig}` : this.yamlConfig
        
        const yamlBlob = await this.aeqFileSystem.getFileBlob(yamlPath)
        const yamlText = await yamlBlob.text()
        const parsed = await parseYamlConfig(yamlText, this.subfolder || null)
        this.vizDetails = parsed
        this.layerConfigs = parsed.layers || {}
        // same styling shape as above is supported
      } else {
        throw new Error('No config or yamlConfig provided')
      }
    },
    
    handleFeatureClick(feature: any) { // TODO: great opportunity to add something cool!
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

    setMapCenter() {
      let center = this.vizDetails.center
      
      // Handle string format "lon, lat"
      if (center && typeof center === 'string') {
        center = center.split(',').map((c: string) => parseFloat(c.trim())) as [number, number]
      }

      if (center && Array.isArray(center) && center.length === 2) {
        globalStore.commit('setMapCamera', {
          longitude: center[0],
          latitude: center[1],
          zoom: this.vizDetails.zoom || 9,
          bearing: this.vizDetails.bearing || 0,
          pitch: this.vizDetails.pitch || 0,
        })
      }
    },
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
