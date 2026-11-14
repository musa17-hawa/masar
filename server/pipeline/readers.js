// Point-cloud readers: LAS (all point formats 0–10), LAZ (through the optional laz-perf package),
// PLY (ASCII / binary, incl. Gaussian-splat PLY), and plain text XYZ / PTS / CSV.
// Files are streamed in chunks so a 1 GB tile never has to fit in memory.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';

const CHUNK = 65536;
export const CLOUD_EXT = ['.las', '.laz', '.ply', '.xyz', '.txt', '.csv', '.pts', '.asc'];

function makeChunk(withColor, withClass, withIntensity) {
  return {
    n: 0,
    x: new Float64Array(CHUNK), y: new Float64Array(CHUNK), z: new Float64Array(CHUNK),
    r: withColor ? new Uint8Array(CHUNK) : null,
    g: withColor ? new Uint8Array(CHUNK) : null,
    b: withColor ? new Uint8Array(CHUNK) : null,
    cls: withClass ? new Uint8Array(CHUNK) : null,
    inten: withIntensity ? new Uint16Array(CHUNK) : null,
  };
}

const userError = (code, message) => Object.assign(new Error(message), { code, userFacing: true });

// ───────────────────────────── ZIP (swisstopo ships .las inside .zip) ─────────────────────────────

export async function extractZip(file, outDir) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw userError('zip_invalid', 'This .zip file could not be read.');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64 = Buffer.alloc(56);
        await fh.read(z64, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
        count = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
      }
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      while (q + 4 <= extraEnd) {
        const id = cd.readUInt16LE(q), len = cd.readUInt16LE(q + 2);
        if (id === 1) {
          let o = q + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(o)); o += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(o)); o += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(o)); }
        }
        q += 4 + len;
      }
      p = extraEnd + commentLen;
      const ext = path.extname(name).toLowerCase();
      if (name.endsWith('/') || !CLOUD_EXT.includes(ext)) continue;
      if (method !== 0 && method !== 8) throw userError('zip_method', `"${name}" inside the zip uses an unsupported compression method.`);
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, localOffset);
      const start = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const target = path.join(outDir, `${i}-${path.basename(name).replace(/[^\w.\-]+/g, '_')}`);
      const src = fs.createReadStream(file, { start, end: start + compSize - 1 });
      if (compSize === 0) await fs.promises.writeFile(target, '');
      else if (method === 8) await pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(target));
      else await pipeline(src, fs.createWriteStream(target));
      out.push(target);
    }
    return out;
  } finally { await fh.close(); }
}

// ───────────────────────────── LAS / LAZ ─────────────────────────────

const RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

async function readLasHeader(fh) {
  const head = Buffer.alloc(375);
  const { bytesRead } = await fh.read(head, 0, 375, 0);
  if (bytesRead < 227 || head.toString('latin1', 0, 4) !== 'LASF') throw userError('las_invalid', 'This is not a valid LAS/LAZ file.');
  const minor = head.readUInt8(25);
  const headerSize = head.readUInt16LE(94);
  const rawFormat = head.readUInt8(104);
  const h = {
    version: `${head.readUInt8(24)}.${minor}`,
    headerSize,
    dataOffset: head.readUInt32LE(96),
    vlrCount: head.readUInt32LE(100),
    compressed: (rawFormat & 0x80) !== 0,
    format: rawFormat & 0x3f,
    recordLength: head.readUInt16LE(105),
    count: head.readUInt32LE(107),
    scale: [head.readDoubleLE(131), head.readDoubleLE(139), head.readDoubleLE(147)],
    offset: [head.readDoubleLE(155), head.readDoubleLE(163), head.readDoubleLE(171)],
    bounds: { maxX: head.readDoubleLE(179), minX: head.readDoubleLE(187), maxY: head.readDoubleLE(195), minY: head.readDoubleLE(203),
      maxZ: head.readDoubleLE(211), minZ: head.readDoubleLE(219) },
    epsg: null,
  };
  if (minor >= 4 && headerSize >= 375) {
    const n64 = Number(head.readBigUInt64LE(247));
    if (n64 > 0) h.count = n64;
  }
  if (h.format > 10) throw userError('las_format', `LAS point format ${h.format} is not supported.`);
  // Variable-length records: look for the coordinate system.
  let pos = headerSize;
  const vh = Buffer.alloc(54);
  for (let i = 0; i < Math.min(h.vlrCount, 64); i++) {
    const r = await fh.read(vh, 0, 54, pos);
    if (r.bytesRead < 54) break;
    const recordId = vh.readUInt16LE(18), len = vh.readUInt16LE(20);
    if ((recordId === 34735 || recordId === 2112) && len > 0 && len < 1 << 16) {
      const body = Buffer.alloc(len);
      await fh.read(body, 0, len, pos + 54);
      if (recordId === 34735 && len >= 8) {
        const nKeys = body.readUInt16LE(6);
        for (let k = 0; k < nKeys && 8 + k * 8 + 8 <= len; k++) {
          const o = 8 + k * 8;
          if (body.readUInt16LE(o) === 3072 && body.readUInt16LE(o + 2) === 0) h.epsg = body.readUInt16LE(o + 6);
        }
      } else if (recordId === 2112 && !h.epsg) {
        const wkt = body.toString('latin1');
        // The code of a projected CRS is the last EPSG authority of its block; drop any vertical CRS first.
        const horizontal = wkt.split(/,\s*VERT(?:_CS|CRS|ICALCRS)\[/)[0];
        const all = [...horizontal.matchAll(/(?:AUTHORITY\["EPSG",\s*"?(\d+)"?\]|ID\["EPSG",\s*(\d+)\])/g)];
        if (/PROJC(?:S|RS)\[/.test(horizontal) && all.length) {
          const last = all[all.length - 1];
          h.epsg = Number(last[1] || last[2]);
        }
      }
    }
    pos += 54 + len;
  }
  if (h.epsg === 32767 || h.epsg === 0) h.epsg = null;
  return h;
}

function lasInfo(h) {
  return { format: h.compressed ? 'laz' : 'las', count: h.count, bounds: h.bounds, epsg: h.epsg,
    hasRGB: RGB_OFFSET[h.format] !== undefined, hasClass: true, pointFormat: h.format, version: h.version };
}

// Decodes `n` point records from `buf` into the chunk and hands it to the consumer.
function makeLasDecoder(h, onChunk) {
  const rgbOff = RGB_OFFSET[h.format];
  const chunk = makeChunk(rgbOff !== undefined, true, true);
  const clsOff = h.format >= 6 ? 16 : 15;
  const clsMask = h.format >= 6 ? 0xff : 0x1f;
  const [sx, sy, sz] = h.scale, [ox, oy, oz] = h.offset;
  const rl = h.recordLength;
  let shift = -1; // 16-bit colour → 8-bit: decided on the first batch (some writers store 0–255 in 16-bit fields)
  return (buf, n) => {
    if (rgbOff !== undefined && shift < 0) {
      let max = 0;
      for (let i = 0; i < n; i++) { const o = i * rl + rgbOff; max = Math.max(max, buf.readUInt16LE(o), buf.readUInt16LE(o + 2), buf.readUInt16LE(o + 4)); }
      shift = max > 255 ? 8 : 0;
    }
    for (let i = 0; i < n; i++) {
      const o = i * rl;
      chunk.x[i] = buf.readInt32LE(o) * sx + ox;
      chunk.y[i] = buf.readInt32LE(o + 4) * sy + oy;
      chunk.z[i] = buf.readInt32LE(o + 8) * sz + oz;
      chunk.inten[i] = buf.readUInt16LE(o + 12);
      chunk.cls[i] = buf[o + clsOff] & clsMask;
      if (rgbOff !== undefined) {
        chunk.r[i] = buf.readUInt16LE(o + rgbOff) >> shift;
        chunk.g[i] = buf.readUInt16LE(o + rgbOff + 2) >> shift;
        chunk.b[i] = buf.readUInt16LE(o + rgbOff + 4) >> shift;
      }
    }
    chunk.n = n;
    onChunk(chunk);
  };
}

async function readLas(file, onChunk) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const h = await readLasHeader(fh);
    if (h.compressed) { await fh.close(); return readLaz(file, h, onChunk); }
    const decode = makeLasDecoder(h, onChunk);
    const buf = Buffer.alloc(CHUNK * h.recordLength);
    const { size } = await fh.stat();
    const available = Math.floor((size - h.dataOffset) / h.recordLength);
    let remaining = Math.min(h.count, available);
    let pos = h.dataOffset;
    while (remaining > 0) {
      const n = Math.min(CHUNK, remaining);
      const { bytesRead } = await fh.read(buf, 0, n * h.recordLength, pos);
      const got = Math.floor(bytesRead / h.recordLength);
      if (got === 0) break;
      decode(buf, got);
      pos += got * h.recordLength;
      remaining -= got;
    }
  } finally { await fh.close().catch(() => {}); }
}

// LAZ is LAS compressed with LASzip. Decoding it needs the optional `laz-perf` package (WebAssembly).
async function readLaz(file, h, onChunk) {
  let createLazPerf;
  try { ({ createLazPerf } = await import('laz-perf')); }
  catch {
    throw userError('laz_unavailable',
      'This file is compressed LAZ. Run "npm install" once in the Masar folder to add LAZ support, ' +
      'or convert the file to LAS (for example with CloudCompare or "las2las") and upload it again.');
  }
  const { size } = await fs.promises.stat(file);
  if (size > 1.6 * 1024 ** 3) throw userError('laz_too_large', 'This LAZ file is too large to decompress on this machine. Convert it to LAS or crop it first.');
  const LazPerf = await createLazPerf();
  const data = await fs.promises.readFile(file);
  const filePtr = LazPerf._malloc(data.byteLength);
  const dataPtr = LazPerf._malloc(h.recordLength);
  const laszip = new LazPerf.LASZip();
  try {
    LazPerf.HEAPU8.set(data, filePtr);
    laszip.open(filePtr, data.byteLength);
    const decode = makeLasDecoder(h, onChunk);
    const buf = Buffer.alloc(CHUNK * h.recordLength);
    let done = 0;
    while (done < h.count) {
      const n = Math.min(CHUNK, h.count - done);
      for (let i = 0; i < n; i++) {
        laszip.getPoint(dataPtr);
        buf.set(LazPerf.HEAPU8.subarray(dataPtr, dataPtr + h.recordLength), i * h.recordLength);
      }
      decode(buf, n);
      done += n;
    }
  } finally {
    laszip.delete?.();
    LazPerf._free(filePtr);
    LazPerf._free(dataPtr);
  }
}

// ───────────────────────────── PLY ─────────────────────────────

const PLY_SIZE = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

async function readPlyHeader(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.toString('latin1', 0, bytesRead);
    const end = text.indexOf('end_header');
    if (!text.startsWith('ply') || end < 0) throw userError('ply_invalid', 'This is not a valid PLY file.');
    const dataStart = text.indexOf('\n', end) + 1;
    const lines = text.slice(0, end).split(/\r?\n/);
    let format = 'ascii', count = 0, current = null, firstElement = null;
    const props = [];
    for (const line of lines) {
      const t = line.trim().split(/\s+/);
      if (t[0] === 'format') format = t[1];
      else if (t[0] === 'element') { current = t[1]; if (!firstElement) firstElement = current; if (current === 'vertex') count = Number(t[2]); }
      else if (t[0] === 'property' && current === 'vertex') {
        if (t[1] === 'list') throw userError('ply_list', 'PLY files with list properties on vertices are not supported.');
        props.push({ type: t[1], name: t[2] });
      }
    }
    if (firstElement !== 'vertex' || !count) throw userError('ply_vertex', 'This PLY file has no vertex data Masar can read.');
    let offset = 0;
    for (const p of props) { p.size = PLY_SIZE[p.type]; p.offset = offset; offset += p.size; if (!p.size) throw userError('ply_type', `Unknown PLY property type "${p.type}".`); }
    return { format, count, props, recordLength: offset, dataStart };
  } finally { await fh.close(); }
}

function plyAccessors(h) {
  const find = (...names) => h.props.find((p) => names.includes(p.name));
  const a = { x: find('x'), y: find('y'), z: find('z'), r: find('red', 'r', 'diffuse_red'), g: find('green', 'g', 'diffuse_green'), b: find('blue', 'b', 'diffuse_blue'),
    dc0: find('f_dc_0'), dc1: find('f_dc_1'), dc2: find('f_dc_2'), cls: find('classification', 'class', 'scalar_Classification'), inten: find('intensity', 'scalar_Intensity') };
  if (!a.x || !a.y || !a.z) throw userError('ply_xyz', 'This PLY file has no x/y/z vertex properties.');
  a.hasRGB = !!((a.r && a.g && a.b) || (a.dc0 && a.dc1 && a.dc2));
  return a;
}

// One specialised reader per property (built once), rather than a type switch per value.
function plyGetter(dv, little) {
  const make = (p) => {
    const off = p.offset;
    switch (p.type) {
      case 'float': case 'float32': return (o) => dv.getFloat32(o + off, little);
      case 'double': case 'float64': return (o) => dv.getFloat64(o + off, little);
      case 'uchar': case 'uint8': return (o) => dv.getUint8(o + off);
      case 'char': case 'int8': return (o) => dv.getInt8(o + off);
      case 'ushort': case 'uint16': return (o) => dv.getUint16(o + off, little);
      case 'short': case 'int16': return (o) => dv.getInt16(o + off, little);
      case 'uint': case 'uint32': return (o) => dv.getUint32(o + off, little);
      default: return (o) => dv.getInt32(o + off, little);
    }
  };
  const cache = new Map();
  return (p, o) => { let f = cache.get(p); if (!f) { f = make(p); cache.set(p, f); } return f(o); };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const colourOf = (p, v) => (p.type.startsWith('float') || p.type === 'double' ? clamp255(v <= 1 ? v * 255 : v) : p.size === 2 ? v >> 8 : v);
const SH_C0 = 0.28209479177387814;

async function readPly(file, onChunk) {
  const h = await readPlyHeader(file);
  const a = plyAccessors(h);
  const chunk = makeChunk(a.hasRGB, !!a.cls, !!a.inten);
  const put = (i, get, o) => {
    chunk.x[i] = get(a.x, o); chunk.y[i] = get(a.y, o); chunk.z[i] = get(a.z, o);
    if (a.r && a.g && a.b) { chunk.r[i] = colourOf(a.r, get(a.r, o)); chunk.g[i] = colourOf(a.g, get(a.g, o)); chunk.b[i] = colourOf(a.b, get(a.b, o)); }
    else if (a.dc0) { chunk.r[i] = clamp255((0.5 + SH_C0 * get(a.dc0, o)) * 255); chunk.g[i] = clamp255((0.5 + SH_C0 * get(a.dc1, o)) * 255); chunk.b[i] = clamp255((0.5 + SH_C0 * get(a.dc2, o)) * 255); }
    if (a.cls) chunk.cls[i] = get(a.cls, o);
    if (a.inten) chunk.inten[i] = Math.min(65535, get(a.inten, o));
  };
  if (h.format === 'ascii') {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { start: h.dataStart }), crlfDelay: Infinity });
    let i = 0, total = 0;
    let row = null;
    const get = (p) => row[h.props.indexOf(p)];
    for await (const line of rl) {
      if (total >= h.count) break;
      row = line.trim().split(/\s+/).map(Number);
      if (row.length < h.props.length) continue;
      put(i, get, 0);
      i++; total++;
      if (i === CHUNK) { chunk.n = i; onChunk(chunk); i = 0; }
    }
    if (i) { chunk.n = i; onChunk(chunk); }
    return;
  }
  const little = h.format === 'binary_little_endian';
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK * h.recordLength);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const get = plyGetter(dv, little);
    const f32 = (p) => p && (p.type === 'float' || p.type === 'float32');
    const fast = f32(a.x) && f32(a.y) && f32(a.z) && little;      // the common case: float xyz, little-endian
    const [xo, yo, zo] = [a.x.offset, a.y.offset, a.z.offset];
    let remaining = h.count, pos = h.dataStart;
    while (remaining > 0) {
      const n = Math.min(CHUNK, remaining);
      const { bytesRead } = await fh.read(buf, 0, n * h.recordLength, pos);
      const got = Math.floor(bytesRead / h.recordLength);
      if (!got) break;
      for (let i = 0; i < got; i++) {
        const o = i * h.recordLength;
        put(i, get, o);
        if (fast) { chunk.x[i] = buf.readFloatLE(o + xo); chunk.y[i] = buf.readFloatLE(o + yo); chunk.z[i] = buf.readFloatLE(o + zo); }
      }
      chunk.n = got; onChunk(chunk);
      pos += got * h.recordLength; remaining -= got;
    }
  } finally { await fh.close(); }
}

// ───────────────────────────── Text: XYZ / PTS / CSV ─────────────────────────────

async function readText(file, onChunk) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const chunk = makeChunk(true, false, false);
  let i = 0, anyColour = false, floatColour = null;
  for await (const line of rl) {
    const t = line.trim();
    if (!t || t[0] === '#' || t[0] === '/') continue;
    const v = t.split(/[\s,;]+/).map(Number);
    if (v.length < 3 || Number.isNaN(v[0]) || Number.isNaN(v[1]) || Number.isNaN(v[2])) continue;
    chunk.x[i] = v[0]; chunk.y[i] = v[1]; chunk.z[i] = v[2];
    const c = v.length >= 7 ? 4 : v.length >= 6 ? 3 : -1;
    if (c > 0 && !Number.isNaN(v[c + 2])) {
      if (floatColour === null) floatColour = v[c] <= 1 && v[c + 1] <= 1 && v[c + 2] <= 1 && (v[c] % 1 !== 0 || v[c + 1] % 1 !== 0 || v[c + 2] % 1 !== 0);
      const k = floatColour ? 255 : 1;
      chunk.r[i] = clamp255(v[c] * k); chunk.g[i] = clamp255(v[c + 1] * k); chunk.b[i] = clamp255(v[c + 2] * k);
      anyColour = true;
    } else { chunk.r[i] = chunk.g[i] = chunk.b[i] = 0; }
    i++;
    if (i === CHUNK) { chunk.n = i; chunk.colourValid = anyColour; onChunk(chunk); i = 0; }
  }
  if (i) { chunk.n = i; chunk.colourValid = anyColour; onChunk(chunk); }
}

// ───────────────────────────── Public API ─────────────────────────────

export async function inspectCloud(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.las' || ext === '.laz') {
    const fh = await fs.promises.open(file, 'r');
    try { return lasInfo(await readLasHeader(fh)); } finally { await fh.close(); }
  }
  if (ext === '.ply') {
    const h = await readPlyHeader(file);
    const a = plyAccessors(h);
    return { format: 'ply', count: h.count, bounds: null, epsg: null, hasRGB: a.hasRGB, hasClass: !!a.cls };
  }
  return { format: 'text', count: null, bounds: null, epsg: null, hasRGB: null, hasClass: false };
}

export async function readCloud(file, onChunk) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.las' || ext === '.laz') return readLas(file, onChunk);
  if (ext === '.ply') return readPly(file, onChunk);
  if (CLOUD_EXT.includes(ext)) return readText(file, onChunk);
  throw userError('cloud_format', `"${path.basename(file)}" is not a point-cloud format Masar can read.`);
}
