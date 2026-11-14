// Aerial imagery, handled in the browser: read a GeoTIFF (or a JPG/PNG with a world file), cut out the part that
// covers the trail, and hand back a canvas that can be uploaded as the trail's texture. The original file never
// leaves the computer, so a 500 MB orthophoto costs nothing to "upload".
//
// GeoTIFF support: classic and BigTIFF, strips or tiles, overviews (COG), 8/16-bit, 1–4 samples,
// compression none / LZW / Deflate / JPEG / PackBits, horizontal predictor.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
export const IMAGE_EXT = ['.tif', '.tiff', '.jpg', '.jpeg', '.png', '.webp'];
export const WORLD_EXT = ['.tfw', '.jgw', '.pgw', '.wld', '.tifw', '.jpgw', '.pngw'];
const ext = (name) => (name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
export const isTiff = (file) => ['.tif', '.tiff'].includes(ext(file.name));

async function slice(file, offset, length) { return new DataView(await file.slice(offset, offset + length).arrayBuffer()); }

async function readIfds(file) {
  const head = await slice(file, 0, 16);
  const bo = head.getUint16(0);
  if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('tiff_invalid');
  const le = bo === 0x4949, magic = head.getUint16(2, le), big = magic === 43;
  if (magic !== 42 && magic !== 43) throw new Error('tiff_invalid');
  const u64 = (dv, o) => Number(dv.getBigUint64(o, le));
  let next = big ? u64(head, 8) : head.getUint32(4, le);
  const ifds = [];
  while (next && ifds.length < 24) {
    const cdv = await slice(file, next, big ? 8 : 2);
    const count = big ? u64(cdv, 0) : cdv.getUint16(0, le);
    const esz = big ? 20 : 12, base = next + (big ? 8 : 2);
    const dv = await slice(file, base, count * esz + (big ? 8 : 4));
    const tags = {};
    for (let i = 0; i < count; i++) {
      const o = i * esz, tag = dv.getUint16(o, le), type = dv.getUint16(o + 2, le);
      const n = big ? u64(dv, o + 4) : dv.getUint32(o + 4, le);
      const size = (TYPE_SIZE[type] || 1) * n, inline = size <= (big ? 8 : 4), valueAt = o + (big ? 12 : 8);
      tags[tag] = { type, n, inline, offset: inline ? base + valueAt : (big ? u64(dv, valueAt) : dv.getUint32(valueAt, le)) };
    }
    next = big ? u64(dv, count * esz) : dv.getUint32(count * esz, le);
    ifds.push(tags);
  }
  const value = async (tags, tag) => {
    const e = tags[tag]; if (!e) return null;
    const dv = await slice(file, e.offset, (TYPE_SIZE[e.type] || 1) * e.n), out = new Array(e.n);
    for (let i = 0; i < e.n; i++) {
      switch (e.type) {
        case 1: case 2: case 7: out[i] = dv.getUint8(i); break;
        case 3: out[i] = dv.getUint16(i * 2, le); break;
        case 4: out[i] = dv.getUint32(i * 4, le); break;
        case 5: out[i] = dv.getUint32(i * 8, le) / (dv.getUint32(i * 8 + 4, le) || 1); break;
        case 12: out[i] = dv.getFloat64(i * 8, le); break;
        case 16: out[i] = u64(dv, i * 8); break;
        default: out[i] = dv.getUint8(i);
      }
    }
    return out;
  };
  return { ifds, value, le };
}

async function describe(file) {
  const { ifds, value } = await readIfds(file);
  const levels = [];
  for (const tags of ifds) {
    const one = async (tag, dflt) => { const v = await value(tags, tag); return v ? v[0] : dflt; };
    const width = await one(256), height = await one(257);
    if (!width || !height) continue;
    const tiled = !!tags[322];
    const lv = { width, height, tiled, compression: await one(259, 1), photometric: await one(262, 1), samples: await one(277, 1), bits: await one(258, 8), predictor: await one(317, 1),
      planar: await one(284, 1), tileW: tiled ? await one(322) : width, tileH: tiled ? await one(323) : await one(278, height), subfile: await one(254, 0),
      offsets: await value(tags, tiled ? 324 : 273), counts: await value(tags, tiled ? 325 : 279), jpegTables: tags[347] ? new Uint8Array(await value(tags, 347)) : null,
      scale: await value(tags, 33550), tie: await value(tags, 33922), matrix: await value(tags, 34264), geokeys: await value(tags, 34735) };
    if (lv.subfile & 4) continue;   // transparency mask
    levels.push(lv);
  }
  if (!levels.length) throw new Error('tiff_invalid');
  const main = levels[0];
  let geo = null;
  if (main.scale && main.tie) geo = { x0: main.tie[3] - main.tie[0] * main.scale[0], y0: main.tie[4] + main.tie[1] * main.scale[1], px: main.scale[0], py: main.scale[1] };
  else if (main.matrix) geo = { x0: main.matrix[3], y0: main.matrix[7], px: main.matrix[0], py: -main.matrix[5] };
  let epsg = null;
  if (main.geokeys) for (let k = 4; k + 3 < main.geokeys.length; k += 4) if (main.geokeys[k] === 3072 && main.geokeys[k + 1] === 0) epsg = main.geokeys[k + 3];
  return { levels: levels.filter((l) => l.width <= main.width).sort((a, b) => b.width - a.width), geo, epsg, width: main.width, height: main.height };
}

// TIFF-flavoured LZW (MSB-first codes, "early change" code-width bumps).
function lzw(src, expected) {
  const out = new Uint8Array(expected);
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), stack = new Uint8Array(4097);
  for (let i = 0; i < 256; i++) { suffix[i] = i; first[i] = i; }
  let sp = 0, bitBuf = 0, bits = 0, width = 9, next = 258, prev = -1, o = 0;
  const emit = (code) => { let n = 0, c = code; for (;;) { stack[n++] = suffix[c]; if (c < 256) break; c = prefix[c]; } while (n > 0 && o < expected) out[o++] = stack[--n]; };
  while (o < expected) {
    while (bits < width) { if (sp >= src.length) return out; bitBuf = (bitBuf << 8) | src[sp++]; bits += 8; }
    const code = (bitBuf >>> (bits - width)) & ((1 << width) - 1);
    bits -= width; bitBuf &= (1 << bits) - 1;
    if (code === 257) break;
    if (code === 256) { width = 9; next = 258; prev = -1; continue; }
    if (prev === -1) { emit(code); prev = code; continue; }
    if (next < 4096) {
      prefix[next] = prev; first[next] = first[prev];
      suffix[next] = code < next ? first[code] : first[prev];
      emit(code); next++;
    } else emit(code);
    if (next >= (1 << width) - 1 && width < 12) width++;
    prev = code;
  }
  return out;
}

function packbits(src, expected) {
  const out = new Uint8Array(expected); let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = src[i++] << 24 >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k <= -n && o < expected; k++) out[o++] = v; }
  }
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decodes one tile/strip into something drawImage accepts.
async function decodeTile(file, lv, index, tw, th) {
  const offset = lv.offsets[index], count = lv.counts[index];
  if (!count) return null;
  const raw = new Uint8Array(await file.slice(offset, offset + count).arrayBuffer());
  if (lv.compression === 7) {
    let jpeg = raw;
    if (lv.jpegTables && lv.jpegTables.length > 4) { jpeg = new Uint8Array(lv.jpegTables.length - 2 + raw.length - 2); jpeg.set(lv.jpegTables.subarray(0, lv.jpegTables.length - 2)); jpeg.set(raw.subarray(2), lv.jpegTables.length - 2); }
    return createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  }
  const bytesPer = lv.bits / 8, expected = tw * th * lv.samples * bytesPer;
  let data;
  if (lv.compression === 1) data = raw;
  else if (lv.compression === 5) data = lzw(raw, expected);
  else if (lv.compression === 8 || lv.compression === 32946) data = await inflate(raw);
  else if (lv.compression === 32773) data = packbits(raw, expected);
  else throw new Error('tiff_compression');
  const rowBytes = tw * lv.samples * bytesPer, step = lv.samples * bytesPer;
  if (lv.predictor === 2) for (let y = 0; y < th; y++) { const r = y * rowBytes; for (let x = step; x < rowBytes; x++) data[r + x] = (data[r + x] + data[r + x - step]) & 255; }
  const img = new ImageData(tw, th), px = img.data, hi = bytesPer === 2 ? 1 : 0;   // 16-bit little-endian: keep the high byte
  for (let i = 0, n = tw * th; i < n; i++) {
    const s = i * step;
    if (s + step > data.length) break;
    if (lv.samples >= 3) { px[i * 4] = data[s + hi]; px[i * 4 + 1] = data[s + bytesPer + hi]; px[i * 4 + 2] = data[s + 2 * bytesPer + hi]; }
    else { const v = lv.photometric === 0 ? 255 - data[s + hi] : data[s + hi]; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; }
    px[i * 4 + 3] = 255;
  }
  const c = new OffscreenCanvas(tw, th); c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

function parseWorld(text) {
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length < 6 || v.some(Number.isNaN)) return null;
  return { px: v[0], py: -v[3], x0: v[4] - v[0] / 2, y0: v[5] - v[3] / 2 };   // world files give the centre of the top-left pixel
}

// Inspect an image and work out where it sits. `worldText` is the content of a matching world file, if any.
export async function inspectImage(file, worldText) {
  if (isTiff(file)) {
    const info = await describe(file);
    const geo = info.geo || (worldText ? parseWorld(worldText) : null);
    return { kind: 'tiff', info, width: info.width, height: info.height, epsg: info.epsg, geo };
  }
  const bmp = await createImageBitmap(file);
  return { kind: 'bitmap', bitmap: bmp, width: bmp.width, height: bmp.height, epsg: null, geo: worldText ? parseWorld(worldText) : null };
}

// Draws the part of `image` that covers `target` (CRS box {minX,minY,maxX,maxY}) onto ctx, whose canvas spans `target`.
// Without georeferencing the image is assumed to cover the whole target ("fit").
async function drawInto(ctx, file, image, target, onProgress) {
  const cw = ctx.canvas.width, chh = ctx.canvas.height;
  const geo = image.geo || { x0: target.minX, y0: target.maxY, px: (target.maxX - target.minX) / image.width, py: (target.maxY - target.minY) / image.height };
  // target box in full-resolution pixel coordinates of the image
  const fx0 = (target.minX - geo.x0) / geo.px, fx1 = (target.maxX - geo.x0) / geo.px, fy0 = (geo.y0 - target.maxY) / geo.py, fy1 = (geo.y0 - target.minY) / geo.py;
  const sx = cw / (fx1 - fx0), sy = chh / (fy1 - fy0);       // canvas px per full-res image px
  if (fx1 <= 0 || fy1 <= 0 || fx0 >= image.width || fy0 >= image.height) return false;
  ctx.imageSmoothingQuality = 'high';
  if (image.kind === 'bitmap') {
    ctx.drawImage(image.bitmap, 0, 0, image.width, image.height, -fx0 * sx, -fy0 * sy, image.width * sx, image.height * sy);
    return true;
  }
  // pick the coarsest overview that still gives ≥ 1 source pixel per canvas pixel
  const levels = image.info.levels;
  let lv = levels[0];
  for (const l of levels) if (l.width / image.width >= Math.min(1, sx * 0.95)) lv = l;
  if (lv.planar !== 1) throw new Error('tiff_planar');
  const k = lv.width / image.width;                           // level px per full-res px
  const across = Math.ceil(lv.width / lv.tileW), down = Math.ceil(lv.height / lv.tileH);
  const tx0 = Math.max(0, Math.floor(fx0 * k / lv.tileW)), tx1 = Math.min(across - 1, Math.floor(fx1 * k / lv.tileW));
  const ty0 = Math.max(0, Math.floor(fy0 * k / lv.tileH)), ty1 = Math.min(down - 1, Math.floor(fy1 * k / lv.tileH));
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1); let done = 0;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const tw = lv.tiled ? lv.tileW : lv.width, th = lv.tiled ? lv.tileH : Math.min(lv.tileH, lv.height - ty * lv.tileH);
    const tile = await decodeTile(file, lv, ty * across + tx, tw, th);
    if (tile) {
      const dx = (tx * lv.tileW / k - fx0) * sx, dy = (ty * lv.tileH / k - fy0) * sy;
      ctx.drawImage(tile, 0, 0, tw, th, dx, dy, tw / k * sx + 0.5, th / k * sy + 0.5);
      tile.close?.();
    }
    onProgress?.(++done / total);
  }
  return true;
}

// Bake one or more images into a single texture canvas for the box `target`. Returns { canvas, used } or null if nothing overlaps.
export async function bakeTexture(items, target, { maxSize = 4096, onProgress } = {}) {
  const wM = target.maxX - target.minX, hM = target.maxY - target.minY;
  let best = 0;
  for (const it of items) { const g = it.image.geo; best = Math.max(best, g ? 1 / g.px : it.image.width / wM); }
  const scale = Math.min(maxSize / wM, maxSize / hM, best || 4);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.round(wM * scale)); canvas.height = Math.max(64, Math.round(hM * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8f9a8c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    if (await drawInto(ctx, items[i].file, items[i].image, target, (f) => onProgress?.((i + f) / items.length))) used++;
  }
  return used ? { canvas, used } : null;
}

export const canvasToJpeg = (canvas, quality = 0.9) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

// Pair images with their world files (same base name) and inspect them.
export async function prepareImages(files) {
  const worlds = new Map();
  for (const f of files) if (WORLD_EXT.includes(ext(f.name))) worlds.set(f.name.replace(/\.[^.]+$/, '').toLowerCase(), f);
  const items = [];
  for (const f of files) {
    if (!IMAGE_EXT.includes(ext(f.name))) continue;
    const world = worlds.get(f.name.replace(/\.[^.]+$/, '').toLowerCase());
    items.push({ file: f, image: await inspectImage(f, world ? await world.text() : null) });
  }
  return items;
}
