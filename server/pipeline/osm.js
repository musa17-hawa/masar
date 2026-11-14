// OpenStreetMap context for georeferenced trails, fetched once per build through the Overpass API:
// water sources, streams, huts/viewpoints, and mapped footpaths that can be adopted as the trail line.
// Network failures are never fatal — the trail simply builds without this layer.

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const WATER = { spring: 'spring', drinking_water: 'drinking_water', water_tap: 'drinking_water', water_well: 'well', fountain: 'fountain' };
const POI = { alpine_hut: 'hut', wilderness_hut: 'hut', shelter: 'shelter', viewpoint: 'viewpoint', picnic_site: 'picnic', peak: 'peak', camp_site: 'camp', toilets: 'toilets', parking: 'parking' };

export function buildQuery([south, west, north, east]) {
  const bb = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
  return `[out:json][timeout:25];(
    node["natural"="spring"](${bb});node["amenity"~"drinking_water|fountain|shelter|toilets"](${bb});
    node["man_made"~"water_tap|water_well"](${bb});node["tourism"~"alpine_hut|wilderness_hut|viewpoint|picnic_site|camp_site"](${bb});
    node["natural"="peak"](${bb});
    way["waterway"~"stream|river"](${bb});
    way["highway"~"path|footway|track|steps|bridleway"](${bb});
  );out body geom;`;
}

// `toLocal(lon, lat) -> [x, y]` converts into the trail's local metres.
export function parseOverpass(json, toLocal) {
  const out = { water: [], pois: [], streams: [], paths: [], fetchedAt: new Date().toISOString() };
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    if (el.type === 'node') {
      const [x, y] = toLocal(el.lon, el.lat);
      const waterKind = WATER[tags.natural] || WATER[tags.amenity] || WATER[tags.man_made];
      const poiKind = POI[tags.tourism] || POI[tags.amenity] || POI[tags.natural];
      const base = { x, y, name: tags.name || null };
      if (waterKind) out.water.push({ ...base, kind: waterKind, drinkable: tags.drinking_water === 'yes' || waterKind === 'drinking_water' });
      else if (poiKind) out.pois.push({ ...base, kind: poiKind, ele: tags.ele ? Number(tags.ele) : null });
    } else if (el.type === 'way' && Array.isArray(el.geometry)) {
      const pts = el.geometry.map((g) => { const [x, y] = toLocal(g.lon, g.lat); return { x, y }; });
      if (pts.length < 2) continue;
      if (tags.waterway) out.streams.push({ name: tags.name || null, kind: tags.waterway, pts });
      else if (tags.highway) out.paths.push({ id: el.id, name: tags.name || null, kind: tags.highway, sac: tags.sac_scale || null, surface: tags.surface || null,
        visibility: tags.trail_visibility || null, pts });
    }
  }
  return out;
}

export async function fetchOsm(bboxWgs, toLocal) {
  const body = `data=${encodeURIComponent(buildQuery(bboxWgs))}`;
  let lastError;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Masar trail viewer (course project)' },
        signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
      return parseOverpass(await res.json(), toLocal);
    } catch (err) { lastError = err; }
  }
  throw lastError;
}
