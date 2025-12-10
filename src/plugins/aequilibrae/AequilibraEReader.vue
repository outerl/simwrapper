<template lang="pug">
.c-aequilibrae-viewer.flex-col(:class="{'is-thumbnail': thumbnail}")
  b-input.search-box(
    type="search"
    icon-pack="fas"
    icon="search"
    placeholder="search tables..."
    v-model="searchTerm"
  )
  .viewer
    .database-content(v-if="isLoaded")
      p Database viewer - Tables will be listed here
      pre {{ viewData }}

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
import HTTPFileSystem from '@/js/HTTPFileSystem'

import { FileSystemConfig, UI_FONT, BG_COLOR_DASHBOARD } from '@/Globals'

//@ts-ignore
const isChrome = !!window.showDirectoryPicker // Chrome has File Access API
const isFirefox = !isChrome

const MyComponent = defineComponent({
  name: 'AequilibraEReader',
  i18n,
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
      vizDetails: { title: '', description: '', file: '' },
      loadingText: '',
      id: `id-${Math.floor(1e12 * Math.random())}` as any,
      sqliteWorker: null as any,
      databaseData: null as any,
      viewData: {} as any,
      searchTerm: '',
      debounceSearch: {} as any,
      isLoaded: false,
      isSearch: false,
    }
  },

  watch: {
    searchTerm() {
      this.debounceSearch()
    },
  },

  computed: {
    fileApi(): HTTPFileSystem {
      return new HTTPFileSystem(this.fileSystem, globalStore)
    },

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
    this.debounceSearch = debounce(this.handleSearch, 500)

    try {
      this.getVizDetails()
      // only continue if we are on a real page and not the file browser
      if (this.thumbnail) return

      const dbData = await this.fetchDatabase()

      this.databaseData = dbData
      this.viewData = this.databaseData
      this.isLoaded = true
    } catch (err) {
      const e = err as any
      console.error({ e })
      this.loadingText = '' + e
    }
  },

  methods: {
    getVizDetails() {
      if (this.config) {
        // config came in from the dashboard and is already parsed
        this.vizDetails = { ...this.config }
        this.vizDetails.file = `/${this.subfolder}/${this.config.file}`
        this.$emit('titles', this.vizDetails.title || this.vizDetails.file || 'AequilibraE Database')
      } else {
        // Otherwise this is a SQLite database file
        const filename = this.yamlConfig ?? ''
        this.vizDetails = {
          title: filename,
          description: '',
          file: this.subfolder + '/' + filename,
        }
      }
      this.$emit('titles', this.vizDetails.title || 'AequilibraE Database')
    },

    async fetchDatabase() {
      this.loadingText = `Loading ${this.vizDetails.file}...`

      // TODO: Load SQLite database file as ArrayBuffer
      // TODO: Initialize sql.js and create database instance
      // TODO: Query for tables and metadata
      // TODO: Return structured data with tables/columns/row counts
      
      // For now, return placeholder
      return {
        tables: [],
        metadata: {},
      }
    },

    async handleSearch() {
      console.log('search:', this.searchTerm)

      if (!this.searchTerm) {
        // clear empty search
        this.viewData = this.databaseData
        this.isSearch = false
      } else {
        // TODO: Filter tables by search term
        // TODO: Search in table names, column names, or data
        this.viewData = this.databaseData
        this.isSearch = true
      }
      this.isLoaded = false
      await this.$nextTick()
      this.isLoaded = true
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
  padding: 0.25rem 0.5rem !important;
}

.viewer {
  height: 100%;
  width: 100%;
  flex: 1;
  margin: 0 auto;
  overflow: auto;
}

.viewer.is-thumbnail {
  padding: 0rem 0rem;
  margin: 0 0;
}

.database-content {
  width: 100%;
  padding: 0.25rem 0;
}
</style>

<style lang="scss">
.search-box {
  margin-bottom: 0.5rem;
}

.search-box input {
  background-color: var(--bgPanel);
  border: 1px solid var(--bgCream3);
  color: var(--link);
}
</style>
