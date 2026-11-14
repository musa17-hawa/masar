// The build pipeline. Runs in a worker thread so the web server stays responsive.
//   raw files → (unzip) → crop to the trail → thin to a point budget → ground model → trail line → report
// Outputs in <trail>/out: points.bin.gz, dem.bin.gz, analysis.bin.gz, meta.json, report.json, osm.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CLOUD_EXT, extractZip, inspectCloud, readCloud } from './readers.js';
import { fillHoles, groundFromLowest, minMaxFilter, bilinear } from './grid.js';
import { analyze, autoCenterline } from './analyze.js';
import { parseTrack, polylineLength } from './track.js';
import { getProjection, guessEpsg } from '../geo/proj.js';
import { fetchOsm } from './osm.js';
import { readExifGps } from './exif.js';

const userError = (code, message) => Object.assign(new Error(message), { code, userFacing: true });
const NOISE = new Set([7, 18]);

class VoxelSet {
  constructor(expected) {
    let cap = 1024; while (cap < expected * 2.6) cap *= 2;
    this.keys = new Float64Array(cap).fill(-1); this.mask = cap - 1; this.size = 0;
  }
  add(key) {
    const lo = key % 4294967296 >>> 0, hi = (key / 4294967296) >>> 0;
    let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b); h ^= h >>> 15;
    let i = h & this.mask;
    for (;;) {
      const k = this.keys[i];
      if (k === -1) { this.keys[i] = key; this.size++; return true; }
      if (k === key) return false;
      i = (i + 1) & this.mask;
    }
  }
}

function mulberry32(seed) {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const gz = (buf) => zlib.gzipSync(buf, { level: 5 });
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj));

export async function build({ trailDir, trail, cfg }, progress = () => {}) {
  const outDir = path.join(trailDir, 'out'), tmpDir = path.join(trailDir, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const opt = trail.options || {};
  const warnings = [];
  const rawPath = (f) => path.join(trailDir, 'raw', f.stored);

  try {
    // 1 ── gather the point-cloud files (unzipping where needed)
    progress('prepare', 0.02);
    const clouds = [];
    for (const f of trail.files.filter((x) => x.kind === 'cloud')) {
      const ext = path.extname(f.name).toLowerCase();
      if (ext === '.zip') clouds.push(...await extractZip(rawPath(f), tmpDir));
      else if (CLOUD_EXT.includes(ext)) clouds.push(rawPath(f));
    }
    if (!clouds.length) throw userError('no_cloud', 'No point-cloud file was found. Upload a LAS, LAZ, PLY or XYZ file (zipped LAS is fine).');
    const infos = [];
    for (const c of clouds) infos.push({ file: c, ...(await inspectCloud(c)) });

    // 2 ── coordinate system
    let epsg = Number(opt.epsg) || infos.find((i) => i.epsg)?.epsg || null;
    const headerBounds = infos.every((i) => i.bounds && i.bounds.maxX > i.bounds.minX) ? infos.reduce((b, i) => ({
      minX: Math.min(b.minX, i.bounds.minX), maxX: Math.max(b.maxX, i.bounds.maxX), minY: Math.min(b.minY, i.bounds.minY), maxY: Math.max(b.maxY, i.bounds.maxY),
      minZ: Math.min(b.minZ, i.bounds.minZ), maxZ: Math.max(b.maxZ, i.bounds.maxZ) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }) : null;
    if (!epsg && opt.epsg !== 'local') epsg = guessEpsg(headerBounds);
    const proj = epsg ? getProjection(epsg) : null;
    if (epsg && !proj) warnings.push({ code: 'crs_unsupported', epsg });
    const georef = !!epsg;

    // 3 ── first pass when bounds are unknown or the up-axis has to be detected
    let raw = headerBounds, total = infos.reduce((s, i) => s + (i.count || 0), 0), swapYZ = false;
    if (!georef || !raw) {
      progress('scan', 0.05);
      raw = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
      total = 0;
      // Which axis is "up"? Ground is a thin sheet: in columns along the true up-axis most points sit
      // within a few centimetres of each other. Measure that for both candidates (Z-up and Y-up).
      const colZ = new Map(), colY = new Map(), CELL = 0.5;
      const SAMPLE = 262144, sxs = new Float64Array(SAMPLE), sys = new Float64Array(SAMPLE), szs = new Float64Array(SAMPLE);
      let sn = 0, stride = 1, seenLocal = 0;
      const note = (map, a, b, v) => {
        const key = Math.floor(a / CELL) * 73856093 + Math.floor(b / CELL) * 19349663;
        const e = map.get(key);
        if (!e) { if (map.size < 150000) map.set(key, [v, v]); } else { if (v < e[0]) e[0] = v; if (v > e[1]) e[1] = v; }
      };
      for (const c of clouds) await readCloud(c, (ch) => {
        for (let i = 0; i < ch.n; i++) {
          const x = ch.x[i], y = ch.y[i], z = ch.z[i];
          if (x < raw.minX) raw.minX = x; if (x > raw.maxX) raw.maxX = x;
          if (y < raw.minY) raw.minY = y; if (y > raw.maxY) raw.maxY = y;
          if (z < raw.minZ) raw.minZ = z; if (z > raw.maxZ) raw.maxZ = z;
          if (!georef && (i & 3) === 0) { note(colZ, x, y, z); note(colY, x, z, y); }
          if (!georef && (seenLocal++ % stride) === 0) {
            if (sn === SAMPLE) { for (let k = 0; k < SAMPLE / 2; k++) { sxs[k] = sxs[k * 2]; sys[k] = sys[k * 2]; szs[k] = szs[k * 2]; } sn = SAMPLE / 2; stride *= 2; }
            sxs[sn] = x; sys[sn] = y; szs[sn] = z; sn++;
          }
        }
        total += ch.n;
      });
      if (!total) throw userError('empty_cloud', 'The point cloud contains no points.');
      if (!georef && sn > 2000) {
        // Scans often carry a few stray points far from everything else; trim the extent to where the data really is.
        const trim = (arr, lo, hi) => { const v = Float64Array.from(arr.subarray(0, sn)).sort(); return [Math.max(lo, v[Math.floor(sn * 0.0005)] - 0.3), Math.min(hi, v[Math.min(sn - 1, Math.ceil(sn * 0.9995))] + 0.3)]; };
        [raw.minX, raw.maxX] = trim(sxs, raw.minX, raw.maxX); [raw.minY, raw.maxY] = trim(sys, raw.minY, raw.maxY); [raw.minZ, raw.maxZ] = trim(szs, raw.minZ, raw.maxZ);
      }
      if (!georef) {
        const median = (map) => { const v = [...map.values()].map((e) => e[1] - e[0]).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : Infinity; };
        swapYZ = opt.upAxis === 'y' || (opt.upAxis !== 'z' && median(colY) < median(colZ) * 0.8);
        if (swapYZ) raw = { minX: raw.minX, maxX: raw.maxX, minY: -raw.maxZ, maxY: -raw.minZ, minZ: raw.minY, maxZ: raw.maxY };
      }
    }

    // 4 ── GPS line (if any) and the region to keep
    let gps = null, trackCrs = null;
    for (const f of trail.files.filter((x) => x.kind === 'track')) {
      try { const pts = parseTrack(rawPath(f)); if (pts.length >= 2 && (!gps || pts.length > gps.length)) gps = pts; }
      catch { warnings.push({ code: 'track_unreadable', file: f.name }); }
    }
    if (gps && proj) trackCrs = gps.map((p) => { const [x, y] = proj.fromWgs(p.lon, p.lat); return { x, y }; });
    let crop = { minX: raw.minX, maxX: raw.maxX, minY: raw.minY, maxY: raw.maxY };
    const corridor = Math.max(10, Math.min(500, Number(opt.corridor) || 60));
    let useMask = false;
    if (trackCrs) {
      const inside = trackCrs.filter((p) => p.x >= raw.minX && p.x <= raw.maxX && p.y >= raw.minY && p.y <= raw.maxY);
      if (inside.length < 2) { warnings.push({ code: 'track_outside' }); trackCrs = null; }
      else {
        const xs = inside.map((p) => p.x), ys = inside.map((p) => p.y);
        crop = { minX: Math.max(raw.minX, Math.min(...xs) - corridor), maxX: Math.min(raw.maxX, Math.max(...xs) + corridor),
          minY: Math.max(raw.minY, Math.min(...ys) - corridor), maxY: Math.min(raw.maxY, Math.max(...ys) + corridor) };
        useMask = true;
      }
    } else if (proj && opt.aoi && Number.isFinite(+opt.aoi.lat) && Number.isFinite(+opt.aoi.lon)) {
      const [cx, cy] = proj.fromWgs(+opt.aoi.lon, +opt.aoi.lat), r = Math.max(20, Math.min(1000, +opt.aoi.radius || 150));
      const c2 = { minX: Math.max(raw.minX, cx - r), maxX: Math.min(raw.maxX, cx + r), minY: Math.max(raw.minY, cy - r), maxY: Math.min(raw.maxY, cy + r) };
      if (c2.maxX > c2.minX && c2.maxY > c2.minY) crop = c2; else warnings.push({ code: 'aoi_outside' });
    }
    const ox = Math.floor(crop.minX), oy = Math.floor(crop.minY);
    const W = crop.maxX - ox, H = crop.maxY - oy;
    if (!(W > 0 && H > 0)) throw userError('empty_cloud', 'The point cloud has no extent.');
    const fine = !georef || opt.source === 'phone' || Math.max(W, H) < 120;
    const cell = Math.max(fine ? 0.05 : 0.5, Math.max(W, H) / cfg.demMaxCells);
    const w = Math.max(2, Math.ceil(W / cell)), h = Math.max(2, Math.ceil(H / cell));

    const MC = 4, mw = Math.ceil(W / MC) + 1, mh = Math.ceil(H / MC) + 1;
    let mask = null;
    if (useMask) {
      mask = new Uint8Array(mw * mh);
      const r = Math.ceil(corridor / MC);
      for (let i = 1; i < trackCrs.length; i++) {
        const a = trackCrs[i - 1], b = trackCrs[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
        for (let s = 0; s <= steps; s++) {
          const cx = Math.floor((a.x + (b.x - a.x) * s / steps - ox) / MC), cy = Math.floor((a.y + (b.y - a.y) * s / steps - oy) / MC);
          for (let yy = Math.max(0, cy - r); yy <= Math.min(mh - 1, cy + r); yy++) for (let xx = Math.max(0, cx - r); xx <= Math.min(mw - 1, cx + r); xx++)
            if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) mask[yy * mw + xx] = 1;
        }
      }
    }

    // 5 ── main pass: crop, build the height grids, thin the points
    progress('read', 0.08);
    const budget = cfg.pointBudget;
    let voxel = fine ? 0.02 : 0.2;
    const zRef = raw.minZ;
    let set = new VoxelSet(budget * 2);
    let cap = 1 << 18, kept = 0;
    let kx = new Float32Array(cap), ky = new Float32Array(cap), kz = new Float32Array(cap), krgb = new Uint8Array(cap * 3), kcls = new Uint8Array(cap);
    const grow = () => {
      cap *= 2;
      const g = (A, n = 1) => { const B = new A.constructor(cap * n); B.set(A); return B; };
      kx = g(kx); ky = g(ky); kz = g(kz); krgb = g(krgb, 3); kcls = g(kcls);
    };
    let vnx = Math.ceil(W / voxel) + 1, vny = Math.ceil(H / voxel) + 1;
    const keyOf = (x, y, z) => Math.floor(x / voxel) + vnx * (Math.floor(y / voxel) + vny * Math.max(0, Math.floor(z / voxel)));
    const revoxel = (factor) => {
      voxel *= factor; vnx = Math.ceil(W / voxel) + 1; vny = Math.ceil(H / voxel) + 1;
      set = new VoxelSet(budget * 2);
      let j = 0;
      for (let i = 0; i < kept; i++) if (set.add(keyOf(kx[i], ky[i], kz[i]))) {
        kx[j] = kx[i]; ky[j] = ky[i]; kz[j] = kz[i]; kcls[j] = kcls[i];
        krgb[j * 3] = krgb[i * 3]; krgb[j * 3 + 1] = krgb[i * 3 + 1]; krgb[j * 3 + 2] = krgb[i * 3 + 2]; j++;
      }
      kept = j;
    };
    const gmin = new Float32Array(w * h).fill(NaN), amin = new Float32Array(w * h).fill(NaN), amax = new Float32Array(w * h).fill(NaN);
    let anyRGB = false, anyClass = false, groundPts = 0, vegPts = 0, seen = 0, used = 0;
    for (const c of clouds) await readCloud(c, (ch) => {
      const hasCol = !!ch.r && ch.colourValid !== false, hasCls = !!ch.cls;
      for (let i = 0; i < ch.n; i++) {
        let X = ch.x[i], Y = ch.y[i], Z = ch.z[i];
        if (swapYZ) { const t = Y; Y = -Z; Z = t; }
        const x = X - ox, y = Y - oy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (mask && !mask[Math.floor(y / MC) * mw + Math.floor(x / MC)]) continue;
        const cls = hasCls ? ch.cls[i] : 0;
        if (NOISE.has(cls)) continue;
        const z = Z - zRef;
        if (z < 0 || Z > raw.maxZ) { if (!georef) continue; }
        used++;
        const gi = Math.min(h - 1, Math.floor(y / cell)) * w + Math.min(w - 1, Math.floor(x / cell));
        if (!(amin[gi] <= z)) amin[gi] = z;
        if (!(amax[gi] >= z)) amax[gi] = z;
        if (cls === 2) { groundPts++; if (!(gmin[gi] <= z)) gmin[gi] = z; }
        else if (cls >= 3 && cls <= 5) vegPts++;
        if (!set.add(keyOf(x, y, z))) continue;
        if (kept === cap) grow();
        kx[kept] = x; ky[kept] = y; kz[kept] = z; kcls[kept] = cls;
        if (hasCol) { krgb[kept * 3] = ch.r[i]; krgb[kept * 3 + 1] = ch.g[i]; krgb[kept * 3 + 2] = ch.b[i]; if (ch.r[i] | ch.g[i] | ch.b[i]) anyRGB = true; }
        if (cls) anyClass = true;
        kept++;
        if (kept >= budget * 2) revoxel(1.35);
      }
      seen += ch.n;
      progress('read', 0.08 + 0.6 * Math.min(1, seen / Math.max(1, total)));
    });
    if (kept < 100) throw userError('too_few_points', used ? 'Too few points fall inside the selected area.' : 'No points fall inside the selected area. Check that the track and the point cloud cover the same place.');
    while (kept > budget) revoxel(1.2);

    // 6 ── ground model
    progress('ground', 0.7);
    let observed = 0, groundCells = 0;
    const obs = new Uint8Array(w * h);
    for (let i = 0; i < obs.length; i++) { if (!Number.isNaN(amin[i])) { obs[i] = 1; observed++; } if (!Number.isNaN(gmin[i])) groundCells++; }
    const classified = groundPts > 1000 && groundCells > observed * 0.2;
    const nearObs = minMaxFilter(Float32Array.from(obs), w, h, fine ? 4 : 3, false);
    let G = classified ? fillHoles(gmin, w, h) : groundFromLowest(amin, w, h, cell, fine ? { maxWindow: 1.0, slope: 0.8, dh0: 0.06 } : { maxWindow: 12, slope: 0.6, dh0: 0.4 });
    let S;
    if (classified) S = G;
    else { const lowest = fillHoles(amin, w, h); S = new Float32Array(w * h); for (let i = 0; i < S.length; i++) S[i] = Math.min(lowest[i], G[i] + 0.3); }
    const canopy = new Float32Array(w * h).fill(NaN);
    let tall = 0;
    for (let i = 0; i < G.length; i++) {
      if (!nearObs[i]) { G[i] = NaN; if (S !== G) S[i] = NaN; continue; }
      if (obs[i]) { canopy[i] = amax[i] - G[i]; if (canopy[i] > 3) tall++; }
    }
    const hasCanopy = !fine && (vegPts > 1000 || tall > observed * 0.02);
    const at = (g, x, y) => bilinear(g, w, h, x / cell - 0.5, y / cell - 0.5);

    // 7 ── classes for clouds that came without any (phone scans): ground / object / overhead
    if (!anyClass || !classified) {
      for (let i = 0; i < kept; i++) {
        if (kcls[i] && classified) continue;
        const hgt = kz[i] - at(G, kx[i], ky[i]);
        kcls[i] = !(hgt >= (fine ? 0.08 : 0.5)) ? 2 : hgt > 2 ? 5 : fine ? 1 : 3;
      }
    }

    // 8 ── write the 3D data
    progress('pack', 0.8);
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < kept; i++) { if (kz[i] < zMin) zMin = kz[i]; if (kz[i] > zMax) zMax = kz[i]; }
    const oz = Math.floor(zRef + zMin);
    const zShift = zRef - oz;                      // local z = (absolute z) − oz
    const pMin = [0, 0, zMin + zShift], pMax = [W, H, zMax + zShift];
    const order = new Uint32Array(kept);
    for (let i = 0; i < kept; i++) order[i] = i;
    const rnd = mulberry32(1234567);
    for (let i = kept - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    const pos = new Uint16Array(kept * 3), col = new Uint8Array(kept * 4);
    const qz = 65535 / Math.max(1e-6, pMax[2] - pMin[2]);
    const classCount = {};
    for (let k = 0; k < kept; k++) {
      const i = order[k];
      pos[k * 3] = Math.min(65535, kx[i] / W * 65535); pos[k * 3 + 1] = Math.min(65535, ky[i] / H * 65535); pos[k * 3 + 2] = Math.min(65535, (kz[i] + zShift - pMin[2]) * qz);
      col[k * 4] = krgb[i * 3]; col[k * 4 + 1] = krgb[i * 3 + 1]; col[k * 4 + 2] = krgb[i * 3 + 2]; col[k * 4 + 3] = kcls[i];
      classCount[kcls[i]] = (classCount[kcls[i]] || 0) + 1;
    }
    fs.writeFileSync(path.join(outDir, 'points.bin.gz'), gz(Buffer.concat([Buffer.from(pos.buffer), Buffer.from(col.buffer)])));

    let gMin = Infinity, gMax = -Infinity;
    for (let i = 0; i < G.length; i++) { const v = G[i]; if (!Number.isNaN(v)) { if (v < gMin) gMin = v; if (v > gMax) gMax = v; } }
    const dem = new Uint16Array(w * h), qd = 65534 / Math.max(1e-6, gMax - gMin);
    for (let i = 0; i < G.length; i++) dem[i] = Number.isNaN(G[i]) ? 65535 : Math.round((G[i] - gMin) * qd);
    fs.writeFileSync(path.join(outDir, 'dem.bin.gz'), gz(Buffer.from(dem.buffer)));
    // grids kept server-side so the report can be recomputed when the trail line changes (z shifted to local)
    for (let i = 0; i < G.length; i++) { G[i] += zShift; if (S !== G) S[i] += zShift; }
    fs.writeFileSync(path.join(outDir, 'analysis.bin.gz'), zlib.gzipSync(Buffer.concat([Buffer.from(G.buffer), Buffer.from(S.buffer.slice(0)), Buffer.from(canopy.buffer), Buffer.from(obs.buffer)]), { level: 1 }));

    // 9 ── trail line
    progress('trail', 0.86);
    let line = null, lineSource = null;
    if (Array.isArray(opt.path) && opt.path.length >= 2) { line = opt.path.map((p) => ({ x: +p[0], y: +p[1] })); lineSource = 'drawn'; }
    else if (trackCrs) { line = trackCrs.map((p) => ({ x: p.x - ox, y: p.y - oy })).filter((p) => p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H); lineSource = 'track'; }
    else if (fine) {
      const walkable = new Uint8Array(w * h);
      for (let i = 0; i < walkable.length; i++) walkable[i] = obs[i] && amin[i] + zShift - G[i] < 0.25 ? 1 : 0;
      line = autoCenterline(walkable, { w, h, cell });
      if (line) {
        lineSource = 'auto';
        const sx = -ox, sy = -oy;   // the scanner's own origin is where the scan started
        const a = line[0], b = line[line.length - 1];
        if (Math.hypot(b.x - sx, b.y - sy) < Math.hypot(a.x - sx, a.y - sy)) line.reverse();
      }
    }

    // 10 ── OpenStreetMap context
    let osm = null;
    const toLocal = proj ? (lon, lat) => { const [x, y] = proj.fromWgs(lon, lat); return [x - ox, y - oy]; } : null;
    let wgs = null;
    if (proj) {
      const corners = [[ox, oy], [ox + W, oy], [ox, oy + H], [ox + W, oy + H]].map(([x, y]) => proj.toWgs(x, y));
      const lons = corners.map((c) => c[0]), lats = corners.map((c) => c[1]);
      wgs = { south: Math.min(...lats), west: Math.min(...lons), north: Math.max(...lats), east: Math.max(...lons) };
      wgs.center = proj.toWgs(ox + W / 2, oy + H / 2);
      if (cfg.allowNetwork && !opt.synthetic) {
        progress('context', 0.88);
        try { osm = await fetchOsm([wgs.south - 0.0015, wgs.west - 0.002, wgs.north + 0.0015, wgs.east + 0.002], toLocal); writeJson(path.join(outDir, 'osm.json'), osm); }
        catch (err) { warnings.push({ code: 'osm_unavailable', detail: String(err.message || err) }); }
      }
    } else if (gps) wgs = { center: [gps[0].lon, gps[0].lat] };

    // 11 ── report
    progress('analyze', 0.9);
    const grid = { w, h, cell };
    const points = { n: kept, x: kx, y: ky, z: Float32Array.from(kz.subarray(0, kept), (v) => v + zShift), cls: kcls };
    const report = analyze({ grid, G, S, canopy, points, path: line, fine, hasCanopy, osm, zBase: oz });
    report.lineSource = report.hasPath ? lineSource : null;

    // 12 ── photos: pin them to the trail (by GPS for georeferenced trails, otherwise by progress along the GPS line)
    const photos = [];
    const photoFiles = trail.files.filter((x) => x.kind === 'photo');
    const gpsLocal = gps ? gps.map((p) => ({ x: p.lon * 111320 * Math.cos(gps[0].lat * Math.PI / 180), y: p.lat * 110540 })) : null;
    const gpsLen = gpsLocal ? polylineLength(gpsLocal) : 0;
    photoFiles.forEach((f, idx) => {
      const g = (f.meta && Number.isFinite(f.meta.lat) ? f.meta : null) || readExifGps(rawPath(f));
      const entry = { id: f.id, name: f.name, lat: g?.lat ?? null, lon: g?.lon ?? null, heading: g?.heading ?? null, x: null, y: null, z: null, d: null };
      if (g && toLocal) {
        const [x, y] = toLocal(g.lon, g.lat);
        if (x >= 0 && y >= 0 && x <= W && y <= H) { entry.x = +x.toFixed(2); entry.y = +y.toFixed(2); entry.z = +(at(G, x, y) || 0).toFixed(2); }
      } else if (report.hasPath) {
        let frac = photoFiles.length > 1 ? idx / (photoFiles.length - 1) : 0.5;
        if (g && gpsLocal && gpsLen > 5) {
          const px = g.lon * 111320 * Math.cos(gps[0].lat * Math.PI / 180), py = g.lat * 110540;
          let best = Infinity, run = 0, bestRun = 0;
          for (let i = 0; i < gpsLocal.length; i++) {
            if (i) run += Math.hypot(gpsLocal[i].x - gpsLocal[i - 1].x, gpsLocal[i].y - gpsLocal[i - 1].y);
            const dd = Math.hypot(gpsLocal[i].x - px, gpsLocal[i].y - py);
            if (dd < best) { best = dd; bestRun = run; }
          }
          frac = bestRun / gpsLen;
        }
        const L = report.line, k = Math.min(L.x.length - 1, Math.round(frac * (L.x.length - 1)));
        entry.x = L.x[k]; entry.y = L.y[k]; entry.z = L.z[k]; entry.d = L.d[k]; entry.approx = true;
      }
      photos.push(entry);
    });

    const meta = {
      version: 1, id: trail.id, name: trail.name, source: opt.source || (fine ? 'phone' : 'aerial'), fine, georef, synthetic: !!opt.synthetic,
      crs: epsg ? { epsg, name: proj?.name || `EPSG:${epsg}` } : null,
      origin: [ox, oy, oz], size: [W, H], wgs,
      points: { count: kept, read: seen, used, voxel: +voxel.toFixed(3), min: pMin, max: pMax, hasRGB: anyRGB, hasClass: anyClass || true, derivedClasses: !classified, classes: classCount },
      dem: { w, h, cell, zMin: gMin + zShift, zMax: gMax + zShift, classified },
      hasCanopy, lineSource: report.lineSource, hasOsm: !!osm, osmPaths: osm ? osm.paths.length : 0,
      photos, texture: null, warnings, builtAt: new Date().toISOString(),
    };
    // keep a texture that was already attached (rebuilds) if it still exists
    const prev = fs.existsSync(path.join(outDir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8')) : null;
    if (prev?.texture && prev.origin?.[0] === ox && prev.origin?.[1] === oy && fs.existsSync(path.join(outDir, prev.texture.file))) meta.texture = prev.texture;
    if (opt.texture && fs.existsSync(path.join(outDir, opt.texture.file))) meta.texture = opt.texture;
    writeJson(path.join(outDir, 'report.json'), report);
    writeJson(path.join(outDir, 'meta.json'), meta);
    progress('done', 1);
    return summarize(meta, report);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function summarize(meta, report) {
  return { points: meta.points.count, fine: meta.fine, georef: meta.georef, hasPath: report.hasPath, lineSource: report.lineSource,
    lengthM: report.summary?.lengthM ?? null, ascentM: report.summary?.ascentM ?? null, descentM: report.summary?.descentM ?? null,
    minutes: report.time?.minutes ?? null, level: report.difficulty?.level ?? null, score: report.difficulty?.score ?? null,
    center: meta.wgs?.center ?? null, crs: meta.crs?.epsg ?? null, warnings: meta.warnings };
}

// Recompute only the report after the trail line changed (drawn in the viewer or adopted from OpenStreetMap).
export async function reanalyze({ trailDir, linePoints }) {
  const outDir = path.join(trailDir, 'out');
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  const { w, h, cell } = meta.dem, n = w * h;
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(outDir, 'analysis.bin.gz')));
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const G = new Float32Array(ab, 0, n), S = new Float32Array(ab, n * 4, n), canopy = new Float32Array(ab, n * 8, n);
  const pr = zlib.gunzipSync(fs.readFileSync(path.join(outDir, 'points.bin.gz')));
  const pb = pr.buffer.slice(pr.byteOffset, pr.byteOffset + pr.byteLength);
  const count = meta.points.count, pos = new Uint16Array(pb, 0, count * 3), col = new Uint8Array(pb, count * 6, count * 4);
  const [W, H] = meta.size, zr = meta.points.max[2] - meta.points.min[2];
  const points = { n: count, x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count), cls: new Uint8Array(count) };
  for (let i = 0; i < count; i++) {
    points.x[i] = pos[i * 3] / 65535 * W; points.y[i] = pos[i * 3 + 1] / 65535 * H; points.z[i] = meta.points.min[2] + pos[i * 3 + 2] / 65535 * zr; points.cls[i] = col[i * 4 + 3];
  }
  const osmFile = path.join(outDir, 'osm.json');
  const osm = fs.existsSync(osmFile) ? JSON.parse(fs.readFileSync(osmFile, 'utf8')) : null;
  const report = analyze({ grid: { w, h, cell }, G, S, canopy, points, path: linePoints.map((p) => ({ x: +p[0], y: +p[1] })), fine: meta.fine, hasCanopy: meta.hasCanopy, osm, zBase: meta.origin[2] });
  report.lineSource = report.hasPath ? 'drawn' : null;
  meta.lineSource = report.lineSource;
  writeJson(path.join(outDir, 'report.json'), report);
  writeJson(path.join(outDir, 'meta.json'), meta);
  return summarize(meta, report);
}

if (!isMainThread && workerData?.task) {
  const post = (m) => parentPort.postMessage(m);
  let lastPct = -1;
  const progress = (stage, pct) => { const p = Math.round(pct * 100); if (p !== lastPct || stage === 'done') { lastPct = p; post({ type: 'progress', stage, pct: p }); } };
  const run = workerData.task === 'reanalyze' ? reanalyze(workerData) : build(workerData, progress);
  run.then((summary) => post({ type: 'done', summary }))
    .catch((err) => post({ type: 'error', code: err.code || 'failed', message: err.userFacing ? err.message : `Processing failed: ${err.message}`, stack: err.stack }));
}
