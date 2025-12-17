<template lang="pug">
.c-aequilibrae-viewer.flex-col(:class="{'is-thumbnail': thumbnail}")
  .loading(v-if="!isLoaded") {{ loadingText  }}
  .map-viewer(v-show="isLoaded")
    DeckMapComponent(
      ref="deckMap"
      v-if="geoJsonFeatures.length > 0 && bgLayers && layerId"
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
    .legend-overlay(v-if="legendItems.length")
      LegendColors(:items="legendItems" title="Legend")

</template>

<script lang="ts">
import { i18n } from './i18n'

import { defineComponent } from 'vue'

import globalStore from '@/store'
import AequilibraEFileSystem from '@/plugins/aequilibrae/AequilibraEFileSystem'
import DeckMapComponent from '@/plugins/shape-file/DeckMapComponent.vue'
import LegendColors from '@/components/LegendColors.vue'
import BackgroundLayers from '@/js/BackgroundLayers'

import { FileSystemConfig } from '@/Globals'

import { initSql, openDb, parseYamlConfig, buildTables, buildGeoFeatures } from './useAequilibrae'
import { buildStyleArrays } from './styling'
import type { LayerConfig, VizDetails } from './types'

const MyComponent = defineComponent({
  name: 'AequilibraEReader',
  i18n,
  components: {
    DeckMapComponent,
    LegendColors,
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
      vizDetails: {} as VizDetails,
      layerConfigs: {} as { [layerName: string]: LayerConfig },
      loadingText: '',
      id: uniqueId,
      layerId: `aequilibrae-layer-${uniqueId}`,
      aeqFileSystem: null as any,
      spl: null as any,
      db: null as any,
      extraDbs: new Map() as Map<string, any>,
      tables: [] as Array<{name: string, type: string, rowCount: number, columns: any[]}>,
      isLoaded: false,
      geoJsonFeatures: [] as any[],
      hasGeometry: false,
      bgLayers: null as BackgroundLayers | null,
      featureFilter: new Float32Array(),
      fillColors: new Uint8ClampedArray(),
      fillHeights: new Float32Array(),
      lineColors: new Uint8ClampedArray(),
      lineWidths: new Float32Array(),
      pointRadii: new Float32Array(),
      redrawCounter: 0,
      isRGBA: false,
      legendItems: [] as Array<{ label: string, color: string, value: any }>,
    }
  },

  computed: {
    fileSystem(): FileSystemConfig {
      const project = this.$store.state.svnProjects.find(
        (a: FileSystemConfig) => a.slug === this.root
      )
      if (!project) throw new Error(`Project '${this.root}' not found`)
      return project
    },
  },

  watch: {
    resize() {
      // Trigger redraw when panel is resized
      this.redrawCounter += 1
    },
  },

  async mounted() {
    try {
      this.aeqFileSystem = new AequilibraEFileSystem(this.fileSystem, globalStore)
      await this.initBackgroundLayers()
      
      if (this.thumbnail) {
        this.$emit('isLoaded')
        return
      }

      await this.getVizDetails()
      await this.loadDatabase()
      await this.extractGeometries()
      
      if (this.hasGeometry) this.setMapCenter()
      this.isLoaded = true;
      this.buildLegend();
      this.$nextTick(() => { // trigger a map resize after load
        if (this.$refs.deckMap && this.$refs.deckMap.mymap) {
          this.$refs.deckMap.mymap.resize();
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('❌ AequilibraE Error:', message)
      this.loadingText = `Error: ${message}`
    } finally {
      this.$emit('isLoaded')
    }
  },

  methods: {
    async initBackgroundLayers() {
      try {
        // Force the map style to dark-matter.json
        if (!this.vizDetails) this.vizDetails = {};
        this.vizDetails.mapStyle = 'map-styles/dark-matter.json';
        this.bgLayers = new BackgroundLayers({
          vizDetails: this.vizDetails,
          fileApi: this.aeqFileSystem,
          subfolder: this.subfolder,
        })
        await this.bgLayers.initialLoad()
      } catch (e) {
        console.warn('Background layers failed to load:', e)
      }
    },

    resolvePath(filePath: string): string {
      if (!filePath) throw new Error('File path is required')
      return filePath.startsWith('/') ? filePath : `${this.subfolder}/${filePath}`
    },

    async loadDatabase() {
      this.loadingText = 'Loading SQL engine...'
      this.spl = await initSql()

      this.loadingText = 'Loading database...'
      const blob = await this.aeqFileSystem.getFileBlob(this.vizDetails.database)
      const arrayBuffer = await blob.arrayBuffer()
      this.db = await openDb(this.spl, arrayBuffer)

      if (this.vizDetails.extraDatabases) {
        this.loadingText = 'Loading extra databases...'
        for (const [name, path] of Object.entries(this.vizDetails.extraDatabases)) {
          try {
            const blob = await this.aeqFileSystem.getFileBlob(path as string)
            const arrayBuffer = await blob.arrayBuffer()
            this.extraDbs.set(name, await openDb(this.spl, arrayBuffer))
          } catch (e) {
            console.warn(`Failed to load extra database '${name}':`, e)
          }
        }
      }

      this.loadingText = 'Reading tables...'
      const { tables, hasGeometry } = await buildTables(this.db, this.layerConfigs)
      this.tables = tables
      this.hasGeometry = hasGeometry
    },

    async extractGeometries() {
      if (!this.hasGeometry) {
        console.warn('⚠️ No geometry columns found')
        return
      }

      this.loadingText = 'Extracting geometries...'
      const features = await buildGeoFeatures(this.db, this.tables, this.layerConfigs, this.extraDbs)
      
      console.log('📊 Total features from buildGeoFeatures:', features.length)
      console.log('First feature:', features[0])
      
      // Don't filter - just use all features
      this.geoJsonFeatures = features
      
      console.log('📊 Features after filtering:', this.geoJsonFeatures.length)

      const styles = buildStyleArrays({
        features: this.geoJsonFeatures,
        layers: this.layerConfigs,
        defaults: this.vizDetails.defaults,
      })

      console.log('🎨 Styling arrays:', {
        fillColors: styles.fillColors.length,
        lineColors: styles.lineColors.length,
        geoJsonFeaturesCount: this.geoJsonFeatures.length,
      })

      Object.assign(this, {
        fillColors: styles.fillColors,
        lineColors: styles.lineColors,
        lineWidths: styles.lineWidths,
        pointRadii: styles.pointRadii,
        fillHeights: styles.fillHeights,
        featureFilter: styles.featureFilter,
        isRGBA: true,
        redrawCounter: this.redrawCounter + 1,
      })
      
      console.log('✅ Extraction complete, bgLayers:', this.bgLayers)
    },

    async getVizDetails() {
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

    buildLegend() {
      // Manual legend definition from YAML config (vizDetails.legend)
      const legend = this.vizDetails.legend
      if (Array.isArray(legend)) {
        this.legendItems = legend.map(entry => {
          if (entry.subtitle) {
            return { type: 'subtitle', label: entry.subtitle }
          }
          // Feature entry: label, color, size, shape
          return {
            type: entry.shape || 'line',
            label: entry.label || '',
            color: entry.color ? entry.color.replace('#', '').match(/.{1,2}/g).map(x => parseInt(x, 16)).join(',') : undefined,
            size: entry.size,
            value: entry.label || '',
          }
        })
        return
      }
      // fallback: no legend
      this.legendItems = []
    },

    handleFeatureClick(feature: any) {
      console.log('Clicked feature:', feature?.properties)
    },

    handleTooltip(hoverInfo: any): string {
      const props = hoverInfo?.object?.properties
      if (!props) return ''

      const EXCLUDE = new Set(['_table', '_layer', '_layerConfig', 'geometry'])
      const lines = [
        props._layer && `Layer: ${props._layer}`,
        props._table && props._table !== props._layer && `Table: ${props._table}`,
        ...Object.entries(props)
          .filter(([key]) => !EXCLUDE.has(key))
          .slice(0, 5)
          .map(([key, value]) => value != null && `${key}: ${value}`),
      ].filter(Boolean)

      return lines.join('<br/>')
    },

    setMapCenter() {
      let { center, zoom = 9, bearing = 0, pitch = 0 } = this.vizDetails
      
      if (typeof center === 'string') {
        center = center.split(',').map((c: string) => parseFloat(c.trim())) as [number, number]
      }

      if (Array.isArray(center) && center.length === 2) {
        globalStore.commit('setMapCamera', {
          longitude: center[0],
          latitude: center[1],
          zoom,
          bearing,
          pitch,
        })
      }
    },
  }
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
  background: rgba(255,255,255,0.95);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
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
