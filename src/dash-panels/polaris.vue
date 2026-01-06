<template lang="pug">
.polaris-panel
  .loading(v-if="isLoading") Loading polaris.yaml...
  .error(v-else-if="loadError") {{ loadError }}
  .polaris-scroll-content(v-else)
    //- Render items in YAML order
    .polaris-item(v-for="(item, idx) in displayItems" :key="idx" :class="{'is-map': item.type === 'map'}" :style="getItemStyle(item)")
      .polaris-item-title(v-if="item.title") {{ item.title }}
      polaris-reader(
        :root="rootSlug"
        :subfolder="item.subfolder"
        :config="item.config"
        :itemType="item.type"
        :thumbnail="false"
        @isLoaded="isLoaded"
        @error="$emit('error', $event)"
      )

</template>

<script lang="ts">
import { defineComponent } from 'vue'
import YAML from 'yaml'

import PolarisReader from '@/plugins/polaris/PolarisReader.vue'
import HTTPFileSystem from '@/js/HTTPFileSystem'
import { FileSystemConfig } from '@/Globals'

export default defineComponent({
  name: 'PolarisPanel',
  components: { PolarisReader },
  props: {
    // Plugin mode props
    root: { type: String, default: '' },
    // Dashboard panel mode props
    config: Object,
    datamanager: Object,
    fileSystemConfig: Object,
    subfolder: { type: String, default: '' },
    yamlConfig: String,
    thumbnail: Boolean,
  },
  data() {
    return {
      loadedItems: [] as any[],
      isLoading: true,
      loadError: '',
    }
  },
  computed: {
    // Get file system config from props or store
    fsConfig(): FileSystemConfig | null {
      if (this.fileSystemConfig) return this.fileSystemConfig as FileSystemConfig
      if (this.root) {
        return this.$store.state.svnProjects.find((p: FileSystemConfig) => p.slug === this.root) || null
      }
      return null
    },
    rootSlug(): string {
      return this.fsConfig?.slug || this.root || ''
    },
    displayItems(): Array<{ title?: string; subfolder: string; config: any; type: string; height?: number }> {
      // Use loadedItems if we loaded from YAML, otherwise use config prop
      const items = this.loadedItems.length ? this.loadedItems : (Array.isArray(this.config) ? this.config : [])
      return items.map((item: any) => ({
        title: item.item || item.title,
        type: item.type || 'dashboard',
        subfolder: item.subfolder || this.subfolder,
        config: { ...item },
        height: item.height,
      }))
    },
  },
  methods: {
    getItemStyle(item: { type: string; height?: number }): any {
      // For map items, apply height from config (height * 60 = pixels)
      if (item.type === 'map' && item.height) {
        const heightPx = item.height * 60
        return { height: `${heightPx}px`, minHeight: `${heightPx}px` }
      }
      return {}
    },
    isLoaded() {
      this.$emit('isLoaded')
    },
  },
  async mounted() {
    // If config is already an array (passed from dashboard), use it directly
    if (Array.isArray(this.config) && this.config.length) {
      this.isLoading = false
      return
    }
    
    // Otherwise, load polaris.yaml from the subfolder
    try {
      if (!this.fsConfig) {
        throw new Error('No file system configuration available')
      }
      
      const fileApi = new HTTPFileSystem(this.fsConfig)
      const yamlPath = `${this.subfolder}/polaris.yaml`
      const yamlText = await fileApi.getFileText(yamlPath)
      const parsed = YAML.parse(yamlText)
      
      // Extract webpolaris items array
      if (Array.isArray(parsed.webpolaris)) {
        this.loadedItems = parsed.webpolaris
      } else if (parsed.webpolaris) {
        // Legacy object format - wrap in array with single item
        this.loadedItems = [{ type: 'map', ...parsed.webpolaris }]
      }
      
      this.isLoading = false
    } catch (e) {
      this.loadError = `Failed to load polaris.yaml: ${e}`
      this.isLoading = false
    }
  },
})
</script>

<style scoped lang="scss">
@import '@/styles.scss';

.polaris-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.polaris-scroll-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.5rem;
}

.loading, .error {
  padding: 2rem;
  text-align: center;
  font-size: 1.1rem;
  color: var(--textMuted, #666);
}

.error {
  color: #c00;
}

.polaris-item {
  position: relative;
  z-index: 1;
  margin-bottom: 0.75rem;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bgCardFrame, #fff);
  box-shadow: 0 2px 6px rgba(0,0,0,0.06);
  flex-shrink: 0;
}

.polaris-item.is-map {
  /* Default height, can be overridden by inline :style binding */
  height: 450px;
  min-height: 360px;
}

.polaris-item-title {
  padding: 0.5rem 0.75rem;
  font-weight: 600;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  background: linear-gradient(135deg, rgba(78,121,167,0.06), rgba(89,161,79,0.06));
}
</style>
