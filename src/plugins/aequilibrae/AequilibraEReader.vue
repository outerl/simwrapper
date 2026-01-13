<template lang="pug">
.c-aequilibrae-viewer.flex-col(:class="{'is-thumbnail': thumbnail}")
  SqliteReader(
    :config="vizConfig"
    :subfolder="subfolder"
    :fileApi="aeqFileSystem"
    @isLoaded="$emit('isLoaded')"
    v-slot="{ geoJsonFeatures, fillColors, lineColors, lineWidths, pointRadii, fillHeights, featureFilter, isRGBA, redrawCounter, legendItems }"
  )
    DeckMapComponent(
      ref="deckMap"
      v-if="geoJsonFeatures.length && bgLayers && layerId"
      :features="geoJsonFeatures"
      :bgLayers="bgLayers"
      :cbTooltip="handleTooltip"
      :cbClickEvent="handleFeatureClick"
      :dark="globalState.isDarkMode"
      :featureFilter="featureFilter"
      :fillColors="fillColors"
      :fillHeights="fillHeights"
      :highlightedLinkIndex="-1"
      :initialView="initialView"
      :isRGBA="isRGBA"
      :isAtlantis="false"
      :lineColors="lineColors"
      :lineWidths="lineWidths"
      :mapIsIndependent="false"
      :opacity="1"
      :pointRadii="pointRadii"
      :redraw="redrawCounter"
      :screenshot="0"
      :viewId="layerId"
      :lineWidthUnits="'meters'"
      :pointRadiusUnits="'meters'"
    )
    .legend-overlay(v-if="legendItems.length" :style="{background: legendBgColor}")
      LegendColors(:items="legendItems" title="Legend")
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import globalStore from '@/store'
import { FileSystemConfig } from '@/Globals'
import AequilibraEFileSystem from './AequilibraEFileSystem'
import SqliteReader from '@/plugins/sqlite-map/SqliteReader.vue'
import { parseYamlConfig } from './useAequilibrae'
import { resolvePath } from '../sqlite-map/utils'
import DeckMapComponent from '@/plugins/shape-file/DeckMapComponent.vue'
import LegendColors from '@/components/LegendColors.vue'
import BackgroundLayers from '@/js/BackgroundLayers'
import type { VizDetails } from '../sqlite-map/types'

const MyComponent = defineComponent({
  name: 'AequilibraEReader',
  components: { DeckMapComponent, LegendColors, SqliteReader },
  props: {
    root: { type: String, required: true },
    subfolder: { type: String, required: true },
    config: { type: Object as any },
    resize: Object as any,
    thumbnail: Boolean,
    yamlConfig: String,
  },
  data() {
    const uid = `id-${Math.floor(1e12 * Math.random())}`
    return {
      globalState: globalStore.state,
      vizConfig: {} as VizDetails,
      id: uid,
      layerId: `aequilibrae-layer-${uid}`,
      aeqFileSystem: null as any,
      bgLayers: null as BackgroundLayers | null,
      initialView: null as any,
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
    legendBgColor(): string {
      return this.globalState.isDarkMode ? 'rgba(32,32,32,0.95)' : 'rgba(255,255,255,0.95)'
    },
  },

  watch: {
    resize() {
      // Trigger redraw through SqliteReader's slot data
      this.$forceUpdate()
    },
  },

  beforeUnmount() {
    // Cleanup is handled by SqliteReader
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
    } catch (err) {
      console.error('Error loading AequilibraE reader:', err)
    }
  },

  methods: {
    async initBackgroundLayers(): Promise<void> {
      try {
        this.bgLayers = new BackgroundLayers({
          vizDetails: this.vizConfig,
          fileApi: this.aeqFileSystem,
          subfolder: this.subfolder,
        })
        await this.bgLayers.initialLoad()
      } catch (error) {
        console.warn('Background layers failed to load:', error)
      }
    },

    resolvePath(filePath: string): string {
      return resolvePath(filePath, this.subfolder)
    },

    async getVizDetails(): Promise<void> {
      if (this.config) {
        this.vizConfig = { ...this.config }
        this.vizConfig.database = this.resolvePath(this.config.database || this.config.file)

        if (this.config.extraDatabases) {
          this.vizConfig.extraDatabases = Object.fromEntries(
            Object.entries(this.config.extraDatabases).map(([name, path]) => [
              name,
              this.resolvePath(path as string),
            ])
          )
        }
      } else if (this.yamlConfig) {
        const yamlBlob = await this.aeqFileSystem.getFileBlob(
          this.resolvePath(this.yamlConfig)
        )
        const yamlText = await yamlBlob.text()
        this.vizConfig = await parseYamlConfig(yamlText, this.subfolder || null)
      } else {
        throw new Error('No config or yamlConfig provided')
      }
      this.setMapCenter()
    },

    handleFeatureClick(feature: any) {
      console.log('Feature clicked:', feature)
    },

    handleTooltip(hoverInfo: any) {
      const props = hoverInfo?.object?.properties
      return props
        ? Object.entries(props).map(([key, value]) => `${key}: ${value}`).join('<br>')
        : ''
    },

    setMapCenter(): void {
      const center = this.vizConfig.center
      const zoom = this.vizConfig.zoom ?? 9
      const bearing = this.vizConfig.bearing ?? 0
      const pitch = this.vizConfig.pitch ?? 0

      if (!center) return

      let [lon, lat] = Array.isArray(center)
        ? center
        : center.split(',').map((c: string) => parseFloat(c.trim()))

      this.initialView = {
        longitude: lon,
        latitude: lat,
        zoom,
        bearing,
        pitch,
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
