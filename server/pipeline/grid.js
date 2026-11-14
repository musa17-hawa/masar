// Raster helpers on Float32 grids (row-major, row 0 = south). NaN marks "no data".

// Push–pull hole filling: averages valid cells into coarser levels, then fills gaps from them.
// `maxLevel` bounds how large a hole may be bridged (2^maxLevel cells); larger gaps stay NaN.
export function fillHoles(src, w, h, maxLevel = 30) {
  const levels = [{ d: Float32Array.from(src), w, h }];
  let hasHole = false;
  for (let i = 0; i < src.length; i++) if (Number.isNaN(src[i])) { hasHole = true; break; }
  if (!hasHole) return levels[0].d;
  while (levels.length <= maxLevel) {
    const a = levels[levels.length - 1];
    if (a.w === 1 && a.h === 1) break;
    const bw = Math.max(1, Math.ceil(a.w / 2)), bh = Math.max(1, Math.ceil(a.h / 2));
    const b = new Float32Array(bw * bh);
    let holes = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = x * 2 + dx, yy = y * 2 + dy;
        if (xx < a.w && yy < a.h) { const v = a.d[yy * a.w + xx]; if (!Number.isNaN(v)) { s += v; n++; } }
      }
      if (n) b[y * bw + x] = s / n; else { b[y * bw + x] = NaN; holes++; }
    }
    levels.push({ d: b, w: bw, h: bh });
    if (!holes) break;
  }
  for (let k = levels.length - 2; k >= 0; k--) {
    const a = levels[k], b = levels[k + 1];
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const i = y * a.w + x;
      if (!Number.isNaN(a.d[i])) continue;
      // bilinear sample of the coarser level, ignoring its own gaps
      const fx = (x + 0.5) / 2 - 0.5, fy = (y + 0.5) / 2 - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      let s = 0, ws = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = Math.min(b.w - 1, Math.max(0, x0 + dx)), yy = Math.min(b.h - 1, Math.max(0, y0 + dy));
        const v = b.d[yy * b.w + xx];
        if (Number.isNaN(v)) continue;
        const wt = (dx ? fx - x0 : 1 - (fx - x0)) * (dy ? fy - y0 : 1 - (fy - y0)) + 1e-4;
        s += v * wt; ws += wt;
      }
      if (ws > 0) a.d[i] = s / ws;
    }
  }
  return levels[0].d;
}

export function minMaxFilter(src, w, h, r, isMin) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pick = isMin ? Math.min : Math.max;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = src[y * w + x];
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]);
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = tmp[y * w + x];
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
    out[y * w + x] = v;
  }
  return out;
}

// Progressive morphological filter (Zhang et al. 2003, simplified): estimates bare ground from a
// lowest-point surface by removing bumps that rise faster than `slope` allows at growing window sizes.
export function groundFromLowest(zmin, w, h, cell, { maxWindow, slope, dh0 }) {
  let z = fillHoles(zmin, w, h);
  const radii = [];
  for (let r = 1; r * cell <= maxWindow; r = Math.max(r + 1, Math.round(r * 1.6))) radii.push(r);
  for (const r of radii) {
    const opened = minMaxFilter(minMaxFilter(z, w, h, r, true), w, h, r, false);
    const thr = slope * r * cell + dh0;
    for (let i = 0; i < z.length; i++) if (z[i] - opened[i] > thr) z[i] = opened[i];
  }
  return z;
}

export function bilinear(g, w, h, fx, fy) {
  if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return NaN;
  const x0 = Math.min(w - 2, Math.floor(fx)), y0 = Math.min(h - 2, Math.floor(fy));
  const tx = fx - x0, ty = fy - y0;
  const a = g[y0 * w + x0], b = g[y0 * w + x0 + 1], c = g[(y0 + 1) * w + x0], d = g[(y0 + 1) * w + x0 + 1];
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
    let s = 0, n = 0;
    for (const v of [a, b, c, d]) if (!Number.isNaN(v)) { s += v; n++; }
    return n ? s / n : NaN;
  }
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

// D8 flow accumulation: how much upslope area (in cells) drains through each cell. Used to spot
// gullies and stream beds a trail crosses. Pits are only breached locally, so treat results as hints.
export function flowAccumulation(z, w, h) {
  const n = w * h;
  const order = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(z[i])) order[m++] = i;
  const idx = order.subarray(0, m);
  idx.sort((a, b) => z[b] - z[a]);
  const acc = new Float32Array(n).fill(1);
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  for (let k = 0; k < m; k++) {
    const i = idx[k], x = i % w, y = (i - x) / w;
    let best = -1, bestDrop = 0;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const v = z[yy * w + xx];
      if (Number.isNaN(v)) continue;
      const drop = (z[i] - v) / (d % 2 ? Math.SQRT2 : 1);
      if (drop > bestDrop) { bestDrop = drop; best = yy * w + xx; }
    }
    if (best < 0) {   // a pit: breach it by looking one ring further out for anything lower
      let low = z[i];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const v = z[yy * w + xx];
        if (v < low) { low = v; best = yy * w + xx; }
      }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  return acc;
}

// Average a grid down by an integer factor (NaN-aware).
export function downsample(src, w, h, f) {
  const cw = Math.max(1, Math.floor(w / f)), ch = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let s = 0, n = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const v = src[(y * f + dy) * w + x * f + dx]; if (!Number.isNaN(v)) { s += v; n++; } }
    out[y * cw + x] = n ? s / n : NaN;
  }
  return { d: out, w: cw, h: ch };
}
