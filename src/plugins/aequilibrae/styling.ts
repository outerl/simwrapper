export function parseColor(colorString?: string): { r: number; g: number; b: number } {
  if (!colorString) return { r: 89, g: 161, b: 79 };
  if (colorString.startsWith('#')) {
    if (colorString.length === 4) {
      const r = colorString[1];
      const g = colorString[2];
      const b = colorString[3];
      return {
        r: parseInt(r + r, 16),
        g: parseInt(g + g, 16),
        b: parseInt(b + b, 16),
      };
    }
    const hex = colorString.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { r, g, b };
  }
  return { r: 89, g: 161, b: 79 };
}

export function buildStyleArrays(features: any[], defaultOpacity = 0.8) {
  const n = features.length;
  const fillColors = new Uint8ClampedArray(n * 4);
  const lineColors = new Uint8ClampedArray(n * 3);
  const lineWidths = new Float32Array(n);
  const pointRadii = new Float32Array(n);

  features.forEach((feature, i) => {
    const cfg = feature?.properties?._layerConfig || {};
    const geomType = (feature?.geometry?.type || '').toLowerCase();

    const fill = parseColor(cfg.fillColor || '#59a14f');
    fillColors[i * 4 + 0] = fill.r;
    fillColors[i * 4 + 1] = fill.g;
    fillColors[i * 4 + 2] = fill.b;
    fillColors[i * 4 + 3] = Math.round((cfg.opacity ?? defaultOpacity) * 255);

    const stroke = parseColor(cfg.strokeColor || cfg.fillColor || '#4e79a7');
    lineColors[i * 3 + 0] = stroke.r;
    lineColors[i * 3 + 1] = stroke.g;
    lineColors[i * 3 + 2] = stroke.b;

    if (cfg.strokeWidth !== undefined) lineWidths[i] = cfg.strokeWidth;
    else if (geomType.includes('polygon')) lineWidths[i] = 1;
    else if (geomType.includes('line')) lineWidths[i] = 3;
    else lineWidths[i] = 2;

    pointRadii[i] = cfg.radius ?? 4;
  });

  const featureFilter = new Float32Array(n).fill(1);
  return { fillColors, lineColors, lineWidths, pointRadii, featureFilter };
}
