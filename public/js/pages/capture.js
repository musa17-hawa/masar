// Phone capture: coaches a survey with a LiDAR iPhone. This page records the GPS track and photos;
// the scan itself is made in a scanner app (browsers cannot read the LiDAR sensor), then uploaded here and built.
// The session survives reloads: iOS often discards the tab while a scanner app is in front.
import { mountApp, t, api, h, $, fmt, icon, toast, sleep, confirmDialog } from '../core.js';
import { uploadFile } from '../uploader.js';

await mountApp('capture');
document.title = `${t('nav.capture')} — Masar`;
const root = h('main', { class: 'page' });
$('#app').replaceWith(root);

// ───────── session (localStorage for the track, IndexedDB for photo files) ─────────
const KEY = 'masar.capture';
const fresh = () => ({ step: 0, points: [], dist: 0, elapsed: 0, photos: [], name: '' });
let s = fresh();
try { s = { ...s, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* storage blocked or corrupt */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } };

const idb = () => new Promise((res, rej) => { const r = indexedDB.open('masar-capture', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const photoStore = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('photos', mode); const rq = fn(tx.objectStore('photos')); tx.oncomplete = () => { db.close(); res(rq?.result); }; tx.onerror = () => { db.close(); rej(tx.error); }; }); };
const putPhoto = (id, blob) => photoStore('readwrite', (o) => o.put(blob, id));
const getPhoto = (id) => photoStore('readonly', (o) => o.get(id));
const clearPhotos = () => photoStore('readwrite', (o) => o.clear()).catch(() => {});

// ───────── live recording ─────────
const live = { on: false, watch: null, lock: null, fix: null, speed: null, heading: null, since: 0, timer: null, error: null };
const rad = Math.PI / 180;
const metres = (a, b) => { const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad), y = (b.lat - a.lat) * rad; return Math.hypot(x, y) * 6371000; };
const elapsed = () => s.elapsed + (live.on ? Date.now() - live.since : 0);
const bank = () => { if (live.on) { s.elapsed += Date.now() - live.since; live.since = Date.now(); } save(); };   // keep the running time across reloads
const clock = (ms) => { const sec = Math.floor(ms / 1000); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };

function onFix(pos) {
  const c = pos.coords;
  const p = { lat: +c.latitude.toFixed(7), lon: +c.longitude.toFixed(7), ele: c.altitude == null ? null : +c.altitude.toFixed(1), acc: Math.round(c.accuracy), t: pos.timestamp };
  live.fix = p; live.speed = c.speed; live.error = null;
  const last = s.points.at(-1);
  // keep a point only when it is trustworthy and far enough from the last one to be movement rather than jitter
  if (p.acc <= 25 && (!last || metres(last, p) >= Math.max(3, p.acc * 0.4))) {
    if (last) s.dist += metres(last, p);
    s.points.push(p); bank();
  }
  paintLive();
}
function onFixError(err) { live.error = err.code === 1 ? 'denied' : 'unavailable'; if (err.code === 1) stop(); paintLive(); }
const onHeading = (e) => { const v = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null); if (v != null) live.heading = Math.round(v); };
async function keepAwake() { try { live.lock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or refused */ } }

async function start() {
  if (!('geolocation' in navigator) || !isSecureContext) { toast(t('cap.insecure'), 'bad'); return; }
  try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch { /* compass is optional */ }
  addEventListener('deviceorientation', onHeading);
  live.on = true; live.since = Date.now(); live.error = null;
  live.watch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  keepAwake();
  live.timer = setInterval(paintLive, 1000);
  render();
}
function stop() {
  if (!live.on) return;
  navigator.geolocation.clearWatch(live.watch); clearInterval(live.timer); removeEventListener('deviceorientation', onHeading);
  live.lock?.release?.().catch(() => {}); live.lock = null;
  s.elapsed += Date.now() - live.since; live.on = false; save();
  render();
}
document.addEventListener('visibilitychange', () => { if (live.on && document.visibilityState === 'visible') keepAwake(); else bank(); });
addEventListener('pagehide', bank);

function status() {
  if (live.error === 'denied') return ['bad', t('cap.st.denied')];
  if (live.error) return ['', t('cap.st.unavailable')];
  if (!live.on) return s.points.length ? ['info', t('cap.st.paused')] : ['info', t('cap.st.idle')];
  if (!live.fix) return ['', t('cap.st.waiting')];
  if (live.fix.acc > 25) return ['', t('cap.st.weak', { v: fmt.m(live.fix.acc) })];
  if (live.speed != null && live.speed > 1.8) return ['', t('cap.st.fast')];
  return ['info', t('cap.st.good')];
}
function paintLive() {
  const box = $('#cap-live'); if (!box) return;
  box.querySelector('.d').textContent = fmt.dist(s.dist);
  box.querySelector('.t').textContent = clock(elapsed());
  box.querySelector('.a').textContent = live.fix ? `±${fmt.m(live.fix.acc)}` : '–';
  const [cls, text] = status(), st = $('#cap-status');
  st.className = `callout ${cls}`; st.textContent = text;
}

async function addPhoto(file) {
  if (!file) return;
  const n = s.photos.length + 1, id = `p${Date.now().toString(36)}`;
  const name = `masar-photo-${String(n).padStart(2, '0')}.${/png$/i.test(file.type) ? 'png' : /heic|heif/i.test(file.type) ? 'heic' : 'jpg'}`;
  try { await putPhoto(id, file); } catch { toast(t('cap.photoFailed'), 'bad'); return; }
  const f = live.fix && Date.now() - live.fix.t < 60000 ? live.fix : null;
  s.photos.push({ id, name, type: file.type || 'image/jpeg', lat: f?.lat ?? null, lon: f?.lon ?? null, heading: live.heading, t: new Date().toISOString() });
  save(); toast(t(f ? 'cap.photoSaved' : 'cap.photoSavedNoFix')); render();
}

function gpx() {
  const pts = s.points.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele == null ? '' : `<ele>${p.ele}</ele>`}<time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n');
  const name = (s.name || 'Masar capture').replace(/[<&>]/g, '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Masar" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${name}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
}
async function reset() {
  if (!await confirmDialog({ title: t('cap.resetTitle'), body: t('cap.resetBody'), confirm: t('cap.reset'), danger: true })) return;
  stop(); await clearPhotos(); s = fresh(); save(); Object.assign(run, { on: false, error: null, done: false, trail: null, sent: null }); scan = null; render();
}

// ───────── views ─────────
const STEPS = ['cap.step.prepare', 'cap.step.track', 'cap.step.scan', 'cap.step.build'];
const go = (n) => { s.step = n; save(); render(); scrollTo(0, 0); };
const routeBar = () => h('ol', { class: 'route', 'aria-label': t('new.progress') }, STEPS.map((k, i) => h('li', { class: i < s.step ? 'done' : i === s.step ? 'now' : '', 'aria-current': i === s.step ? 'step' : null },
  h('span', { class: `blaze ${i < s.step ? 'on' : i === s.step ? 'now' : ''}` }), `${i + 1}. ${t(k)}`)));
const actions = (back, next) => h('div', { class: 'step-actions' }, back != null ? h('button', { class: 'btn ghost', type: 'button', onclick: () => go(back), html: `${icon('back', 'flip')}<span>${t('common.back')}</span>` }) : h('span'), next);
const nextBtn = (label, n, disabled) => h('button', { class: 'btn go', type: 'button', disabled, onclick: () => go(n), html: `<span>${label}</span>${icon('next', 'flip')}` });
const list = (keys, tag = 'ul') => h(tag, {}, keys.map((k) => h('li', {}, t(k))));

function stepPrepare() {
  const ok = (v) => h('span', { class: `blaze ${v ? 'on' : ''}` });
  const check = (v, title, body) => h('li', {}, ok(v), h('span', {}, title), h('small', {}, body));
  const secure = isSecureContext && 'geolocation' in navigator;
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, t('cap.prepare.title')), h('p', { class: 'muted' }, t('cap.prepare.lead')),
      h('p', { class: 'callout info' }, t('cap.prepare.why')),
      h('h3', { style: 'margin-top:1.75rem' }, t('cap.prepare.packTitle')), list(['cap.prepare.pack1', 'cap.prepare.pack2', 'cap.prepare.pack3', 'cap.prepare.pack4', 'cap.prepare.pack5']),
      h('h3', { style: 'margin-top:1.5rem' }, t('cap.prepare.planTitle')),
      h('div', { class: 'choice-grid' },
        h('div', { class: 'choice', style: 'cursor:default', html: `${icon('walk')}<strong>${t('cap.plan.solo')}</strong><span>${t('cap.plan.soloBody')}</span>` }),
        h('div', { class: 'choice', style: 'cursor:default', html: `${icon('team')}<strong>${t('cap.plan.pair')}</strong><span>${t('cap.plan.pairBody')}</span>` })),
      actions(null, nextBtn(t('cap.prepare.next'), 1))),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('cap.check.title')),
      h('ul', { class: 'need-list' },
        check(secure, t('cap.check.https'), t(secure ? 'cap.check.httpsOk' : 'cap.insecure')),
        check('wakeLock' in navigator, t('cap.check.awake'), t('wakeLock' in navigator ? 'cap.check.awakeOk' : 'cap.check.awakeNo')),
        check(false, t('cap.check.lidar'), t('cap.check.lidarBody')),
        check(false, t('cap.check.app'), t('cap.check.appBody'))),
      s.points.length || s.photos.length ? h('p', { class: 'callout' }, h('span', {}, t('cap.resume', { n: s.points.length, p: s.photos.length }), ' ', h('button', { class: 'btn quiet sm', type: 'button', onclick: reset }, t('cap.reset')))) : null));
}

function stepTrack() {
  const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => { addPhoto(e.target.files[0]); e.target.value = ''; } });
  const [cls, text] = status();
  const strip = h('div', { class: 'photo-strip' });
  for (const p of s.photos.slice(-12)) getPhoto(p.id).then((blob) => { if (blob) { const img = h('img', { alt: p.name }); img.src = URL.createObjectURL(blob); strip.append(img); } }).catch(() => {});
  const dl = h('a', { class: 'btn quiet sm', download: 'masar-capture.gpx', html: `${icon('download')}<span>${t('cap.track.gpx')}</span>` });
  if (s.points.length >= 2) dl.href = URL.createObjectURL(new Blob([gpx()], { type: 'application/gpx+xml' }));
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, t('cap.track.title')), h('p', { class: 'muted' }, t('cap.track.lead')),
      h('div', { class: 'live', id: 'cap-live' }, h('div', {}, h('b', { class: 'd' }, fmt.dist(s.dist)), h('span', {}, t('cap.track.distance'))), h('div', {}, h('b', { class: 't' }, clock(elapsed())), h('span', {}, t('cap.track.time'))), h('div', {}, h('b', { class: 'a' }, live.fix ? `±${fmt.m(live.fix.acc)}` : '–'), h('span', {}, t('cap.track.accuracy')))),
      h('p', { class: `callout ${cls}`, id: 'cap-status', role: 'status' }, text),
      h('div', { class: 'btn-row', style: 'margin-top:1rem' },
        live.on ? h('button', { class: 'btn', type: 'button', onclick: stop, html: `${icon('pause')}<span>${t('cap.track.pause')}</span>` })
          : h('button', { class: 'btn go', type: 'button', onclick: start, html: `${icon('gps')}<span>${t(s.points.length ? 'cap.track.resume' : 'cap.track.start')}</span>` }),
        input, h('button', { class: 'btn ghost', type: 'button', onclick: () => input.click(), html: `${icon('camera')}<span>${t('cap.track.photo')}</span>` })),
      s.photos.length ? h('div', { style: 'margin-top:1.25rem' }, h('p', { class: 'small muted', style: 'margin:0 0 .4rem' }, t('cap.track.photos', { n: s.photos.length })), strip) : null,
      s.points.length >= 2 ? h('p', { style: 'margin-top:1rem' }, dl) : null,
      actions(0, nextBtn(t('common.next'), 2))),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('cap.track.tipsTitle')), list(['cap.track.tip1', 'cap.track.tip2', 'cap.track.tip3', 'cap.track.tip4']),
      h('h3', { style: 'margin-top:1.25rem' }, t('cap.track.photoTitle')), list(['cap.track.photoTip1', 'cap.track.photoTip2', 'cap.track.photoTip3'])));
}

const ART = {
  tilt: '<path d="M10 84h76" stroke="#A9744F"/><rect x="36" y="14" width="18" height="34" rx="3" transform="rotate(-38 45 31)" fill="#FBFBF7"/><path d="M52 44 34 84M56 46l8 38M60 44l24 40" stroke="#D8412F" stroke-dasharray="3 4"/>',
  pace: '<path d="M10 70c18-14 30 8 46-6s22-18 30-16" stroke="#A9744F"/><circle cx="24" cy="63" r="4" fill="#D8412F" stroke="none"/><path d="M36 30h26M54 23l8 7-8 7" /><path d="M20 44h14M22 50h10" stroke-opacity=".45"/>',
  sweep: '<path d="M38 88c-4-26 18-40 10-78M62 88c-4-26 18-40 10-78" stroke="#A9744F"/><path d="M30 70l44-8-40-10 42-8-38-10" stroke="#D8412F"/><circle cx="30" cy="70" r="3.5" fill="#D8412F" stroke="none"/>',
  steps: '<path d="M10 80h20V64h20V48h20V32h18" /><path d="M24 46c4-18 22-28 40-24" stroke="#D8412F" stroke-dasharray="3 4"/><path d="M58 16l7 6-8 5" stroke="#D8412F"/>',
  loop: '<path d="M14 76c10-30 30-40 68-52" stroke="#A9744F"/><path d="M26 60c14-4 20 6 10 12s-18-6-4-14" stroke="#D8412F"/><path d="M60 40l16 16M76 40 60 56" stroke="#D8412F"/>',
};
const pose = (art, n) => h('div', { class: 'pose' }, h('span', { html: `<svg viewBox="0 0 96 96" fill="none" stroke="#13252C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ART[art]}</svg>` }), h('div', {}, h('h4', {}, t(`cap.scan.p${n}`)), h('p', {}, t(`cap.scan.p${n}Body`))));

function stepScan() {
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, t('cap.scan.title')), h('p', { class: 'muted' }, t('cap.scan.lead')),
      h('h3', { style: 'margin-top:1.25rem' }, t('cap.scan.setupTitle')), list(['cap.scan.setup1', 'cap.scan.setup2', 'cap.scan.setup3'], 'ol'),
      h('h3', { style: 'margin-top:1.5rem' }, t('cap.scan.moveTitle')),
      pose('tilt', 1), pose('pace', 2), pose('sweep', 3), pose('steps', 4), pose('loop', 5),
      h('h3', { style: 'margin-top:1.5rem' }, t('cap.scan.exportTitle')), list(['cap.scan.export1', 'cap.scan.export2', 'cap.scan.export3'], 'ol'),
      actions(1, nextBtn(t('cap.scan.next'), 3))),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('cap.scan.limitsTitle')), list(['cap.scan.limit1', 'cap.scan.limit2', 'cap.scan.limit3', 'cap.scan.limit4']),
      h('p', { class: 'small muted' }, t('cap.scan.appsNote'))));
}

// ───────── build ─────────
const CLOUD_EXT = ['.ply', '.las', '.laz', '.xyz', '.pts', '.txt', '.csv', '.asc', '.zip'];
const STAGES = ['upload', 'read', 'ground', 'pack', 'trail', 'analyze'];
const stageOf = { queued: 'read', prepare: 'read', scan: 'read', read: 'read', ground: 'ground', pack: 'pack', trail: 'trail', context: 'trail', analyze: 'analyze', done: 'analyze' };
const run = { on: false, stage: 'upload', pct: 0, note: null, error: null, done: false, trail: null };
let scan = null;

function stepBuild() {
  const input = h('input', { type: 'file', accept: CLOUD_EXT.join(','), hidden: true, onchange: (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!CLOUD_EXT.includes((f.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase())) { toast(t('cap.build.wrongFile'), 'bad'); return; }
    scan = f; if (!s.name) { s.name = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 80); save(); } render();
  } });
  const idx = STAGES.indexOf(run.stage);
  const name = h('input', { class: 'input', id: 'cap-name', maxlength: 120, value: s.name, placeholder: t('new.details.namePh'), oninput: (e) => { s.name = e.target.value; save(); } });
  const have = (okay, title, body) => h('li', {}, h('span', { class: `blaze ${okay ? 'on' : ''}` }), h('span', {}, title), h('small', {}, body));
  const sum = run.trail?.summary;
  const body = run.done
    ? h('div', {}, h('div', { class: 'callout info' }, h('div', {}, h('p', {}, h('b', {}, t('new.build.ready'))),
      h('p', {}, sum?.hasPath ? t('new.build.readyStats', { length: fmt.dist(sum.lengthM), climb: fmt.m(sum.ascentM), level: t(`level.${sum.level}`) }) : t('new.build.readyNoLine')))),
      h('div', { class: 'btn-row', style: 'margin-top:1.5rem' }, h('a', { class: 'btn go', href: `/trail/${run.trail.id}`, html: `${icon('cube')}<span>${t('new.build.open')}</span>` }),
        h('a', { class: 'btn ghost', href: `/trail/${run.trail.id}/report`, html: `${icon('report')}<span>${t('new.build.report')}</span>` })))
    : run.on || run.error
      ? h('div', {},
        h('ul', { class: 'stage-list' }, STAGES.map((k, i) => h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '' }, i < idx ? h('span', { class: 'blaze on' }) : i === idx && !run.error ? h('span', { class: 'spinner' }) : h('span', { class: 'blaze' }), h('span', {}, t(`new.stage.${k}`)), i === idx && run.note ? h('span', { class: 'small muted' }, run.note) : null))),
        run.error ? h('div', {}, h('div', { class: 'callout bad' }, h('div', {}, h('p', {}, h('b', {}, t('new.build.failed'))), h('p', {}, run.error))), h('div', { class: 'btn-row', style: 'margin-top:1rem' }, h('button', { class: 'btn', type: 'button', onclick: build }, t('common.retry'))))
          : h('div', {}, h('div', { class: 'bar go' }, h('i', { style: `width:${run.pct}%` })), h('p', { class: 'small muted', style: 'margin-top:.75rem' }, t('new.build.wait'))))
      : h('div', {},
        input, h('div', { class: 'drop', role: 'button', tabindex: '0', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
          h('strong', {}, scan ? scan.name : t('cap.build.pick')), h('span', { class: 'muted small' }, scan ? `${fmt.bytes(scan.size)} · ${t('cap.build.change')}` : t('cap.build.pickHint'))),
        h('div', { class: 'field', style: 'margin-top:1.25rem' }, h('label', { for: 'cap-name' }, t('new.details.name')), name),
        actions(2, h('button', { class: 'btn go', type: 'button', disabled: !scan, onclick: build, html: `<span>${t('new.details.build')}</span>${icon('next', 'flip')}` })));
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, run.done ? t('new.build.doneTitle') : t('cap.build.title')), run.done || run.on ? null : h('p', { class: 'muted' }, t('cap.build.lead')), body),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('cap.build.haveTitle')),
      h('ul', { class: 'need-list' },
        have(!!scan || run.done, t('new.need.cloud'), scan ? scan.name : t('cap.build.needScan')),
        have(s.points.length >= 2 || run.done, t('new.need.track'), s.points.length >= 2 ? t('cap.build.haveTrack', { n: s.points.length, len: fmt.dist(s.dist) }) : t('cap.build.noTrack')),
        have(s.photos.length > 0 || run.done, t('new.need.photo'), s.photos.length ? t('cap.track.photos', { n: s.photos.length }) : t('cap.build.noPhotos'))),
      h('p', { class: 'small muted' }, t('cap.build.laptop'))));
}

async function build() {
  if (run.on || !scan) return;
  if (!s.name.trim()) { $('#cap-name')?.focus(); return; }
  stop();
  Object.assign(run, { on: true, stage: 'upload', pct: 0, note: null, error: null, done: false }); render();
  const paint = () => { const bar = root.querySelector('.bar > i'); if (bar) bar.style.width = `${run.pct}%`; };
  try {
    const options = { source: 'phone', epsg: 'auto', corridor: 60, upAxis: 'auto', aoi: null };
    if (!run.trail) run.trail = (await api('POST', '/api/trails', { name: s.name.trim(), location: '', notes: '', options })).trail;
    const id = run.trail.id, sent = run.sent ||= new Set();
    const jobs = [{ key: 'scan', file: scan, kind: 'cloud' }];
    if (s.points.length >= 2) jobs.push({ key: 'gpx', file: new File([gpx()], 'masar-capture.gpx', { type: 'application/gpx+xml' }), kind: 'track' });
    for (const p of s.photos) { const blob = await getPhoto(p.id).catch(() => null); if (blob) jobs.push({ key: p.id, file: new File([blob], p.name, { type: p.type }), kind: 'photo', meta: p.lat == null ? undefined : { lat: p.lat, lon: p.lon, heading: p.heading, t: p.t } }); }
    const todo = jobs.filter((j) => !sent.has(j.key)), total = todo.reduce((a, j) => a + j.file.size, 0) || 1; let done = 0;
    for (const j of todo) {
      run.note = j.file.name; render();
      await uploadFile(id, j.file, { kind: j.kind, meta: j.meta, onProgress: (f) => { run.pct = Math.round((done + f * j.file.size) / total * 40); paint(); } });
      sent.add(j.key); done += j.file.size;
    }
    run.note = null;
    await api('POST', `/api/trails/${id}/process`, { options });
    for (;;) {
      await sleep(900);
      const { trail } = await api('GET', `/api/trails/${id}`);
      run.trail = trail;
      if (trail.status === 'error') throw new Error(trail.error?.message || t('err.server_error'));
      if (trail.status === 'ready') break;
      run.stage = stageOf[trail.progress?.stage] || 'read'; run.pct = 40 + Math.round((trail.progress?.pct || 0) * 0.6); render();
    }
    run.done = true; run.on = false;
    await clearPhotos(); s = fresh(); s.step = 3; save(); scan = null;
  } catch (err) { run.error = err.message || String(err); run.on = false; }
  render();
}

function render() { root.replaceChildren(routeBar(), [stepPrepare, stepTrack, stepScan, stepBuild][s.step]()); }
addEventListener('beforeunload', (e) => { if (run.on) { e.preventDefault(); e.returnValue = ''; } });
render();
