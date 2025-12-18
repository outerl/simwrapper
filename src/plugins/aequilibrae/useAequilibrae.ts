import SPL from 'spl.js'
import YAML from 'yaml'
import type { VizDetails, LayerConfig, JoinConfig } from './types'
import { getTableNames, getTableSchema, getRowCount, fetchGeoJSONFeatures, queryTable } from './db'

export async function initSql() {
  const spl = await SPL()
  return spl
}

export async function openDb(spl: any, arrayBuffer: ArrayBuffer) {
  return spl.db(arrayBuffer)
}

export async function parseYamlConfig(
  yamlText: string,
  subfolder: string | null
): Promise<VizDetails> {
  const config = YAML.parse(yamlText)
  const dbFile = config.database || config.file
  if (!dbFile) throw new Error('No database field found in YAML config')
  const databasePath = dbFile.startsWith('/')
    ? dbFile
    : subfolder
    ? `${subfolder}/${dbFile}`
    : dbFile

  // Process extraDatabases paths
  const extraDatabases: Record<string, string> = {}
  if (config.extraDatabases) {
    for (const [name, path] of Object.entries(config.extraDatabases)) {
      const pathStr = path as string
      extraDatabases[name] = pathStr.startsWith('/')
        ? pathStr
        : subfolder
        ? `${subfolder}/${pathStr}`
        : pathStr
    }
  }

  return {
    title: config.title || dbFile,
    description: config.description || '',
    database: databasePath,
    extraDatabases: Object.keys(extraDatabases).length > 0 ? extraDatabases : undefined,
    view: config.view || '',
    layers: config.layers || {},
  }
}

export async function buildTables(
  db: any,
  layerConfigs: { [k: string]: LayerConfig },
  allNames?: string[]
) {
  const names = allNames ?? (await getTableNames(db))
  const select = Object.keys(layerConfigs).length
    ? [...new Set(Object.values(layerConfigs).map(c => c.table))]
    : ['nodes', 'links', 'zones']

  const tables: Array<{ name: string; type: string; rowCount: number; columns: any[] }> = []
  let hasGeometry = false

  for (const name of names) {
    if (!select.includes(name)) continue
    const schema = await getTableSchema(db, name)
    const rowCount = await getRowCount(db, name)
    const hasGeomCol = schema.some((c: any) => c.name.toLowerCase() === 'geometry')
    if (hasGeomCol) hasGeometry = true
    tables.push({ name, type: 'table', rowCount, columns: schema })
  }
  return { tables, hasGeometry }
}

/**
 * Load join data from an extra database and return as a lookup map
 */
export async function loadJoinData(
  extraDb: any,
  joinConfig: JoinConfig
): Promise<Map<any, Record<string, any>>> {
  const joinLookup = new Map<any, Record<string, any>>()

  // Query the join table
  const joinRows = await queryTable(extraDb, joinConfig.table, joinConfig.columns)

  for (const row of joinRows) {
    const key = row[joinConfig.rightKey]
    if (key !== undefined && key !== null) {
      joinLookup.set(key, row)
    }
  }

  return joinLookup
}

/**
 * Build GeoJSON features from database tables, with support for joining external data
 * @param db - Main database connection
 * @param tables - Table metadata
 * @param layerConfigs - Layer configurations including join specs
 * @param extraDbs - Map of extra database connections keyed by name
 */
export async function buildGeoFeatures(
  db: any,
  tables: any[],
  layerConfigs: { [k: string]: LayerConfig },
  extraDbs?: Map<string, any>
) {
  const plain = JSON.parse(JSON.stringify(layerConfigs))
  const layersToProcess = Object.keys(plain).length
    ? Object.entries(plain)
    : tables
        .filter(t => t.columns.some((c: any) => c.name.toLowerCase() === 'geometry'))
        .map(t => [t.name, { table: t.name, type: 'line' as const }])

  const features: any[] = []

  for (const [layerName, cfg] of layersToProcess as any) {
    const layerConfig = cfg as LayerConfig
    const tableName = layerConfig.table || layerName
    const table = tables.find(t => t.name === tableName)
    if (!table) continue
    if (!table.columns.some((c: any) => c.name.toLowerCase() === 'geometry')) continue

    // Check if this layer has a join configuration
    let joinedData: Map<any, Record<string, any>> | undefined
    let joinConfig: JoinConfig | undefined

    if (layerConfig.join && extraDbs) {
      joinConfig = layerConfig.join
      const extraDb = extraDbs.get(joinConfig.database)

      if (extraDb) {
        try {
          joinedData = await loadJoinData(extraDb, joinConfig)
          console.log(
            `✅ Loaded ${joinedData.size} rows from ${joinConfig.database}.${joinConfig.table} for joining`
          )
        } catch (e) {
          console.warn(
            `⚠️ Failed to load join data from ${joinConfig.database}.${joinConfig.table}:`,
            e
          )
        }
      } else {
        console.warn(
          `⚠️ Extra database '${joinConfig.database}' not found for layer '${layerName}'`
        )
      }
    }

    const layerFeatures = await fetchGeoJSONFeatures(
      db,
      table,
      layerName,
      cfg,
      joinedData,
      joinConfig
    )
    features.push(...layerFeatures)
  }
  return features
}
