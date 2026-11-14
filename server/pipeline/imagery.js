// Fetches an aerial image for a trail's bounding box so nobody has to hunt for orthophotos:
//   Swiss coordinates  → swisstopo SWISSIMAGE through the federal WMS (free, attribution required)
//   everything else    → Esri World Imagery export service (check Esri's terms before public use)
// The image is requested directly in the trail's own coordinate system, so it lines up with the points.

export function imageryRequest({ epsg, bounds, maxSize = 4096 }) {
  const { minX, minY, maxX, maxY } = bounds;
  const wM = maxX - minX, hM = maxY - minY;
  const scale = Math.min(maxSize / wM, maxSize / hM, 10);          // at most 10 px per metre
  const width = Math.max(64, Math.round(wM * scale)), height = Math.max(64, Math.round(hM * scale));
  if (epsg === 2056 || epsg === 21781) {
    const q = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: 'ch.swisstopo.swissimage', STYLES: '',
      CRS: `EPSG:${epsg}`, BBOX: `${minX},${minY},${maxX},${maxY}`, WIDTH: width, HEIGHT: height, FORMAT: 'image/jpeg' });
    return { url: `https://wms.geo.admin.ch/?${q}`, attribution: '© swisstopo', provider: 'swisstopo SWISSIMAGE' };
  }
  const q = new URLSearchParams({ bbox: `${minX},${minY},${maxX},${maxY}`, bboxSR: epsg, imageSR: epsg, size: `${width},${height}`, format: 'jpg', f: 'image' });
  return { url: `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?${q}`,
    attribution: 'Esri, Maxar, Earthstar Geographics', provider: 'Esri World Imagery' };
}

export async function fetchImagery(opts) {
  const req = imageryRequest(opts);
  const res = await fetch(req.url, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'Masar trail viewer (course project)' } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) throw new Error(`Imagery service answered ${res.status} ${type}`);
  return { data: Buffer.from(await res.arrayBuffer()), type, ...req };
}
