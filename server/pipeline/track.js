// GPS tracks (GPX / KML / GeoJSON) and polyline helpers.
import fs from 'node:fs';
import path from 'node:path';

export const TRACK_EXT = ['.gpx', '.kml', '.geojson', '.json'];

// Returns [{lon, lat, ele}] from a track file, in file order.
export function parseTrack(file) {
  const text = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  const pts = [];
  if (ext === '.gpx' || /<gpx[\s>]/i.test(text)) {
    const tags = ['trkpt', 'rtept'];
    for (const tag of tags) {
      const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
      let m;
      while ((m = re.exec(text))) {
        const lat = /lat\s*=\s*["']([-\d.eE+]+)["']/.exec(m[1]);
        const lon = /lon\s*=\s*["']([-\d.eE+]+)["']/.exec(m[1]);
        if (!lat || !lon) continue;
        const ele = m[2] ? /<ele>\s*([-\d.eE+]+)\s*<\/ele>/i.exec(m[2]) : null;
        pts.push({ lon: +lon[1], lat: +lat[1], ele: ele ? +ele[1] : null });
      }
      if (pts.length) break;
    }
  } else if (ext === '.kml' || /<kml[\s>]/i.test(text)) {
    let best = [];
    const re = /<LineString[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi;
    let m;
    while ((m = re.exec(text))) {
      const line = m[1].trim().split(/\s+/).map((s) => s.split(',').map(Number)).filter((c) => c.length >= 2 && !Number.isNaN(c[0]) && !Number.isNaN(c[1]));
      if (line.length > best.length) best = line;
    }
    const track = [...text.matchAll(/<gx:coord>\s*([-\d.eE+]+)\s+([-\d.eE+]+)(?:\s+([-\d.eE+]+))?\s*<\/gx:coord>/gi)].map((c) => [+c[1], +c[2], c[3] ? +c[3] : NaN]);
    if (track.length > best.length) best = track;
    for (const c of best) pts.push({ lon: c[0], lat: c[1], ele: Number.isFinite(c[2]) ? c[2] : null });
  } else {
    const gj = JSON.parse(text);
    let best = [];
    const visit = (g) => {
      if (!g) return;
      if (g.type === 'FeatureCollection') g.features.forEach((f) => visit(f.geometry));
      else if (g.type === 'Feature') visit(g.geometry);
      else if (g.type === 'GeometryCollection') g.geometries.forEach(visit);
      else if (g.type === 'LineString' && g.coordinates.length > best.length) best = g.coordinates;
      else if (g.type === 'MultiLineString') { const flat = g.coordinates.flat(); if (flat.length > best.length) best = flat; }
    };
    visit(gj);
    for (const c of best) pts.push({ lon: c[0], lat: c[1], ele: c.length > 2 ? c[2] : null });
  }
  return pts.filter((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
}

// Resample a 2D polyline [{x,y}] to (roughly) uniform spacing.
export function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += step;
    }
    carry = len - (d - step);
  }
  const last = pts[pts.length - 1], tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > step * 0.25) out.push({ x: last.x, y: last.y });
  return out;
}

// Moving-average smoothing that keeps the end points fixed.
export function smooth(pts, radius) {
  if (radius < 1 || pts.length < 3) return pts;
  const out = pts.map((p) => ({ ...p }));
  for (let i = 1; i < pts.length - 1; i++) {
    const r = Math.min(radius, i, pts.length - 1 - i);
    let sx = 0, sy = 0;
    for (let k = i - r; k <= i + r; k++) { sx += pts[k].x; sy += pts[k].y; }
    out[i].x = sx / (2 * r + 1); out[i].y = sy / (2 * r + 1);
  }
  return out;
}

export function polylineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}
