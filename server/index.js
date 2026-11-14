// Masar web server — plain Node, no dependencies.  `npm start`
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { config } from './config.js';
import { db } from './db.js';
import * as auth from './auth.js';
import { enqueue, isBusy, resumeInterrupted, trailDir } from './jobs.js';
import { makeAlpineSample, makePhoneSample } from './sample.js';
import { fetchImagery } from './pipeline/imagery.js';
import { SUPPORTED_CRS } from './geo/proj.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.heic': 'image/heic' };
const KIND_BY_EXT = { cloud: ['.las', '.laz', '.ply', '.xyz', '.txt', '.csv', '.pts', '.asc', '.zip'], track: ['.gpx', '.kml', '.geojson', '.json'], photo: ['.jpg', '.jpeg', '.png', '.heic', '.webp'] };
const PAGES = { '/': 'index.html', '/login': 'login.html', '/setup': 'setup.html', '/trails': 'app/trails.html', '/new': 'app/new.html', '/capture': 'app/capture.html', '/team': 'app/team.html' };
const PROTECTED = new Set(['/trails', '/new', '/capture', '/team']);

class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const now = () => new Date().toISOString();

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 2e6) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'bad_json'); }
}

const gzipCache = new Map();
function sendFile(req, res, file, { cache = 'no-cache', encoding = null, type = null } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ETag: etag, 'Cache-Control': cache };
  if (encoding) headers['Content-Encoding'] = encoding;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  const compressible = !encoding && /^(text\/|application\/(json|manifest)|image\/svg)/.test(headers['Content-Type']) && stat.size > 1024 && stat.size < 4e6
    && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (compressible) {
    let hit = gzipCache.get(file);
    if (!hit || hit.etag !== etag) { hit = { etag, data: zlib.gzipSync(fs.readFileSync(file)) }; gzipCache.set(file, hit); }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': hit.data.length, Vary: 'Accept-Encoding' });
    res.end(req.method === 'HEAD' ? undefined : hit.data);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

const safeName = (name) => String(name || 'file').replace(/[/\\]/g, '_').replace(/[^\w.\- ()]+/g, '_').slice(-120) || 'file';
const kindOf = (name) => { const ext = path.extname(name).toLowerCase(); return Object.keys(KIND_BY_EXT).find((k) => KIND_BY_EXT[k].includes(ext)) || null; };

function publicTrail(t) {
  return { id: t.id, name: t.name, location: t.location, notes: t.notes, status: t.status, progress: t.progress, error: t.error, summary: t.summary || null,
    source: t.options?.source || null, synthetic: !!t.options?.synthetic, hasThumb: !!t.hasThumb, busy: isBusy(t.id),
    files: (t.files || []).map((f) => ({ id: f.id, name: f.name, size: f.size, received: f.received, kind: f.kind })),
    options: { epsg: t.options?.epsg ?? 'auto', corridor: t.options?.corridor ?? 60, upAxis: t.options?.upAxis ?? 'auto', aoi: t.options?.aoi ?? null },
    owner: db.users.find((u) => u.id === t.ownerId)?.name || null, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

function getTrail(id) {
  const t = db.trails.find((x) => x.id === id);
  if (!t) throw new HttpError(404, 'not_found');
  return t;
}

function cleanOptions(input = {}, base = {}) {
  const o = { ...base };
  if (input.source === 'aerial' || input.source === 'phone') o.source = input.source;
  if (input.epsg !== undefined) o.epsg = input.epsg === 'local' ? 'local' : Number(input.epsg) > 0 ? Number(input.epsg) : 'auto';
  if (input.corridor !== undefined) o.corridor = Math.max(10, Math.min(500, Number(input.corridor) || 60));
  if (['auto', 'y', 'z'].includes(input.upAxis)) o.upAxis = input.upAxis;
  if (input.aoi !== undefined) o.aoi = input.aoi && Number.isFinite(+input.aoi.lat) && Number.isFinite(+input.aoi.lon) ? { lat: +input.aoi.lat, lon: +input.aoi.lon, radius: +input.aoi.radius || 150 } : null;
  return o;
}

function updateMeta(id, fn) {
  const file = path.join(trailDir(id), 'out', 'meta.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(meta);
  fs.writeFileSync(file, JSON.stringify(meta));
  return meta;
}

// ───────────────────────────── API routes ─────────────────────────────
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

route('GET', /^\/api\/health$/, (req, res) => sendJson(res, 200, { ok: true, name: 'masar', version: '1.0.0' }), { open: true });

route('GET', /^\/api\/me$/, (req, res, ctx) => sendJson(res, 200, { user: auth.publicUser(ctx.user), needsSetup: db.users.length === 0 }), { open: true });

route('POST', /^\/api\/setup$/, async (req, res) => {
  if (db.users.length) throw new HttpError(403, 'setup_done');
  const body = await readJson(req);
  const user = auth.createUser({ ...body, role: 'admin' });
  auth.startSession(req, res, user);
  sendJson(res, 201, { user: auth.publicUser(user) });
}, { open: true });

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  const ip = auth.clientIp(req);
  if (!auth.rateLimit(`ip:${ip}`, 30, 10 * 60e3) || !auth.rateLimit(`login:${ip}:${email}`, 8, 10 * 60e3)) throw new HttpError(429, 'too_many_attempts');
  const user = db.users.find((u) => u.email === email);
  // run the hash even for unknown emails so timing does not reveal which accounts exist
  const ok = auth.verifyPassword(String(body.password || ''), user ? user.password : 'scrypt$00$' + '00'.repeat(64)) && !!user;
  if (!ok) throw new HttpError(401, 'bad_credentials');
  auth.startSession(req, res, user);
  sendJson(res, 200, { user: auth.publicUser(user) });
}, { open: true });

route('POST', /^\/api\/logout$/, (req, res) => { auth.endSession(req, res); sendJson(res, 200, { ok: true }); }, { open: true });

route('GET', /^\/api\/users$/, (req, res) => sendJson(res, 200, { users: db.users.map(auth.publicUser) }));
route('POST', /^\/api\/users$/, async (req, res) => {
  const body = await readJson(req);
  sendJson(res, 201, { user: auth.publicUser(auth.createUser(body)) });
}, { admin: true });
route('DELETE', /^\/api\/users\/([\w-]+)$/, (req, res, ctx, m) => {
  const user = db.users.find((u) => u.id === m[1]);
  if (!user) throw new HttpError(404, 'not_found');
  if (user.id === ctx.user.id) throw new HttpError(400, 'cannot_remove_self');
  if (user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length <= 1) throw new HttpError(400, 'last_admin');
  db.users = db.users.filter((u) => u.id !== user.id);
  auth.dropSessionsFor(user.id);
  db.save();
  sendJson(res, 200, { ok: true });
}, { admin: true });
route('POST', /^\/api\/users\/([\w-]+)\/password$/, async (req, res, ctx, m) => {
  const body = await readJson(req);
  const user = db.users.find((u) => u.id === m[1]);
  if (!user) throw new HttpError(404, 'not_found');
  const self = user.id === ctx.user.id;
  if (!self && ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden');
  if (self && !auth.verifyPassword(String(body.current || ''), user.password)) throw new HttpError(401, 'bad_credentials');
  const bad = auth.validatePassword(body.password);
  if (bad) throw new HttpError(400, bad);
  user.password = auth.hashPassword(body.password);
  if (!self) auth.dropSessionsFor(user.id);
  db.save();
  sendJson(res, 200, { ok: true });
});

route('GET', /^\/api\/config$/, (req, res) => sendJson(res, 200, { crs: SUPPORTED_CRS, pointBudget: config.pointBudget, maxUploadBytes: config.maxUploadBytes, network: config.allowNetwork }));

route('GET', /^\/api\/trails$/, (req, res) => sendJson(res, 200, { trails: db.trails.map(publicTrail).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) }));

route('POST', /^\/api\/trails$/, async (req, res, ctx) => {
  const body = await readJson(req);
  const trail = { id: db.id(6), name: String(body.name || 'Untitled trail').trim().slice(0, 120) || 'Untitled trail', location: String(body.location || '').slice(0, 160),
    notes: String(body.notes || '').slice(0, 2000), status: 'draft', progress: null, error: null, files: [], options: cleanOptions(body.options),
    ownerId: ctx.user.id, createdAt: now(), updatedAt: now() };
  fs.mkdirSync(path.join(trailDir(trail.id), 'raw'), { recursive: true });
  db.trails.push(trail); db.save();
  sendJson(res, 201, { trail: publicTrail(trail) });
});

route('GET', /^\/api\/trails\/(\w+)$/, (req, res, ctx, m) => sendJson(res, 200, { trail: publicTrail(getTrail(m[1])) }));

route('PATCH', /^\/api\/trails\/(\w+)$/, async (req, res, ctx, m) => {
  const trail = getTrail(m[1]), body = await readJson(req);
  if (body.name !== undefined) trail.name = String(body.name).trim().slice(0, 120) || trail.name;
  if (body.location !== undefined) trail.location = String(body.location).slice(0, 160);
  if (body.notes !== undefined) trail.notes = String(body.notes).slice(0, 2000);
  if (body.options) trail.options = cleanOptions(body.options, trail.options);
  trail.updatedAt = now(); db.save();
  if (trail.status === 'ready' && body.name !== undefined) { try { updateMeta(trail.id, (meta) => { meta.name = trail.name; }); } catch { /* not built yet */ } }
  sendJson(res, 200, { trail: publicTrail(trail) });
});

route('DELETE', /^\/api\/trails\/(\w+)$/, (req, res, ctx, m) => {
  const trail = getTrail(m[1]);
  if (isBusy(trail.id)) throw new HttpError(409, 'busy');
  db.trails = db.trails.filter((t) => t.id !== trail.id); db.save();
  fs.rmSync(trailDir(trail.id), { recursive: true, force: true });
  sendJson(res, 200, { ok: true });
});

// Uploads are chunked (Cloudflare caps request bodies at 100 MB) and resumable.
route('POST', /^\/api\/trails\/(\w+)\/files$/, async (req, res, ctx, m) => {
  const trail = getTrail(m[1]), body = await readJson(req);
  const name = safeName(body.name), size = Number(body.size);
  const kind = ['cloud', 'track', 'photo'].includes(body.kind) ? body.kind : kindOf(name);
  if (!kind) throw new HttpError(400, 'unsupported_file');
  if (!(size > 0)) throw new HttpError(400, 'empty_file');
  const total = trail.files.reduce((s, f) => s + f.size, 0) + size;
  if (total > config.maxUploadBytes) throw new HttpError(413, 'upload_limit');
  const id = db.id(5);
  const file = { id, name, stored: `${id}-${name}`, size, received: 0, kind, meta: body.meta && typeof body.meta === 'object' ? { lat: +body.meta.lat, lon: +body.meta.lon, heading: body.meta.heading == null ? null : +body.meta.heading, t: body.meta.t || null } : null };
  fs.mkdirSync(path.join(trailDir(trail.id), 'raw'), { recursive: true });
  fs.writeFileSync(path.join(trailDir(trail.id), 'raw', file.stored), '');
  trail.files.push(file); trail.updatedAt = now(); db.save();
  sendJson(res, 201, { file: { id, name, size, received: 0, kind } });
});

route('PUT', /^\/api\/trails\/(\w+)\/files\/(\w+)$/, async (req, res, ctx, m, url) => {
  const trail = getTrail(m[1]);
  const file = trail.files.find((f) => f.id === m[2]);
  if (!file) throw new HttpError(404, 'not_found');
  const offset = Number(url.searchParams.get('offset') || 0);
  if (offset !== file.received) { req.resume(); return sendJson(res, 409, { error: 'offset_mismatch', received: file.received }); }
  const target = path.join(trailDir(trail.id), 'raw', file.stored);
  const out = fs.createWriteStream(target, { flags: 'r+', start: offset });
  let written = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      written += c.length;
      if (offset + written > file.size || written > 96 * 1024 * 1024) { req.destroy(); out.destroy(); reject(new HttpError(413, 'too_large')); }
    });
    req.pipe(out);
    out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
    req.on('aborted', () => { out.destroy(); reject(new HttpError(400, 'aborted')); });
  }).catch((err) => { try { fs.truncateSync(target, file.received); } catch { /* ignore */ } throw err; });
  file.received = offset + written; db.save();
  sendJson(res, 200, { received: file.received, complete: file.received === file.size });
});

route('DELETE', /^\/api\/trails\/(\w+)\/files\/(\w+)$/, (req, res, ctx, m) => {
  const trail = getTrail(m[1]);
  const file = trail.files.find((f) => f.id === m[2]);
  if (!file) throw new HttpError(404, 'not_found');
  fs.rmSync(path.join(trailDir(trail.id), 'raw', file.stored), { force: true });
  trail.files = trail.files.filter((f) => f.id !== file.id); db.save();
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/trails\/(\w+)\/process$/, async (req, res, ctx, m) => {
  const trail = getTrail(m[1]), body = await readJson(req);
  if (body.options) trail.options = cleanOptions(body.options, trail.options);
  if (body.resetPath) delete trail.options.path;
  if (trail.files.some((f) => f.received !== f.size)) throw new HttpError(400, 'upload_incomplete');
  if (!trail.files.some((f) => f.kind === 'cloud')) throw new HttpError(400, 'no_cloud');
  enqueue(trail, 'build');
  sendJson(res, 202, { trail: publicTrail(trail) });
});

route('PUT', /^\/api\/trails\/(\w+)\/path$/, async (req, res, ctx, m) => {
  const trail = getTrail(m[1]), body = await readJson(req);
  if (trail.status !== 'ready') throw new HttpError(409, 'not_ready');
  const pts = Array.isArray(body.points) ? body.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, 5000).map((p) => [+p[0], +p[1]]) : [];
  if (pts.length < 2) throw new HttpError(400, 'path_short');
  trail.options.path = pts; db.save();
  enqueue(trail, 'reanalyze', { linePoints: pts });
  sendJson(res, 202, { trail: publicTrail(trail) });
});

route('GET', /^\/api\/trails\/(\w+)\/osm-paths$/, (req, res, ctx, m) => {
  const file = path.join(trailDir(getTrail(m[1]).id), 'out', 'osm.json');
  if (!fs.existsSync(file)) return sendJson(res, 200, { paths: [] });
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'meta.json'), 'utf8'));
  const [W, H] = meta.size;
  const paths = JSON.parse(fs.readFileSync(file, 'utf8')).paths
    .map((p) => ({ ...p, pts: p.pts.filter((q) => q.x >= 0 && q.y >= 0 && q.x <= W && q.y <= H).map((q) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]) }))
    .filter((p) => p.pts.length >= 2);
  sendJson(res, 200, { paths });
});

route('PUT', /^\/api\/trails\/(\w+)\/texture$/, async (req, res, ctx, m, url) => {
  const trail = getTrail(m[1]);
  if (trail.status !== 'ready') throw new HttpError(409, 'not_ready');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[String(req.headers['content-type']).split(';')[0]];
  const bounds = String(url.searchParams.get('bounds') || '').split(',').map(Number);
  if (!ext || bounds.length !== 4 || bounds.some((v) => !Number.isFinite(v))) throw new HttpError(400, 'bad_texture');
  const data = await readBody(req, 40e6);
  const texture = { file: `texture.${ext}`, bounds, attribution: String(url.searchParams.get('attribution') || '').slice(0, 120), v: Date.now() };
  fs.writeFileSync(path.join(trailDir(trail.id), 'out', texture.file), data);
  updateMeta(trail.id, (meta) => { meta.texture = texture; });
  trail.options.texture = texture; db.save();
  sendJson(res, 200, { texture });
});

route('POST', /^\/api\/trails\/(\w+)\/imagery$/, async (req, res, ctx, m) => {
  const trail = getTrail(m[1]);
  if (trail.status !== 'ready') throw new HttpError(409, 'not_ready');
  if (!config.allowNetwork) throw new HttpError(400, 'network_off');
  const meta = JSON.parse(fs.readFileSync(path.join(trailDir(trail.id), 'out', 'meta.json'), 'utf8'));
  if (!meta.crs || meta.synthetic) throw new HttpError(400, 'not_georeferenced');
  const [ox, oy] = meta.origin, [W, H] = meta.size;
  let img;
  try { img = await fetchImagery({ epsg: meta.crs.epsg, bounds: { minX: ox, minY: oy, maxX: ox + W, maxY: oy + H } }); }
  catch (err) { throw new HttpError(502, 'imagery_failed', String(err.message || err)); }
  const ext = img.type.includes('png') ? 'png' : 'jpg';
  const texture = { file: `texture.${ext}`, bounds: [0, 0, W, H], attribution: img.attribution, provider: img.provider, v: Date.now() };
  fs.writeFileSync(path.join(trailDir(trail.id), 'out', texture.file), img.data);
  updateMeta(trail.id, (mm) => { mm.texture = texture; });
  trail.options.texture = texture; db.save();
  sendJson(res, 200, { texture });
});

route('PUT', /^\/api\/trails\/(\w+)\/thumb$/, async (req, res, ctx, m) => {
  const trail = getTrail(m[1]);
  const data = await readBody(req, 2e6);
  if (data.length < 100 || data.readUInt16BE(0) !== 0xffd8) throw new HttpError(400, 'bad_image');
  fs.mkdirSync(path.join(trailDir(trail.id), 'out'), { recursive: true });
  fs.writeFileSync(path.join(trailDir(trail.id), 'out', 'thumb.jpg'), data);
  trail.hasThumb = true; db.save();
  sendJson(res, 200, { ok: true });
});

const DATA_FILES = { 'meta.json': {}, 'report.json': {}, 'thumb.jpg': {}, 'points.bin': { file: 'points.bin.gz', encoding: 'gzip', type: 'application/octet-stream' },
  'dem.bin': { file: 'dem.bin.gz', encoding: 'gzip', type: 'application/octet-stream' }, 'texture.jpg': {}, 'texture.png': {}, 'texture.webp': {} };
route('GET', /^\/api\/trails\/(\w+)\/data\/([\w.]+)$/, (req, res, ctx, m) => {
  const trail = getTrail(m[1]), spec = DATA_FILES[m[2]];
  if (!spec) throw new HttpError(404, 'not_found');
  const ok = sendFile(req, res, path.join(trailDir(trail.id), 'out', spec.file || m[2]), { cache: 'private, no-cache', encoding: spec.encoding, type: spec.type });
  if (!ok) throw new HttpError(404, 'not_found');
});
route('GET', /^\/api\/trails\/(\w+)\/photo\/(\w+)$/, (req, res, ctx, m) => {
  const trail = getTrail(m[1]);
  const file = trail.files.find((f) => f.id === m[2] && f.kind === 'photo');
  if (!file || !sendFile(req, res, path.join(trailDir(trail.id), 'raw', file.stored), { cache: 'private, max-age=3600' })) throw new HttpError(404, 'not_found');
});

route('POST', /^\/api\/sample$/, async (req, res, ctx) => {
  const body = await readJson(req);
  const kind = body.kind === 'phone' ? 'phone' : 'alpine';
  const id = db.id(6), dir = trailDir(id), rawDir = path.join(dir, 'raw');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const s = kind === 'phone' ? makePhoneSample(rawDir) : makeAlpineSample(rawDir);
  const options = { ...s.options };
  if (s.texture) {
    fs.renameSync(path.join(rawDir, s.texture.file), path.join(dir, 'out', 'texture.png'));
    options.texture = { file: 'texture.png', bounds: s.texture.bounds, attribution: s.texture.attribution, v: Date.now() };
  }
  const trail = { id, name: s.name, location: s.location, notes: '', status: 'draft', progress: null, error: null, options, ownerId: ctx.user.id, createdAt: now(), updatedAt: now(),
    files: s.files.map((f) => { const size = fs.statSync(path.join(rawDir, f.name)).size; return { id: db.id(5), name: f.name, stored: f.name, size, received: size, kind: f.kind, meta: null }; }) };
  db.trails.push(trail);
  enqueue(trail, 'build');
  sendJson(res, 202, { trail: publicTrail(trail) });
});

// ───────────────────────────── Request handling ─────────────────────────────
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://local');
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  const user = auth.currentUser(req);

  if (pathname.startsWith('/api/')) {
    // Cross-site requests cannot change anything: state-changing calls must come from our own pages.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) { let host = ''; try { host = new URL(origin).host; } catch { /* malformed */ } if (host !== req.headers.host) throw new HttpError(403, 'cross_origin'); }
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      if (!r.open && !user) throw new HttpError(401, 'unauthenticated');
      if (r.admin && user.role !== 'admin') throw new HttpError(403, 'forbidden');
      return r.handler(req, res, { user }, m, url);
    }
    throw new HttpError(404, 'not_found');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
  let page = PAGES[pathname];
  let guarded = PROTECTED.has(pathname);
  if (/^\/trail\/\w+$/.test(pathname)) { page = 'app/viewer.html'; guarded = true; }
  else if (/^\/trail\/\w+\/report$/.test(pathname)) { page = 'app/report.html'; guarded = true; }
  if (page) {
    if (guarded && !user) return redirect(res, db.users.length ? `/login?next=${encodeURIComponent(pathname)}` : '/setup');
    if (pathname === '/setup' && db.users.length) return redirect(res, '/login');
    if (pathname === '/login' && !db.users.length) return redirect(res, '/setup');
    if ((pathname === '/login' || pathname === '/setup') && user) return redirect(res, '/trails');
    if (sendFile(req, res, path.join(config.publicDir, page))) return;
  }
  const file = path.normalize(path.join(config.publicDir, pathname));
  if (file.startsWith(config.publicDir + path.sep) && !pathname.startsWith('/app/')) {
    // pre-compressed binaries (the landing page's demo scene) are stored as .bin.gz
    if (file.endsWith('.bin') && sendFile(req, res, `${file}.gz`, { encoding: 'gzip', type: 'application/octet-stream' })) return;
    if (sendFile(req, res, file)) return;
  }
  res.statusCode = 404;
  if (!sendFile(req, res, path.join(config.publicDir, '404.html'))) { res.setHeader('Content-Type', 'text/plain'); res.end('Not found'); }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: err.code || 'server_error', message: err.status ? err.message : 'Something went wrong on the server.' });
  });
});
server.requestTimeout = 0;            // large uploads on slow links must not be cut off
server.headersTimeout = 60_000;

if (!db.users.length && config.admin.email && config.admin.password) {
  try { auth.createUser({ ...config.admin, role: 'admin' }); console.log(`Created admin account ${config.admin.email} from the environment.`); }
  catch (err) { console.error(`Could not create the admin account from the environment: ${err.message}`); }
}
resumeInterrupted();

server.listen(config.port, config.host, () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`\n  Masar is running\n  ─ on this computer   http://localhost:${config.port}`);
  if (lan && config.host === '0.0.0.0') console.log(`  ─ on your network    http://${lan}:${config.port}`);
  console.log(`  ─ data folder        ${config.dataDir}`);
  if (!db.users.length) console.log(`\n  First run: open http://localhost:${config.port}/setup to create the admin account.`);
  console.log('');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.saveNow(); process.exit(0); });
