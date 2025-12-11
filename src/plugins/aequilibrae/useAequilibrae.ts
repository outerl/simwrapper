import SPL from 'spl.js';
import YAML from 'yaml';
import type { VizDetails, LayerConfig } from './types';
import { getTableNames, getTableSchema, getRowCount, fetchGeoJSONFeatures } from './db';

export async function initSql() {
  const spl = await SPL();
  return spl;
}

export async function openDb(spl: any, arrayBuffer: ArrayBuffer) {
  return spl.db(arrayBuffer);
}

export async function parseYamlConfig(yamlText: string, subfolder: string | null): Promise<VizDetails> {
  const config = YAML.parse(yamlText);
  const dbFile = config.database || config.file;
  if (!dbFile) throw new Error('No database field found in YAML config');
  const databasePath = dbFile.startsWith('/') ? dbFile : subfolder ? `${subfolder}/${dbFile}` : dbFile;
  return {
    title: config.title || dbFile,
    description: config.description || '',
    database: databasePath,
    view: config.view || '',
    layers: config.layers || {},
  };
}

export async function buildTables(db: any, layerConfigs: { [k: string]: LayerConfig }, allNames?: string[]) {
  const names = allNames ?? (await getTableNames(db));
  const select = Object.keys(layerConfigs).length
    ? [...new Set(Object.values(layerConfigs).map((c) => c.table))]
    : ['nodes', 'links', 'zones'];

  const tables: Array<{ name: string; type: string; rowCount: number; columns: any[] }> = [];
  let hasGeometry = false;

  for (const name of names) {
    if (!select.includes(name)) continue;
    const schema = await getTableSchema(db, name);
    const rowCount = await getRowCount(db, name);
    const hasGeomCol = schema.some((c: any) => c.name.toLowerCase() === 'geometry');
    if (hasGeomCol) hasGeometry = true;
    tables.push({ name, type: 'table', rowCount, columns: schema });
  }
  return { tables, hasGeometry };
}

export async function buildGeoFeatures(db: any, tables: any[], layerConfigs: { [k: string]: LayerConfig }) {
  const plain = JSON.parse(JSON.stringify(layerConfigs));
  const layersToProcess = Object.keys(plain).length
    ? Object.entries(plain)
    : tables
        .filter((t) => t.columns.some((c: any) => c.name.toLowerCase() === 'geometry'))
        .map((t) => [t.name, { table: t.name, type: 'line' as const }]);

  const features: any[] = [];
  for (const [layerName, cfg] of layersToProcess as any) {
    const tableName = (cfg as LayerConfig).table || layerName;
    const table = tables.find((t) => t.name === tableName);
    if (!table) continue;
    if (!table.columns.some((c: any) => c.name.toLowerCase() === 'geometry')) continue;
    const layerFeatures = await fetchGeoJSONFeatures(db, table, layerName, cfg);
    features.push(...layerFeatures);
  }
  return features;
}
