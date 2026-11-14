// Trail analysis: turns a ground model + nearby points + a trail line into the numbers behind the report.
// Everything is in local metres (x east, y north, z up). `fine` = close-range scan (phone LiDAR),
// otherwise airborne-scale data. Thresholds are deliberately explicit so the team can tune them.
import { bilinear, flowAccumulation, downsample } from './grid.js';
import { resample, smooth } from './track.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round = (v, p = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

function percentile(values, p) {
  const v = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

function movingAverage(a, radius) {
  if (radius < 1) return Float64Array.from(a);
  const out = new Float64Array(a.length), pre = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - radius), hi = Math.min(a.length - 1, i + radius);
    out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
  }
  return out;
}

// Groups consecutive `true` samples into runs [{i0, i1}], bridging gaps up to `gap` samples.
function runs(flags, gap = 0) {
  const out = [];
  let start = -1, last = -1;
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    if (start < 0) start = i;
    else if (i - last > gap + 1) { out.push({ i0: start, i1: last }); start = i; }
    last = i;
  }
  if (start >= 0) out.push({ i0: start, i1: last });
  return out;
}

export function areaStats(G, grid, zBase) {
  let min = Infinity, max = -Infinity, n = 0, slopeSum = 0, slopeN = 0;
  const { w, h, cell } = grid;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const v = G[y * w + x];
    if (Number.isNaN(v)) continue;
    n++; if (v < min) min = v; if (v > max) max = v;
    const dx = (G[y * w + x + 1] - G[y * w + x - 1]) / (2 * cell), dy = (G[(y + 1) * w + x] - G[(y - 1) * w + x]) / (2 * cell);
    if (Number.isFinite(dx) && Number.isFinite(dy)) { slopeSum += Math.atan(Math.hypot(dx, dy)); slopeN++; }
  }
  return { minElevation: round(min + zBase), maxElevation: round(max + zBase), meanSlopeDeg: round(slopeSum / Math.max(1, slopeN) * 180 / Math.PI),
    areaM2: Math.round(n * 4 * cell * cell), widthM: round(w * cell), heightM: round(h * cell) };
}

export function analyze({ grid, G, S, canopy, points, path, fine, hasCanopy, osm, zBase = 0 }) {
  const { w, h, cell } = grid;
  const at = (g, x, y) => bilinear(g, w, h, x / cell - 0.5, y / cell - 0.5);
  const report = { version: 1, fine, hasPath: false, area: areaStats(G, grid, zBase), hazards: [], pois: [] };
  if (!path || path.length < 2) return report;

  // 1 ── sample the trail line
  const ds = fine ? Math.max(cell, 0.1) : Math.max(cell, 1);
  let P = resample(smooth(resample(path, ds), fine ? 3 : 2), ds);
  let z = P.map((p) => at(G, p.x, p.y));
  let first = z.findIndex(Number.isFinite), last = z.length - 1;
  while (last >= 0 && !Number.isFinite(z[last])) last--;
  if (first < 0 || last - first < 5) return report;
  P = P.slice(first, last + 1); z = z.slice(first, last + 1);
  for (let i = 1; i < z.length; i++) if (!Number.isFinite(z[i])) {   // bridge gaps inside the line
    let j = i; while (!Number.isFinite(z[j])) j++;
    for (let k = i; k < j; k++) z[k] = z[i - 1] + (z[j] - z[i - 1]) * (k - i + 1) / (j - i + 1);
    i = j;
  }
  const n = P.length;
  const d = new Float64Array(n);
  for (let i = 1; i < n; i++) d[i] = d[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
  const length = d[n - 1];
  const tangent = (i) => {
    const a = P[Math.max(0, i - 2)], b = P[Math.min(n - 1, i + 2)];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return [(b.x - a.x) / l, (b.y - a.y) / l];
  };

  // 2 ── climb, descent, grade
  const zs = movingAverage(z, Math.round((fine ? 0.4 : 5) / ds));
  const th = fine ? 0.05 : 1;
  let ascent = 0, descent = 0, ref = zs[0], length3d = 0;
  for (let i = 0; i < n; i++) {
    const dz = zs[i] - ref;
    if (dz > th) { ascent += dz; ref = zs[i]; } else if (dz < -th) { descent -= dz; ref = zs[i]; }
    if (i) length3d += Math.hypot(d[i] - d[i - 1], zs[i] - zs[i - 1]);
  }
  const half = Math.max(1, Math.round((fine ? 0.5 : 5) / ds));
  const grade = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    grade[i] = d[b] > d[a] ? (zs[b] - zs[a]) / (d[b] - d[a]) * 100 : 0;
  }
  const absGrade = Array.from(grade, Math.abs);
  const buckets = [5, 10, 20, 35];
  const hist = [0, 0, 0, 0, 0];
  for (const g of absGrade) hist[buckets.findIndex((b) => g < b) < 0 ? 4 : buckets.findIndex((b) => g < b)]++;
  const gradeShare = hist.map((c) => round(c / n * 100));

  // 3 ── footing: roughness of the walking surface (RMS height after removing the local slope)
  const rough = new Float64Array(n).fill(NaN);
  const along = fine ? 0.5 : 2, across = fine ? 0.4 : 1.5;
  const stride = Math.max(1, Math.floor(n / 1200));
  const patch = Math.max(cell, fine ? 0.05 : 0.5);
  for (let i = 0; i < n; i += stride) {
    const [tx, ty] = tangent(i);
    let su = 0, sv = 0, sz = 0, suu = 0, svv = 0, suv = 0, suz = 0, svz = 0, m = 0;
    const samples = [];
    for (let u = -along; u <= along + 1e-9; u += patch) for (let v = -across; v <= across + 1e-9; v += patch) {
      const zz = at(S, P[i].x + tx * u - ty * v, P[i].y + ty * u + tx * v);
      if (!Number.isFinite(zz)) continue;
      samples.push(u, v, zz); m++;
      su += u; sv += v; sz += zz; suu += u * u; svv += v * v; suv += u * v; suz += u * zz; svz += v * zz;
    }
    if (m < 6) continue;
    // least-squares plane z = a + b·u + c·v  (normal equations, solved directly)
    const mu = su / m, mv = sv / m, mz = sz / m;
    const cuu = suu - su * mu, cvv = svv - sv * mv, cuv = suv - su * mv, cuz = suz - su * mz, cvz = svz - sv * mz;
    const det = cuu * cvv - cuv * cuv;
    const b = det ? (cuz * cvv - cvz * cuv) / det : 0, c = det ? (cvz * cuu - cuz * cuv) / det : 0;
    let rss = 0;
    for (let k = 0; k < samples.length; k += 3) { const r = samples[k + 2] - (mz + b * (samples[k] - mu) + c * (samples[k + 1] - mv)); rss += r * r; }
    rough[i] = Math.sqrt(rss / m) * 100;
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(rough[i])) {  // carry values across the stride
    const a = Math.floor(i / stride) * stride, b = Math.min(n - 1, a + stride);
    rough[i] = Number.isFinite(rough[a]) ? rough[a] : Number.isFinite(rough[b]) ? rough[b] : NaN;
  }
  const roughMedian = percentile(rough, 0.5), roughP90 = percentile(rough, 0.9);

  const hazards = [];
  const addHazard = (type, i0, i1, extra = {}) => {
    const mid = Math.round((i0 + i1) / 2);
    hazards.push({ type, d: round(d[mid]), d0: round(d[i0]), d1: round(d[i1]), x: round(P[mid].x, 2), y: round(P[mid].y, 2), z: round(zs[mid], 2), ...extra });
  };

  // 4 ── steps and stairs (close-range scans only): short, steep risers next to flat treads
  const footing = { roughnessCm: round(roughMedian), roughnessP90Cm: round(roughP90), steps: 0, stairFlights: 0, obstacles: 0,
    clearWidthMedianM: null, clearWidthMinM: null, resolved: fine };
  if (fine) {
    const p = Math.min(0.05, ds);
    const fineLine = resample(P, p);
    const fz = fineLine.map((q) => at(G, q.x, q.y));
    const fd = fineLine.map((_, i) => i * p);
    const m = fz.length;
    const sl = new Float64Array(m);
    for (let i = 1; i < m - 1; i++) sl[i] = (fz[i + 1] - fz[i - 1]) / (2 * p);
    const risers = [];
    for (let i = 1; i < m - 1; i++) {
      if (!(Math.abs(sl[i]) > 0.7)) continue;
      const sign = Math.sign(sl[i]);
      let j = i; while (j < m - 1 && Math.sign(sl[j]) === sign && Math.abs(sl[j]) > 0.45) j++;
      const rise = fz[Math.min(m - 1, j)] - fz[i - 1], run = (j - i + 1) * p;
      const flat = (a, b) => { let s = 0, c = 0; for (let k = Math.max(1, a); k <= Math.min(m - 2, b); k++) { s += Math.abs(sl[k]); c++; } return c ? s / c : 1; };
      const tread = Math.round(0.25 / p);
      const flanked = flat(i - 1 - tread, i - 2) < 0.35 || flat(j + 1, j + tread) < 0.35;
      if (Math.abs(rise) >= 0.08 && Math.abs(rise) <= 1.2 && run <= 0.6 && flanked) risers.push({ i0: i, i1: j, rise, d: fd[Math.round((i + j) / 2)] });
      i = j;
    }
    const idxAt = (dist) => Math.min(n - 1, Math.max(0, Math.round(dist / ds)));
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const total = group.reduce((s, r) => s + r.rise, 0);
      const i0 = idxAt(group[0].d), i1 = idxAt(group[group.length - 1].d);
      if (group.length >= 3) {
        footing.stairFlights++; footing.steps += group.length;
        addHazard('stairs', i0, i1, { count: group.length, rise: round(Math.abs(total), 2), riser: round(Math.abs(total) / group.length * 100, 0), up: total > 0 });
      } else for (const r of group) {
        footing.steps++;
        const k = idxAt(r.d);
        addHazard(Math.abs(r.rise) >= 0.35 ? 'high_step' : 'step', k, k, { rise: round(Math.abs(r.rise) * 100, 0), up: r.rise > 0 });
      }
      group = [];
    };
    for (const r of risers) {
      if (group.length && (r.d - group[group.length - 1].d > 1.2 || Math.sign(r.rise) !== Math.sign(group[0].rise))) flush();
      group.push(r);
    }
    flush();
  }

  // 5 ── obstacles on the tread and clear width (close-range scans only)
  if (fine && points && points.n) {
    const cellI = 1, iw = Math.ceil(w * cell / cellI) + 1, ih = Math.ceil(h * cell / cellI) + 1;
    const index = new Int32Array(iw * ih).fill(-1);
    const reach = 3;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(P[i].x / cellI), cy = Math.floor(P[i].y / cellI);
      for (let yy = cy - reach; yy <= cy + reach; yy++) for (let xx = cx - reach; xx <= cx + reach; xx++) {
        if (xx < 0 || yy < 0 || xx >= iw || yy >= ih) continue;
        const k = yy * iw + xx, cur = index[k];
        const px = (xx + 0.5) * cellI, py = (yy + 0.5) * cellI;
        if (cur < 0 || Math.hypot(P[i].x - px, P[i].y - py) < Math.hypot(P[cur].x - px, P[cur].y - py)) index[k] = i;
      }
    }
    const cnt = new Uint16Array(n), maxH = new Float32Array(n), minH = new Float32Array(n).fill(9);
    const left = new Float32Array(n).fill(2), right = new Float32Array(n).fill(2);
    const win = Math.max(2, Math.round(0.6 / ds));
    for (let q = 0; q < points.n; q++) {
      const x = points.x[q], y = points.y[q];
      const k0 = index[Math.floor(y / cellI) * iw + Math.floor(x / cellI)];
      if (k0 === undefined || k0 < 0) continue;
      let k = k0, best = Infinity;
      for (let j = Math.max(0, k0 - win * 3); j <= Math.min(n - 1, k0 + win * 3); j++) {
        const dd = (P[j].x - x) ** 2 + (P[j].y - y) ** 2;
        if (dd < best) { best = dd; k = j; }
      }
      if (best > 4.5) continue;
      const hgt = points.z[q] - at(G, x, y);
      if (!(hgt >= 0.14 && hgt <= 1.9)) continue;
      const [tx, ty] = tangent(k);
      const lat = tx * (y - P[k].y) - ty * (x - P[k].x);   // + = left of travel
      if (Math.abs(lat) <= 0.6) { if (cnt[k] < 65535) cnt[k]++; if (hgt > maxH[k]) maxH[k] = hgt; if (hgt < minH[k]) minH[k] = hgt; }
      if (hgt >= 0.3) { if (lat > 0 && lat < left[k]) left[k] = lat; if (lat < 0 && -lat < right[k]) right[k] = -lat; }
    }
    const minPts = 5;
    for (const r of runs(Array.from(cnt, (c) => c >= minPts), Math.round(0.2 / ds))) {
      let top = 0, low = 9, total = 0;
      for (let i = r.i0; i <= r.i1; i++) { top = Math.max(top, maxH[i]); low = Math.min(low, minH[i]); total += cnt[i]; }
      if (total < minPts * 2) continue;
      const overhead = low > 1.1;
      const mid = (d[r.i0] + d[r.i1]) / 2;
      const onSteps = hazards.some((hz) => (hz.type === 'stairs' && mid > hz.d0 - 0.5 && mid < hz.d1 + 0.5) || ((hz.type === 'step' || hz.type === 'high_step') && Math.abs(hz.d - mid) < 0.5));
      if (onSteps && top < 0.3) continue;
      footing.obstacles++;
      addHazard(overhead ? 'overhang' : 'obstacle', r.i0, r.i1, { height: round(overhead ? low : top, 2), length: round(d[r.i1] - d[r.i0] + ds, 2) });
    }
    const widths = [];
    for (let i = 0; i < n; i++) widths.push(Math.min(2, left[i]) + Math.min(2, right[i]));
    const wSmooth = movingAverage(widths, Math.round(0.3 / ds));
    footing.clearWidthMedianM = round(percentile(wSmooth, 0.5), 2);
    footing.clearWidthMinM = round(Math.min(...wSmooth), 2);
    for (const r of runs(Array.from(wSmooth, (v) => v < 0.7), Math.round(0.3 / ds))) {
      let mn = 9; for (let i = r.i0; i <= r.i1; i++) mn = Math.min(mn, wSmooth[i]);
      addHazard('narrow', r.i0, r.i1, { width: round(mn, 2) });
    }
  }

  // 6 ── sustained steep pitches
  const steepLen = fine ? 2 : 8;
  for (const r of runs(absGrade.map((g) => g > 35), Math.round((fine ? 0.3 : 3) / ds))) {
    if (d[r.i1] - d[r.i0] < steepLen) continue;
    let mx = 0; for (let i = r.i0; i <= r.i1; i++) mx = Math.max(mx, absGrade[i]);
    addHazard('steep', r.i0, r.i1, { grade: round(mx, 0), length: round(d[r.i1] - d[r.i0], 0) });
  }

  // 7 ── exposure: a drop beside the trail (needs terrain several metres either side)
  let exposure = null;
  if (!fine && Math.min(w, h) * cell > 30) {
    const flags = new Array(n).fill(false);
    let seen = 0;
    for (let i = 0; i < n; i++) {
      const [tx, ty] = tangent(i);
      let worst = 0, ok = false;
      for (const side of [1, -1]) for (const off of [5, 8]) {
        const zz = at(G, P[i].x - ty * off * side, P[i].y + tx * off * side);
        if (!Number.isFinite(zz)) continue;
        ok = true; worst = Math.max(worst, (zs[i] - zz) / off);
      }
      if (ok) seen++;
      flags[i] = worst > 0.7;
    }
    if (seen > n * 0.5) {
      const share = flags.filter(Boolean).length / n;
      exposure = { sharePct: round(share * 100), sections: 0 };
      for (const r of runs(flags, Math.round(3 / ds))) {
        if (d[r.i1] - d[r.i0] < 6) continue;
        exposure.sections++;
        addHazard('exposed', r.i0, r.i1, { length: round(d[r.i1] - d[r.i0], 0) });
      }
    }
  }

  // 8 ── shade from canopy height (airborne data that sees the trees)
  let shade = null;
  if (hasCanopy && canopy) {
    let shaded = 0, seen = 0;
    const flags = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let mx = -1;
      for (const [ox, oy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, 3], [3, -3], [-3, -3]]) { const c = at(canopy, P[i].x + ox, P[i].y + oy); if (Number.isFinite(c)) mx = Math.max(mx, c); }
      if (mx < 0) continue;
      seen++; if (mx > 3) { shaded++; flags[i] = 1; }
    }
    if (seen > n * 0.5) shade = { sharePct: round(shaded / seen * 100), flags };
  }

  // 9 ── water: gullies the line crosses (from the terrain) and mapped water (from OpenStreetMap)
  const water = { crossings: 0, sources: [], streams: 0, inferred: !fine };
  if (!fine && Math.min(w, h) * cell >= 150) {
    const f = Math.max(1, Math.round(2 / cell)), c = downsample(G, w, h, f), cc = cell * f;   // ≈2 m cells smooth out survey noise
    const acc = flowAccumulation(c.d, c.w, c.h);
    const thr = 6000 / (cc * cc);
    const flags = P.map((p) => {
      const cx = Math.floor(p.x / cc), cy = Math.floor(p.y / cc);
      let mx = 0;
      for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = cx - 1; xx <= cx + 1; xx++) if (xx >= 0 && yy >= 0 && xx < c.w && yy < c.h) mx = Math.max(mx, acc[yy * c.w + xx]);
      return mx >= thr;
    });
    for (const r of runs(flags, Math.round(6 / ds))) {
      if (d[r.i1] - d[r.i0] > 40) continue;   // walking along a valley floor is not a crossing
      if (d[r.i1] < 10 || d[r.i0] > length - 10) continue;   // flow converging at the edge of the data is an artefact
      water.crossings++;
      addHazard('crossing', r.i0, r.i1, {});
    }
  }
  if (osm) {
    const nearest = (x, y) => { let best = Infinity, k = 0; for (let i = 0; i < n; i += 2) { const dd = Math.hypot(P[i].x - x, P[i].y - y); if (dd < best) { best = dd; k = i; } } return [best, k]; };
    for (const f of osm.water || []) {
      const [dist, k] = nearest(f.x, f.y);
      if (dist <= 250) water.sources.push({ kind: f.kind, name: f.name || null, x: round(f.x, 1), y: round(f.y, 1), z: round(at(G, f.x, f.y) || zs[k], 1), offTrailM: Math.round(dist), d: round(d[k]) });
    }
    for (const f of osm.pois || []) {
      const [dist, k] = nearest(f.x, f.y);
      if (dist <= 250) report.pois.push({ kind: f.kind, name: f.name || null, x: round(f.x, 1), y: round(f.y, 1), z: round(at(G, f.x, f.y) || zs[k], 1), offTrailM: Math.round(dist), d: round(d[k]) });
    }
    for (const line of osm.streams || []) {
      for (let s = 1; s < line.pts.length; s++) for (let i = 1; i < n; i++) {
        const a = P[i - 1], b = P[i], c = line.pts[s - 1], e = line.pts[s];
        const den = (b.x - a.x) * (e.y - c.y) - (b.y - a.y) * (e.x - c.x);
        if (!den) continue;
        const t = ((c.x - a.x) * (e.y - c.y) - (c.y - a.y) * (e.x - c.x)) / den, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { water.streams++; addHazard('stream', i, i, { name: line.name || null }); }
      }
    }
  }

  // 10 ── time (DIN 33466 rule of thumb: 4 km/h on the flat, 300 m/h up, 500 m/h down)
  const tH = length / 4000, tV = ascent / 300 + descent / 500;
  const hours = Math.max(tH, tV) + Math.min(tH, tV) / 2;
  const tVback = descent / 300 + ascent / 500;
  const hoursBack = Math.max(tH, tVback) + Math.min(tH, tVback) / 2;

  // 11 ── difficulty
  const p90 = percentile(absGrade, 0.9);
  const steepShare = (hist[3] + hist[4]) / n;
  const perHundred = (c) => c / Math.max(length, 1) * 100;
  const fSteep = clamp01(0.6 * (p90 - 8) / 32 + 0.4 * steepShare / 0.4);
  const fFooting = fine
    ? clamp01(0.45 * (roughMedian - 1.5) / 6 + 0.3 * perHundred(footing.steps) / 25 + 0.25 * perHundred(footing.obstacles) / 12)
    : clamp01((roughMedian - 4) / 22);
  const fExposure = exposure ? clamp01(exposure.sharePct / 30) : 0;
  const effortKm = length / 1000 + ascent / 100;
  const fEffort = clamp01(effortKm / 20);
  const score = 0.3 * fSteep + 0.25 * fFooting + 0.15 * fExposure + 0.3 * fEffort;
  const technical = (0.45 * fSteep + 0.35 * fFooting + 0.2 * fExposure);
  const levels = ['easy', 'moderate', 'demanding', 'difficult', 'severe'];
  const level = levels[score < 0.12 ? 0 : score < 0.28 ? 1 : score < 0.45 ? 2 : score < 0.65 ? 3 : 4];
  const sac = technical < 0.2 ? 'T1' : technical < 0.45 ? 'T2' : technical < 0.7 ? 'T3' : 'T4';
  const accessible = p90 < 8 && footing.steps === 0 && (fine ? roughMedian < 2.5 && footing.obstacles === 0 : roughMedian < 6);

  // 12 ── section notes
  const target = fine ? 5 : 100;
  const nSec = Math.max(3, Math.min(12, Math.round(length / target)));
  const sections = [];
  for (let s = 0; s < nSec; s++) {
    const i0 = Math.floor(s * (n - 1) / nSec), i1 = Math.floor((s + 1) * (n - 1) / nSec);
    let mx = 0, rs = 0, rc = 0, sh = 0;
    for (let i = i0; i <= i1; i++) { mx = Math.max(mx, absGrade[i]); if (Number.isFinite(rough[i])) { rs += rough[i]; rc++; } if (shade?.flags[i]) sh++; }
    const run = d[i1] - d[i0];
    sections.push({ d0: round(d[i0]), d1: round(d[i1]), grade: round(run ? (zs[i1] - zs[i0]) / run * 100 : 0), maxGrade: round(mx, 0),
      roughnessCm: rc ? round(rs / rc) : null, shadePct: shade ? Math.round(sh / (i1 - i0 + 1) * 100) : null,
      hazards: hazards.filter((hz) => hz.d >= d[i0] && hz.d < d[i1] + (s === nSec - 1 ? 1 : 0)).map((hz) => hz.type) });
  }

  // 13 ── compact arrays for the charts and the 3D line
  const pick = (count) => { const idx = []; const step = Math.max(1, (n - 1) / (count - 1)); for (let f = 0; f < n - 1; f += step) idx.push(Math.round(f)); idx.push(n - 1); return [...new Set(idx)]; };
  const pi = pick(Math.min(n, 700)), li = pick(Math.min(n, 2500));
  hazards.sort((a, b) => a.d - b.d);

  Object.assign(report, {
    hasPath: true,
    summary: { lengthM: round(length), length3dM: round(length3d), ascentM: round(ascent), descentM: round(descent),
      minElevation: round(Math.min(...zs) + zBase), maxElevation: round(Math.max(...zs) + zBase), startElevation: round(zs[0] + zBase), endElevation: round(zs[n - 1] + zBase),
      avgGradePct: round((zs[n - 1] - zs[0]) / Math.max(length, 1) * 100), maxGradePct: round(Math.max(...absGrade), 0), p90GradePct: round(p90, 0) },
    grade: { buckets, sharePct: gradeShare },
    footing, exposure, water,
    shade: shade ? { sharePct: shade.sharePct } : null,
    time: { minutes: Math.max(1, Math.round(hours * 60)), minutesBack: Math.max(1, Math.round(hoursBack * 60)), method: 'DIN 33466' },
    difficulty: { score: round(score * 100, 0), level, sac, accessible, effortKm: round(effortKm, 2),
      factors: { steepness: round(fSteep * 100, 0), footing: round(fFooting * 100, 0), exposure: round(fExposure * 100, 0), effort: round(fEffort * 100, 0) } },
    hazards, sections,
    profile: { d: pi.map((i) => round(d[i])), z: pi.map((i) => round(zs[i] + zBase, 2)), grade: pi.map((i) => round(grade[i])), rough: pi.map((i) => round(rough[i])),
      shade: shade ? pi.map((i) => shade.flags[i]) : null },
    line: { x: li.map((i) => round(P[i].x, 2)), y: li.map((i) => round(P[i].y, 2)), z: li.map((i) => round(zs[i], 2)), d: li.map((i) => round(d[i])), grade: li.map((i) => round(grade[i], 0)) },
  });
  return report;
}

// For corridor-shaped close-range scans without a GPS line: follow the middle of the scanned ground.
export function autoCenterline(observed, grid) {
  const { w, h, cell } = grid;
  let sx = 0, sy = 0, m = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (observed[y * w + x]) { sx += x; sy += y; m++; }
  if (m < 50) return null;
  const mx = sx / m, my = sy / m;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (observed[y * w + x]) { cxx += (x - mx) ** 2; cyy += (y - my) ** 2; cxy += (x - mx) * (y - my); }
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const binSize = Math.max(1, Math.round(0.5 / cell));
  const bins = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (observed[y * w + x]) {
    const t = (x - mx) * ux + (y - my) * uy;
    const k = Math.floor(t / binSize);
    const b = bins.get(k) || { x: 0, y: 0, n: 0 };
    b.x += x; b.y += y; b.n++; bins.set(k, b);
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  const typical = percentile(keys.map((k) => bins.get(k).n), 0.5);
  const pts = keys.filter((k) => bins.get(k).n >= typical * 0.25).map((k) => { const b = bins.get(k); return { x: (b.x / b.n + 0.5) * cell, y: (b.y / b.n + 0.5) * cell }; });
  return pts.length >= 4 ? smooth(pts, 2) : null;
}
