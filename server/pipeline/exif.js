// Minimal EXIF reader: pulls GPS position, altitude and compass heading out of a JPEG.
import fs from 'node:fs';

export function readExifGps(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(262144);
    const len = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.readUInt16BE(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 < len) {
      if (buf[p] !== 0xff) break;
      const marker = buf[p + 1], size = buf.readUInt16BE(p + 2);
      if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 8) === 'Exif') return parseTiff(buf.subarray(p + 10, Math.min(len, p + 2 + size)));
      if (marker === 0xda) break;
      p += 2 + size;
    }
  } catch { /* not a readable JPEG */ }
  return null;
}

function parseTiff(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const entries = (off) => {
    const out = new Map();
    if (off + 2 > t.length) return out;
    const n = u16(off);
    for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; if (e + 12 > t.length) break; out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 }); }
    return out;
  };
  const gpsPtr = entries(u32(4)).get(0x8825);
  if (!gpsPtr) return null;
  const gps = entries(u32(gpsPtr.at));
  const rationals = (tag) => {
    const e = gps.get(tag); if (!e) return null;
    const off = u32(e.at); const out = [];
    for (let i = 0; i < e.count; i++) { const den = u32(off + i * 8 + 4); out.push(den ? u32(off + i * 8) / den : 0); }
    return out;
  };
  const ascii = (tag) => { const e = gps.get(tag); return e ? String.fromCharCode(t[e.at]) : null; };
  const lat = rationals(2), lon = rationals(4);
  if (!lat || !lon || lat.length < 3 || lon.length < 3) return null;
  const dms = (v) => v[0] + v[1] / 60 + v[2] / 3600;
  const alt = rationals(6), dir = rationals(17);
  return { lat: dms(lat) * (ascii(1) === 'S' ? -1 : 1), lon: dms(lon) * (ascii(3) === 'W' ? -1 : 1),
    alt: alt ? alt[0] : null, heading: dir ? dir[0] : null };
}
