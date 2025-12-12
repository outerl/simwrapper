<template lang="pug">
.c-aequilibrae-viewer.flex-col(:class="{'is-thumbnail': thumbnail}")
  .loading(v-if="!isLoaded") {{ loadingText  }}
  .map-viewer(v-show="isLoaded")
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

import globalStore from '@/store'
import AequilibraEFileSystem from '@/plugins/aequilibrae/AequilibraEFileSystem'
import DeckMapComponent from '@/plugins/shape-file/DeckMapComponent.vue'
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
      this.isLoaded = true
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

.loading {
  padding: 2rem;
  text-align: center;
  font-size: 1.2rem;
  color: var(--textFancy);
}
</style>
