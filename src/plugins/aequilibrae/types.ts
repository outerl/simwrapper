export type GeometryType = 'polygon' | 'line' | 'point';

export interface LayerConfig {
  table: string;
  type: GeometryType;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  radius?: number;
  opacity?: number;
  zIndex?: number;
}

export interface VizDetails {
  title: string;
  description: string;
  database: string;
  view: 'table' | 'map' | '';
  layers: { [key: string]: LayerConfig };
}
