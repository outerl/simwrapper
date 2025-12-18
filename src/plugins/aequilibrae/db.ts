import type { JoinConfig } from './types'

export async function getTableNames(db: any): Promise<string[]> {
  const result = await db.exec("SELECT name FROM sqlite_master WHERE type='table';").get.objs
  return result.map((row: any) => row.name)
}

export async function getTableSchema(
  db: any,
  tableName: string
): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const result = await db.exec(`PRAGMA table_info("${tableName}");`).get.objs
  return result.map((row: any) => ({
    name: row.name,
    type: row.type,
    nullable: row.notnull === 0,
  }))
}

export async function getRowCount(db: any, tableName: string): Promise<number> {
  const result = await db.exec(`SELECT COUNT(*) as count FROM "${tableName}";`).get.objs
  return result.length > 0 ? result[0].count : 0
}

/**
 * Query a table and return all rows as objects
 */
export async function queryTable(
  db: any,
  tableName: string,
  columns?: string[]
): Promise<Record<string, any>[]> {
  const columnList = columns ? columns.map(c => `"${c}"`).join(', ') : '*'
  const query = `SELECT ${columnList} FROM "${tableName}";`
  const result = await db.exec(query).get.objs
  return result
}

/**
 * Perform an in-memory join between main data and external data
 * @param mainData - Array of records from the main table
 * @param joinData - Array of records from the join table
 * @param joinConfig - Configuration specifying join keys and type
 * @returns Merged array with joined columns added to main records
 */
export function performJoin(
  mainData: Record<string, any>[],
  joinData: Record<string, any>[],
  joinConfig: JoinConfig
): Record<string, any>[] {
  // Build a lookup map for efficient joining using the right key
  const joinLookup = new Map<any, Record<string, any>>()
  for (const row of joinData) {
    const key = row[joinConfig.rightKey]
    if (key !== undefined && key !== null) {
      joinLookup.set(key, row)
    }
  }

  const joinType = joinConfig.type || 'left'
  const results: Record<string, any>[] = []

  for (const mainRow of mainData) {
    const joinKey = mainRow[joinConfig.leftKey]
    const joinRow = joinLookup.get(joinKey)

    if (joinRow) {
      // Filter columns if specified
      let joinedColumns: Record<string, any>
      if (joinConfig.columns && joinConfig.columns.length > 0) {
        joinedColumns = {}
        for (const col of joinConfig.columns) {
          if (col in joinRow) {
            joinedColumns[col] = joinRow[col]
          }
        }
      } else {
        // Include all columns from join table (except the join key to avoid duplicates)
        joinedColumns = { ...joinRow }
        // Optionally remove duplicate key if it has the same name
        // We keep it for now as it might have different values
      }

      // Merge: main row properties take precedence, then add joined columns
      results.push({
        ...mainRow,
        ...joinedColumns,
      })
    } else if (joinType === 'left') {
      // No match found, but left join keeps the main row
      results.push({ ...mainRow })
    }
    // For 'inner' join, skip rows with no match
  }

  return results
}

/**
 * Fetch GeoJSON features from a table, optionally merging joined data
 * @param db - The main database connection
 * @param table - Table metadata with name and columns
 * @param layerName - Name of the layer for feature properties
 * @param layerConfig - Layer configuration
 * @param joinedData - Optional pre-joined data to merge into features (keyed by join column)
 * @param joinConfig - Optional join configuration specifying the key column
 */
export async function fetchGeoJSONFeatures(
  db: any,
  table: { name: string; columns: any[] },
  layerName: string,
  layerConfig: any,
  joinedData?: Map<any, Record<string, any>>,
  joinConfig?: JoinConfig
) {
  const columnNames = table.columns
    .filter((c: any) => c.name.toLowerCase() !== 'geometry')
    .map((c: any) => `"${c.name}"`)
    .join(', ')

  // Optionally allow a custom SQL filter from the YAML config for this layer
  // e.g. layerConfig.sqlFilter = "link_type != 'centroid'"
  let filterClause = 'geometry IS NOT NULL'
  if (
    layerConfig &&
    typeof layerConfig.sqlFilter === 'string' &&
    layerConfig.sqlFilter.trim().length > 0
  ) {
    filterClause += ` AND (${layerConfig.sqlFilter})`
  }

  const query = `
    SELECT ${columnNames},
           AsGeoJSON(geometry) as geojson_geom,
           GeometryType(geometry) as geom_type
    FROM "${table.name}"
    WHERE ${filterClause};
  `
  // LIMIT 1000000
  const rows = await db.exec(query).get.objs
  const features: any[] = []

  const joinType = joinConfig?.type || 'left'

  for (const row of rows) {
    if (!row.geojson_geom) continue

    // Build base properties from main table
    const properties: any = { _table: table.name, _layer: layerName, _layerConfig: layerConfig }
    for (const col of table.columns) {
      const key = col.name
      if (key.toLowerCase() !== 'geometry' && key !== 'geojson_geom' && key !== 'geom_type') {
        properties[key] = row[key]
      }
    }

    // Merge joined data if available
    if (joinedData && joinConfig) {
      const joinKey = row[joinConfig.leftKey]
      const joinRow = joinedData.get(joinKey)

      if (joinRow) {
        // Add joined columns to properties
        for (const [key, value] of Object.entries(joinRow)) {
          // Don't overwrite existing properties (main table takes precedence)
          if (!(key in properties)) {
            properties[key] = value
          } else if (key !== joinConfig.rightKey) {
            // If column name conflicts, prefix with table name
            properties[`${joinConfig.table}_${key}`] = value
          }
        }
        properties._hasJoinedData = true
      } else if (joinType === 'inner') {
        // Skip this feature for inner join when no match
        continue
      } else {
        properties._hasJoinedData = false
      }
    }

    features.push({ type: 'Feature', geometry: row.geojson_geom, properties })
  }
  return features
}
