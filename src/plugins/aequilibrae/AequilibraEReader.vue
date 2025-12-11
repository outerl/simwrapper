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
    aeq-map-component(v-if="geoJsonFeatures.length > 0"
      :dark="globalState.isDarkMode"
      :features="geoJsonFeatures"
      :viewId="layerId"
      @featureClick="handleFeatureClick"
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
import AeqMapComponent from '@/plugins/aequilibrae/AequilibraEMapComponent.vue'

import { FileSystemConfig, UI_FONT, BG_COLOR_DASHBOARD } from '@/Globals'

import SPL from 'spl.js'
import YAML from 'yaml'

const MyComponent = defineComponent({
  name: 'AequilibraEReader',
  i18n,
  components: {
    AeqMapComponent,
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
      vizDetails: { title: '', description: '', database: '', view: '' } as {
        title: string
        description: string
        database: string
        view: 'table' | 'map' | ''
      },
      loadingText: '',
      id: `id-${Math.floor(1e12 * Math.random())}` as any,
      layerId: `aeq-layer-${Math.floor(1e12 * Math.random())}` as string,
      aeqFileSystem: null as any,
      spl: null as any,
      db: null as any,
      tables: [] as Array<{name: string, type: string, rowCount: number, columns: any[]}>,
      searchTerm: '',
      isLoaded: false,
      viewMode: 'table' as 'table' | 'map',
      geoJsonFeatures: [] as any[],
      hasGeometry: false,
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
        console.log('SPL engine initialized with spatialite')
      }

      // Load the database
      this.loadingText = 'Loading database...'
      console.log(this.loadingText)
      const dbPath = this.vizDetails.database
      await this.loadDatabase(dbPath)
      
      // Get table information
      this.loadingText = 'Reading tables...'
      console.log(this.loadingText)
      const tableNames = await this.getTableNames(this.db)
      
      for (const tableName of tableNames) {
        const allowedTables = ['nodes', 'links', 'zones']
        if (allowedTables.includes(tableName.toLowerCase())) {
          console.log(tableName)
  
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
      console.error({ e })
      this.loadingText = `Error: ${e.message || e}`
      this.$emit('isLoaded')
    }
  },

  methods: {
    async getVizDetails() {
      console.log('Config object:', this.config)
      console.log('Subfolder:', this.subfolder)
      console.log('yamlConfig:', this.yamlConfig)
      
      if (this.config) {
        // config came in from the dashboard and is already parsed
        this.vizDetails = { ...this.config }
        const dbFile = this.config.database || this.config.file
        console.log('Database file from config:', dbFile)
        this.vizDetails.database = dbFile.startsWith('/') ? dbFile : `${this.subfolder}/${dbFile}`
        // Capture view preference from config
        if (this.config.view) this.vizDetails.view = this.config.view
        console.log('Final database path:', this.vizDetails.database)
        this.$emit('titles', this.vizDetails.title || dbFile || 'AequilibraE Database')
      } else if (this.yamlConfig) {
        // Need to load and parse the YAML file first
        const yamlPath = this.subfolder ? `${this.subfolder}/${this.yamlConfig}` : this.yamlConfig
        console.log('Loading YAML file from:', yamlPath)
        
        const yamlBlob = await this.aeqFileSystem.getFileBlob(yamlPath)
        const yamlText = await yamlBlob.text()
        const config = YAML.parse(yamlText)
        
        console.log('Parsed YAML config:', config)
        
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
        }
        
        console.log('Final database path:', this.vizDetails.database)
        this.$emit('titles', this.vizDetails.title)
      } else {
        throw new Error('No config or yamlConfig provided')
      }
    },

    async loadDatabase(filepath: string): Promise<void> {
      console.log('Loading database from:', filepath)
      
      const blob = await this.aeqFileSystem.getFileBlob(filepath)
      const arrayBuffer = await blob.arrayBuffer()

      const spl = await SPL();
      const db = spl.db(arrayBuffer)

      this.db = db
    },

    async getTableNames(db: any): Promise<string[]> {
      if (!db) throw new Error('Database not loaded')
      const result = await db.exec(`SELECT name FROM sqlite_master;`).get.objs

      return result.map((row: any) => row.name)
    },    
    
    async getTableSchema(db: any, tableName: string): Promise<{ name: string; type: string; nullable: boolean }[]> {
      if (!db) throw new Error('Database not loaded')

      const result = await db.exec(`PRAGMA table_info("${tableName}");`).get.objs

      return result.map((row: any) => ({
        name: row.name,
        type: row.type,
        nullable: row.notnull === 0,
      }))
    },

    async getRowCount(db: any, tableName: string): Promise<number> {
      if (!db) throw new Error('Database not loaded')

      const result = await db.exec(`SELECT COUNT(*) as count FROM "${tableName}";`).get.objs
      return result.length > 0 ? result[0].count : 0
    },

    async extractGeometryData() {
      try {
        // Extract geometries from each table that has them
        for (const table of this.tables) {
          const tableName = table.name
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
            LIMIT 10000;
          `
          
          const result = await this.db.exec(query).get.objs
          console.log(`Got ${result.length} features from ${tableName}`)
          
          // Convert to GeoJSON features
          for (const row of result) { // surely this is way too slow
            try {
              if (!row.geojson_geom) continue
              
              const geometry = row.geojson_geom
              
              // Build properties from all non-geometry columns
              const properties: any = { _table: tableName }
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
            } catch (e) {
              console.warn(`Error processing feature from ${tableName}:`, e)
            }
          }
        }
        
        console.log(`Total features extracted: ${this.geoJsonFeatures.length}`)
      } catch (err) {
        console.error('Error extracting geometry:', err)
      }
    },

    handleFeatureClick(feature: any) {
      // Handle click on map features
      if (!feature) return
      console.log('Clicked feature:', feature.properties)
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
