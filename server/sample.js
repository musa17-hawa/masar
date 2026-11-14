// Synthetic sample data, so Masar can be demonstrated before any real survey data is at hand.
//   alpine  — a classified airborne-style LAS tile (LV95 coordinates), a GPX track and an "aerial photo"
//   phone   — a close-range colour scan (PLY, Y-up like most phone scanners) of a path with stone steps
// Both are generated from seeded noise, then pushed through the very same pipeline as real uploads.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getProjection } from './geo/proj.js';

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const hash2 = (x, y) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263); h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
const fbm = (x, y, oct = 4) => { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); a *= 0.5; f *= 2.03; } return s; };

// ── PNG writer (8-bit RGB) ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function encodePng(w, h, rgb) {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { rows[y * (w * 3 + 1)] = 0; rgb.copy(rows, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── LAS 1.2 writer (point format 1, with an EPSG GeoKey) ──
function writeLas(file, pts, n, epsg, origin) {
  const [ox, oy, oz] = origin, scale = 0.01, recLen = 28, headerSize = 227, vlrLen = 54 + 24, dataOffset = headerSize + vlrLen;
  const buf = Buffer.alloc(dataOffset + n * recLen);
  buf.write('LASF', 0, 'latin1'); buf[24] = 1; buf[25] = 2;
  buf.write('Masar sample generator', 58, 'latin1');
  buf.writeUInt16LE(headerSize, 94); buf.writeUInt32LE(dataOffset, 96); buf.writeUInt32LE(1, 100); buf[104] = 1; buf.writeUInt16LE(recLen, 105); buf.writeUInt32LE(n, 107);
  [131, 139, 147].forEach((o) => buf.writeDoubleLE(scale, o));
  buf.writeDoubleLE(ox, 155); buf.writeDoubleLE(oy, 163); buf.writeDoubleLE(oz, 171);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const o = dataOffset + i * recLen, x = pts.x[i], y = pts.y[i], z = pts.z[i];
    buf.writeInt32LE(Math.round(x / scale), o); buf.writeInt32LE(Math.round(y / scale), o + 4); buf.writeInt32LE(Math.round(z / scale), o + 8);
    buf.writeUInt16LE(pts.inten[i], o + 12); buf[o + 14] = 0x09; buf[o + 15] = pts.cls[i];
    if (x < mn[0]) mn[0] = x; if (y < mn[1]) mn[1] = y; if (z < mn[2]) mn[2] = z; if (x > mx[0]) mx[0] = x; if (y > mx[1]) mx[1] = y; if (z > mx[2]) mx[2] = z;
  }
  buf.writeDoubleLE(mx[0] + ox, 179); buf.writeDoubleLE(mn[0] + ox, 187); buf.writeDoubleLE(mx[1] + oy, 195); buf.writeDoubleLE(mn[1] + oy, 203); buf.writeDoubleLE(mx[2] + oz, 211); buf.writeDoubleLE(mn[2] + oz, 219);
  const v = headerSize;
  buf.write('LASF_Projection', v + 2, 'latin1'); buf.writeUInt16LE(34735, v + 18); buf.writeUInt16LE(24, v + 20);
  [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, epsg].forEach((val, i) => buf.writeUInt16LE(val, v + 54 + i * 2));
  fs.writeFileSync(file, buf);
}

// ───────────────────────────── Alpine sample ─────────────────────────────

const ALP = { W: 300, H: 240, origin: [2636200, 1158400, 0], epsg: 2056 };
const TRAIL = [[28, 20], [78, 30], [128, 50], [176, 58], [214, 66], [240, 86], [226, 104], [176, 112], [118, 118], [74, 130], [62, 148], [88, 162], [140, 170], [198, 180], [236, 196], [258, 216]];

function alpineTerrain() {
  const { W, H } = ALP;
  // dense trail samples + a raster of "distance to trail" for carving the tread
  const line = [];
  for (let i = 1; i < TRAIL.length; i++) {
    const [ax, ay] = TRAIL[i - 1], [bx, by] = TRAIL[i], n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5);
    for (let s = 0; s < n; s++) line.push([ax + (bx - ax) * s / n, ay + (by - ay) * s / n]);
  }
  line.push(TRAIL[TRAIL.length - 1]);
  for (let pass = 0; pass < 12; pass++) for (let i = 1; i < line.length - 1; i++) { line[i] = [(line[i - 1][0] + line[i][0] * 2 + line[i + 1][0]) / 4, (line[i - 1][1] + line[i][1] * 2 + line[i + 1][1]) / 4]; }
  const gullyX = (y) => 190 + 16 * Math.sin(y / 38) - y * 0.05;
  const raw = (x, y) => 1420 + 0.30 * y + 0.035 * x + 26 * fbm(x / 90, y / 90) + 5 * fbm(x / 22 + 9, y / 22) + 0.7 * fbm(x / 4, y / 4, 2)
    - 4.2 * Math.exp(-(((x - gullyX(y)) / 7) ** 2));
  const near = new Float32Array(W * H).fill(99), nearIdx = new Int32Array(W * H).fill(-1);
  line.forEach(([lx, ly], k) => {
    for (let yy = Math.max(0, Math.floor(ly) - 4); yy <= Math.min(H - 1, Math.floor(ly) + 4); yy++) for (let xx = Math.max(0, Math.floor(lx) - 4); xx <= Math.min(W - 1, Math.floor(lx) + 4); xx++) {
      const dd = Math.hypot(xx + 0.5 - lx, yy + 0.5 - ly);
      if (dd < near[yy * W + xx]) { near[yy * W + xx] = dd; nearIdx[yy * W + xx] = k; }
    }
  });
  const lineZ = line.map(([x, y]) => raw(x, y));
  for (let pass = 0; pass < 6; pass++) for (let i = 1; i < lineZ.length - 1; i++) lineZ[i] = (lineZ[i - 1] + lineZ[i] * 2 + lineZ[i + 1]) / 4;
  const distToTrail = (x, y) => {
    const k0 = nearIdx[Math.min(H - 1, Math.max(0, Math.floor(y))) * W + Math.min(W - 1, Math.max(0, Math.floor(x)))];
    if (k0 < 0) return [99, 0];
    let best = Infinity, bk = k0;
    for (let k = Math.max(0, k0 - 8); k <= Math.min(line.length - 1, k0 + 8); k++) { const dd = Math.hypot(line[k][0] - x, line[k][1] - y); if (dd < best) { best = dd; bk = k; } }
    return [best, bk];
  };
  const height = (x, y) => {
    const [dist, k] = distToTrail(x, y);
    const z = raw(x, y);
    return dist < 3 ? lineZ[k] + (z - lineZ[k]) * smoothstep(0.7, 3, dist) : z;
  };
  return { line, lineZ, height, distToTrail, gullyX };
}

export function makeAlpineSample(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const { W, H, origin, epsg } = ALP;
  const T = alpineTerrain(), rand = rng(42);
  const cap = 1_400_000;
  const pts = { x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap), cls: new Uint8Array(cap), inten: new Uint16Array(cap) };
  let n = 0;
  const add = (x, y, z, cls, inten) => { if (n < cap && x >= 0 && y >= 0 && x < W && y < H) { pts.x[n] = x; pts.y[n] = y; pts.z[n] = z; pts.cls[n] = cls; pts.inten[n] = inten; n++; } };
  // trees: lower two thirds, away from the trail and the stream
  const trees = [];
  for (let i = 0; i < 2600 && trees.length < 950; i++) {
    const x = rand() * W, y = rand() * H;
    if (y > 172 + 20 * noise(x / 30, 3) || fbm(x / 60 + 4, y / 60) < 0.42) continue;
    if (T.distToTrail(x, y)[0] < 3 || Math.abs(x - T.gullyX(y)) < 5) continue;
    trees.push({ x, y, h: 8 + rand() * 11, r: 1.6 + rand() * 1.8 });
  }
  const canopyGrid = new Uint8Array(W * H);
  for (const t of trees) for (let yy = Math.floor(t.y - t.r); yy <= t.y + t.r; yy++) for (let xx = Math.floor(t.x - t.r); xx <= t.x + t.r; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) canopyGrid[yy * W + xx] = 1;
  // boulders
  const boulders = [];
  for (let i = 0; i < 70; i++) { const x = rand() * W, y = 90 + rand() * (H - 90); if (T.distToTrail(x, y)[0] > 3) boulders.push({ x, y, r: 0.6 + rand() * 1.7 }); }
  const bump = (x, y) => { let b = 0; for (const o of boulders) { const dd = Math.hypot(x - o.x, y - o.y); if (dd < o.r) b = Math.max(b, Math.sqrt(o.r * o.r - dd * dd) * 0.8); } return b; };
  // ground returns (thinner under canopy, like a real survey)
  const target = 9 * W * H;
  for (let i = 0; i < target; i++) {
    const x = rand() * W, y = rand() * H;
    if (canopyGrid[Math.floor(y) * W + Math.floor(x)] && rand() < 0.55) continue;
    const wet = Math.abs(x - T.gullyX(y)) < 1.1;
    add(x, y, T.height(x, y) + bump(x, y) + (rand() - 0.5) * 0.04, wet ? 9 : 2, wet ? 40 : 300 + rand() * 500);
  }
  for (const t of trees) {
    const base = T.height(t.x, t.y), count = Math.round(140 + t.h * 10);
    for (let i = 0; i < count; i++) {
      const u = rand(), hh = t.h * (0.25 + 0.75 * u), rr = t.r * (1 - u) * Math.sqrt(rand()) + 0.1, a = rand() * 6.283;
      add(t.x + Math.cos(a) * rr, t.y + Math.sin(a) * rr, base + hh, 3, 80 + rand() * 200);
    }
  }
  // a small hut with a gabled roof beside the upper hairpin
  const hut = { x: 50, y: 150, w: 6, d: 5 }, hz = T.height(hut.x, hut.y);
  for (let i = 0; i < 2600; i++) { const u = rand() * hut.w, v = rand() * hut.d; add(hut.x + u, hut.y + v, hz + 3 + (1 - Math.abs(u / hut.w * 2 - 1)) * 1.6, 6, 900); }
  writeLas(path.join(dir, 'masar-sample-alpine_2056.las'), pts, n, epsg, origin);

  // GPX track of the trail (WGS 84), like one exported from a hiking app
  const proj = getProjection(epsg);
  const gpx = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="Masar sample" xmlns="http://www.topografix.com/GPX/1/1">', '<trk><name>Sample alpine trail</name><trkseg>'];
  for (let k = 0; k < T.line.length; k += 8) {
    const [lon, lat] = proj.toWgs(origin[0] + T.line[k][0], origin[1] + T.line[k][1]);
    gpx.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${T.lineZ[k].toFixed(1)}</ele></trkpt>`);
  }
  gpx.push('</trkseg></trk></gpx>');
  fs.writeFileSync(path.join(dir, 'masar-sample-alpine.gpx'), gpx.join('\n'));

  // "aerial photo": 4 px per metre, north up
  const pw = W * 4, ph = H * 4, rgb = Buffer.alloc(pw * ph * 3);
  const crown = new Float32Array(pw * ph);
  for (const t of trees) for (let yy = Math.floor((t.y - t.r) * 4); yy <= (t.y + t.r) * 4; yy++) for (let xx = Math.floor((t.x - t.r) * 4); xx <= (t.x + t.r) * 4; xx++) {
    if (xx < 0 || yy < 0 || xx >= pw || yy >= ph) continue;
    const dd = Math.hypot(xx / 4 - t.x, yy / 4 - t.y) / t.r;
    if (dd < 1) crown[yy * pw + xx] = Math.max(crown[yy * pw + xx], 1 - dd * 0.7);
  }
  for (let py = 0; py < ph; py++) for (let px = 0; px < pw; px++) {
    const x = (px + 0.5) / 4, y = H - (py + 0.5) / 4;
    const e = 0.75, z = T.height(x, y), gx = (T.height(x + e, y) - T.height(x - e, y)) / (2 * e), gy = (T.height(x, y + e) - T.height(x, y - e)) / (2 * e);
    const slope = Math.hypot(gx, gy), light = Math.max(0.45, Math.min(1.25, 0.9 - 0.9 * gx * 0.5 + 0.9 * gy * 0.35));
    const t1 = fbm(x / 9, y / 9), t2 = fbm(x / 2.2, y / 2.2, 3);
    let r = 92 + 40 * t1, g = 122 + 36 * t1, b = 62 + 22 * t1;                       // alpine meadow
    const rock = smoothstep(0.42, 0.62, slope + 0.25 * t1) * 0.85 + smoothstep(1555, 1600, z + 30 * t1) * 0.7;
    r += (128 + 30 * t2 - r) * Math.min(1, rock); g += (124 + 28 * t2 - g) * Math.min(1, rock); b += (118 + 26 * t2 - b) * Math.min(1, rock);
    const bb = bump(x, y); if (bb > 0.1) { r = 150 + 30 * t2; g = 146 + 28 * t2; b = 138 + 26 * t2; }
    const stream = Math.abs(x - T.gullyX(y)); if (stream < 1.3) { const k = 1 - stream / 1.3; r += (70 - r) * k; g += (112 - g) * k; b += (128 - b) * k; }
    const [dist] = T.distToTrail(x, y); if (dist < 0.75) { const k = 1 - smoothstep(0.35, 0.75, dist); r += (176 - r) * k; g += (160 - g) * k; b += (130 - b) * k; }
    const c = crown[Math.min(ph - 1, Math.floor(y * 4)) * pw + px] || 0; if (c > 0) { const k = Math.min(1, c * 1.6); r += (38 + 28 * t2 - r) * k; g += (74 + 36 * t2 - g) * k; b += (40 + 18 * t2 - b) * k; }
    if (x >= hut.x && x <= hut.x + hut.w && y >= hut.y && y <= hut.y + hut.d) { const side = (x - hut.x) / hut.w < 0.5 ? 1 : 0.8; r = 150 * side; g = 78 * side; b = 60 * side; }
    const grain = 0.94 + 0.12 * hash2(px, py), o = (py * pw + px) * 3;
    rgb[o] = Math.max(0, Math.min(255, r * light * grain)); rgb[o + 1] = Math.max(0, Math.min(255, g * light * grain)); rgb[o + 2] = Math.max(0, Math.min(255, b * light * grain));
  }
  const png = encodePng(pw, ph, rgb);
  fs.writeFileSync(path.join(dir, 'masar-sample-alpine-ortho.png'), png);
  // world file: pixel size, rotation, rotation, -pixel size, x of top-left pixel centre, y of top-left pixel centre
  fs.writeFileSync(path.join(dir, 'masar-sample-alpine-ortho.pgw'), [0.25, 0, 0, -0.25, origin[0] + 0.125, origin[1] + H - 0.125].join('\n') + '\n');
  return { name: 'Sample: alpine switchbacks', location: 'Synthetic terrain (Swiss LV95 coordinates)',
    files: [{ name: 'masar-sample-alpine_2056.las', kind: 'cloud' }, { name: 'masar-sample-alpine.gpx', kind: 'track' }],
    texture: { file: 'masar-sample-alpine-ortho.png', bounds: [0, 0, W, H], attribution: 'Synthetic sample image' },
    options: { source: 'aerial', synthetic: true, corridor: 500 } };
}

// ───────────────────────────── Phone-scan sample ─────────────────────────────

export function makePhoneSample(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const rand = rng(7), L = 30, halfW = 1.8;
  const centre = (s) => 1.4 * Math.sin(s / 8.5);
  const stepStart = 11.5, stepCount = 6, tread = 0.42, riser = 0.17;
  const ground = (s) => {
    let z = 0.05 * Math.min(s, stepStart);
    if (s > stepStart) { const k = Math.min(stepCount, Math.floor((s - stepStart) / tread) + 1); z += k * riser; }
    const after = stepStart + stepCount * tread;
    if (s > after) z += 0.07 * (s - after);
    return z;
  };
  const cap = 900_000, out = Buffer.alloc(cap * 15);
  let n = 0;
  const put = (x, y, z, r, g, b) => {
    if (n >= cap) return;
    const o = n * 15; out.writeFloatLE(x, o); out.writeFloatLE(z, o + 4); out.writeFloatLE(-y, o + 8);     // Y-up, like most phone scanners
    out[o + 12] = Math.max(0, Math.min(255, r)); out[o + 13] = Math.max(0, Math.min(255, g)); out[o + 14] = Math.max(0, Math.min(255, b)); n++;
  };
  const sp = 0.016;
  for (let s = 0; s < L; s += sp) for (let v = -halfW; v <= halfW; v += sp) {
    const js = s + (rand() - 0.5) * sp, jv = v + (rand() - 0.5) * sp;
    const edge = Math.abs(jv), onTread = edge < 0.85, onSteps = js > stepStart && js < stepStart + stepCount * tread + 0.1 && edge < 1.0;
    const tex = fbm(js * 3, jv * 3, 3);
    let z = ground(js) + (onTread ? 0.012 : 0.045) * (tex - 0.5) * 2 + smoothstep(0.9, 1.8, edge) * 0.22 * (jv > 0 ? 1 : 0.5);
    let r, g, b;
    if (onSteps) { z = ground(js) + 0.006 * (rand() - 0.5); const k = 150 + 50 * tex; r = k; g = k - 4; b = k - 12; }
    else if (onTread) { const k = 0.8 + 0.4 * tex; r = 128 * k; g = 104 * k; b = 78 * k; }
    else { const k = 0.7 + 0.6 * tex; r = 70 * k; g = 112 * k; b = 52 * k; }
    put(js, centre(js) + jv, z, r, g, b);
  }
  const blob = (s, v, rad, hgt, col, count) => { for (let i = 0; i < count; i++) { const a = rand() * 6.283, u = rand(), el = Math.acos(u); const k = 0.85 + 0.3 * rand(); put(s + Math.cos(a) * Math.sin(el) * rad, centre(s) + v + Math.sin(a) * Math.sin(el) * rad, ground(s) + Math.cos(el) * hgt, col[0] * k, col[1] * k, col[2] * k); } };
  blob(6, 0.2, 0.24, 0.24, [142, 138, 130], 5200);        // rocks on the tread
  blob(19.6, -0.25, 0.3, 0.32, [150, 144, 134], 7000);
  blob(24.2, 0.3, 0.16, 0.18, [134, 130, 124], 3000);
  for (let i = 0; i < 9000; i++) {                          // a fallen log across the path
    const u = (rand() - 0.5) * 2.5, a = rand() * 3.1416, s = 21.6 + Math.cos(a) * 0.15 + u * 0.12;
    put(s, centre(21.6) + u, ground(s) + 0.13 + Math.sin(a) * 0.15, 92 + rand() * 30, 66 + rand() * 20, 44 + rand() * 14);
  }
  for (const [s, v] of [[9, 1.45], [17, -1.5], [27.5, 1.4]]) for (let i = 0; i < 9000; i++) {   // tree trunks beside the path
    const a = rand() * 6.283, hh = rand() * 2.6;
    put(s + Math.cos(a) * 0.17, centre(s) + v + Math.sin(a) * 0.17, ground(s) + hh, 88 + rand() * 24, 68 + rand() * 18, 50 + rand() * 12);
  }
  for (const [s, v] of [[3.5, -1.3], [13, 1.4], [23, -1.35], [28.5, -1.2]]) blob(s, v, 0.5, 0.75, [52, 104, 48], 7000);   // shrubs
  const header = `ply\nformat binary_little_endian 1.0\ncomment Masar sample phone scan\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  fs.writeFileSync(path.join(dir, 'masar-sample-phone-scan.ply'), Buffer.concat([Buffer.from(header, 'latin1'), out.subarray(0, n * 15)]));
  return { name: 'Sample: forest path with stone steps', location: 'Synthetic phone scan', files: [{ name: 'masar-sample-phone-scan.ply', kind: 'cloud' }], texture: null,
    options: { source: 'phone', synthetic: true } };
}
