export async function getTableNames(db: any): Promise<string[]> {
  const result = await db.exec("SELECT name FROM sqlite_master WHERE type='table';").get.objs;
  return result.map((row: any) => row.name);
}

export async function getTableSchema(db: any, tableName: string): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const result = await db.exec(`PRAGMA table_info("${tableName}");`).get.objs;
  return result.map((row: any) => ({
    name: row.name,
    type: row.type,
    nullable: row.notnull === 0,
  }));
}

export async function getRowCount(db: any, tableName: string): Promise<number> {
  const result = await db.exec(`SELECT COUNT(*) as count FROM "${tableName}";`).get.objs;
  return result.length > 0 ? result[0].count : 0;
}

export async function fetchGeoJSONFeatures(db: any, table: { name: string; columns: any[] }, layerName: string, layerConfig: any) {
  const columnNames = table.columns
    .filter((c: any) => c.name.toLowerCase() !== 'geometry')
    .map((c: any) => `"${c.name}"`)
    .join(', ');

  const query = `
    SELECT ${columnNames},
           AsGeoJSON(geometry) as geojson_geom,
           GeometryType(geometry) as geom_type
    FROM "${table.name}"
    WHERE geometry IS NOT NULL
    LIMIT 1000000;
  `;
  const rows = await db.exec(query).get.objs;
  const features: any[] = [];
  for (const row of rows) {
    if (!row.geojson_geom) continue;
    const properties: any = { _table: table.name, _layer: layerName, _layerConfig: layerConfig };
    for (const col of table.columns) {
      const key = col.name;
      if (key.toLowerCase() !== 'geometry' && key !== 'geojson_geom' && key !== 'geom_type') {
        properties[key] = row[key];
      }
    }
    features.push({ type: 'Feature', geometry: row.geojson_geom, properties });
  }
  return features;
}
