// The 3D trail viewer: orbit the model, walk the trail at eye level, trace or adopt a trail line, attach imagery.
import { initI18n, t, api, h, $, fmt, icon, toast, sleep } from '../core.js';
import { Engine, MODE, loadTrailData, loadImage } from '../gl/engine.js';
import { OrbitControls, WalkControls } from '../gl/controls.js';
import { profileChart } from '../charts.js';
import { prepareImages, bakeTexture, canvasToJpeg } from '../imagery.js';

await initI18n();
const id = location.pathname.split('/')[2];
const base = `/api/trails/${id}`;
const query = new URLSearchParams(location.search);
const root = h('div', { class: 'viewer' });
$('#app').replaceWith(root);

const loading = h('div', { class: 'v-loading' }, h('img', { src: '/img/logo.svg', width: 44, height: 44, alt: '' }), h('p', { id: 'load-text' }, t('viewer.loading')), h('div', { class: 'bar' }, h('i')));
const canvas = h('canvas', { 'aria-label': t('viewer.canvas') });
const markerLayer = h('div', { class: 'markers' });
root.append(canvas, markerLayer, loading);
const fail = (msg) => { loading.replaceChildren(h('h2', {}, t('viewer.failTitle')), h('p', { class: 'muted' }, msg), h('a', { class: 'btn', href: '/trails' }, t('viewer.backToTrails'))); };
const setLoad = (f) => { const bar = loading.querySelector('.bar > i'); if (bar) bar.style.width = `${Math.round(f * 100)}%`; };

let trail, meta, report;
try {
  trail = (await api('GET', base)).trail;
  if (trail.status !== 'ready') throw new Error(t('err.not_ready'));
  [meta, report] = await Promise.all([fetch(`${base}/data/meta.json`, { credentials: 'same-origin' }).then((r) => r.json()), fetch(`${base}/data/report.json`, { credentials: 'same-origin' }).then((r) => r.json())]);
} catch (err) { fail(err.message); throw err; }
document.title = `${trail.name} — Masar`;

let engine;
try { engine = new Engine(canvas, { background: '#DCE5E6' }); } catch { fail(t('viewer.noWebgl')); throw new Error('webgl'); }
const data = await loadTrailData(`${base}/data`, meta, setLoad).catch((err) => { fail(t('viewer.loadFailed')); throw err; });
engine.setPoints(data.points); engine.setTerrain(data.terrain);
setLoad(0.9);

const fine = meta.fine, [W, H] = meta.size;
const basePoint = meta.points.voxel * (fine ? 1.7 : 1.9);
const ui = { mode: 'orbit', colour: 'photo', points: true, mesh: !meta.points.hasRGB, trail: true, markers: true, size: 1, detail: 1, drawing: false, wps: [] };
const hasPhoto = () => meta.points.hasRGB || !!meta.texture;
if (!hasPhoto()) ui.colour = 'elevation';

const orbit = new OrbitControls(engine, canvas);
orbit.fit([W, H], (meta.dem.zMin + meta.dem.zMax) / 2, meta.dem.zMax - meta.dem.zMin);
if (fine) { orbit.azimuth = 0.6; orbit.elevation = 0.75; orbit.apply(); }
let walk = new WalkControls(engine, canvas, report.hasPath ? report.line : null);
walk.fine = fine; walk.speed = fine ? 0.7 : 1.4;
if (!report.hasPath) walk.pos = [W / 2, H / 2];

async function loadTexture() {
  if (!meta.texture) { engine.setTexture(null); return; }
  try { engine.setTexture(await loadImage(`${base}/data/${meta.texture.file}?v=${meta.texture.v || 0}`), meta.texture.bounds); } catch { /* the model still works without it */ }
}
await loadTexture();

function applyView() {
  const walking = ui.mode === 'walk';
  engine.set({ mode: MODE[ui.colour], modeB: MODE[ui.colour], mix: 0, showPoints: ui.points, showMesh: ui.mesh, showTrail: ui.trail, detail: ui.detail,
    pointSize: basePoint * ui.size, minPx: 1.6, maxPx: walking ? 60 : 16, fogAmount: walking ? 0.7 : 0.45, fov: (walking ? 62 : 50) * Math.PI / 180 });
}
function setTrailGeometry(line = report.hasPath ? report.line : null) {
  const span = Math.hypot(W, H);
  engine.setTrail(line, ui.mode === 'walk' ? (fine ? 0.12 : 0.5) : Math.max(fine ? 0.12 : 0.8, span / 260), ui.mode === 'walk' ? (fine ? 0.03 : 0.08) : (fine ? 0.04 : 0.25));
}

// ───────── markers ─────────
let markers = [], card = null;
const HZ_ICON = { steep: 'steep', crossing: 'water', stream: 'water', exposed: 'exposed', stairs: 'stairs', step: 'stairs', high_step: 'stairs', obstacle: 'rock', overhang: 'overhang', narrow: 'narrow' };
const POI_ICON = { hut: 'hut', shelter: 'hut', viewpoint: 'eye', peak: 'peak', picnic: 'tree', camp: 'hut', toilets: 'info', parking: 'info' };
function hazardText(hz) {
  const bits = [];
  if (hz.grade) bits.push(t('viewer.hz.grade', { v: fmt.pct(hz.grade) }));
  if (hz.count) bits.push(t('viewer.hz.steps', { n: hz.count, rise: fmt.m(hz.rise, 2) }));
  if (hz.type === 'step' || hz.type === 'high_step') bits.push(t('viewer.hz.rise', { v: fmt.cm(hz.rise) }));
  if (hz.height) bits.push(t('viewer.hz.height', { v: fmt.cm(hz.height * 100) }));
  if (hz.width) bits.push(t('viewer.hz.width', { v: fmt.m(hz.width, 2) }));
  if (hz.length && hz.type !== 'obstacle') bits.push(t('viewer.hz.length', { v: fmt.m(hz.length) }));
  bits.push(t('viewer.hz.at', { v: fmt.dist(hz.d) }));
  return bits.join(', ');
}
function addMarker(cls, ic, pos, title, body, extra = {}) {
  const el = h('button', { class: `mk ${cls}`, type: 'button', title, 'aria-label': title, html: ic ? icon(ic) : '' });
  el.addEventListener('click', (e) => { e.stopPropagation(); showCard(el, title, body, extra); });
  markerLayer.append(el);
  markers.push({ el, pos, ...extra });
  return el;
}
function showCard(anchor, title, body, extra) {
  card?.remove();
  const r = anchor.getBoundingClientRect();
  card = h('div', { class: 'v-card', role: 'dialog', 'aria-label': title },
    extra.photo ? h('img', { src: extra.photo, alt: title, loading: 'lazy', style: 'cursor:zoom-in', onclick: () => lightbox(extra.photo, title) }) : null,
    h('h3', {}, title), body ? h('p', {}, body) : null,
    h('div', { class: 'btn-row' },
      extra.d != null && report.hasPath ? h('button', { class: 'btn sm', type: 'button', onclick: () => { card.remove(); setMode('walk', extra.d); } }, t('viewer.walkHere')) : null,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => card.remove() }, t('common.close'))));
  card.style.left = `${Math.max(8, Math.min(innerWidth - 250, r.left - 110))}px`; card.style.top = `${Math.max(64, Math.min(innerHeight - 220, r.top + 24))}px`;
  root.append(card);
}
function lightbox(src, alt) { const dlg = h('dialog', { class: 'lightbox', onclick: () => dlg.close() }, h('img', { src, alt })); dlg.addEventListener('close', () => dlg.remove()); document.body.append(dlg); dlg.showModal(); }
let hereMarker = null;
function buildMarkers() {
  markerLayer.replaceChildren(); markers = [];
  const lift = fine ? 0.25 : 2.5;
  if (report.hasPath) {
    const L = report.line, n = L.x.length - 1;
    addMarker('start', 'flag', [L.x[0], L.y[0], L.z[0] + lift], t('viewer.start'), '', { d: 0 });
    addMarker('end', 'flag', [L.x[n], L.y[n], L.z[n] + lift], t('viewer.end'), fmt.dist(L.d[n]), { d: L.d[n] });
    for (const hz of report.hazards) addMarker(hz.type === 'crossing' || hz.type === 'stream' ? 'water' : 'hz', HZ_ICON[hz.type] || 'alert', [hz.x, hz.y, hz.z + lift], t(`hz.${hz.type}`), hazardText(hz), { d: hz.d });
    for (const w of report.water?.sources || []) addMarker('water', 'water', [w.x, w.y, w.z + lift], w.name || t(`water.${w.kind}`), t('viewer.offTrail', { v: fmt.m(w.offTrailM) }), { d: w.d });
    for (const p of report.pois || []) addMarker('poi', POI_ICON[p.kind] || 'info', [p.x, p.y, p.z + lift], p.name || t(`poi.${p.kind}`), t('viewer.offTrail', { v: fmt.m(p.offTrailM) }), { d: p.d });
  }
  for (const p of meta.photos || []) if (p.x != null) addMarker('photo', 'camera', [p.x, p.y, p.z + lift], p.name, p.approx ? t('viewer.photoApprox') : '', { d: p.d, photo: `${base}/photo/${p.id}` });
  hereMarker = h('span', { class: 'mk here', hidden: true }); markerLayer.append(hereMarker);
  engine.requestRender();
}
let herePos = null;
engine.afterRender = () => {
  const walking = ui.mode === 'walk', limit = fine ? 12 : 90;
  for (const m of markers) {
    const s = ui.markers ? engine.project(m.pos) : null;
    const show = s && s[0] > -20 && s[1] > -20 && s[0] < innerWidth + 20 && s[1] < innerHeight + 20 && (!walking || s[2] < limit);
    m.el.hidden = !show;
    if (show) m.el.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px)`;
  }
  for (const m of wpMarkers) { const s = engine.project(m.pos); m.el.hidden = !s; if (s) m.el.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px)`; }
  const hs = herePos && !walking ? engine.project(herePos) : null;
  hereMarker.hidden = !hs; if (hs) hereMarker.style.transform = `translate(${hs[0].toFixed(1)}px, ${hs[1].toFixed(1)}px)`;
};

// ───────── chrome ─────────
const seg = (items) => h('div', { class: 'seg', role: 'group' }, items);
const modeBtn = { orbit: h('button', { type: 'button', onclick: () => setMode('orbit'), html: `${icon('orbit')}<span>${t('viewer.orbit')}</span>` }), walk: h('button', { type: 'button', onclick: () => setMode('walk'), html: `${icon('walk')}<span>${t('viewer.walk')}</span>` }) };
const panelBtn = h('button', { class: 'btn sheetlike', type: 'button', 'aria-expanded': 'true', html: `${icon('layers')}<span>${t('viewer.view')}</span>`, onclick: () => { panel.hidden = !panel.hidden; panelBtn.setAttribute('aria-expanded', String(!panel.hidden)); } });
const top = h('header', { class: 'v-top' },
  h('div', { class: 'v-title' }, h('a', { class: 'btn quiet sm', href: '/trails', 'aria-label': t('viewer.backToTrails'), title: t('viewer.backToTrails'), html: icon('back', 'flip') }), h('h1', {}, trail.name)),
  seg([modeBtn.orbit, modeBtn.walk]), h('span', { class: 'spacer' }),
  h('a', { class: 'btn sheetlike', href: `/trail/${id}/report`, html: `${icon('report')}<span>${t('viewer.report')}</span>` }),
  h('button', { class: 'btn sheetlike', type: 'button', 'aria-label': t('viewer.help'), title: t('viewer.help'), html: icon('info'), onclick: () => showCoach(true) }), panelBtn);
const panel = h('aside', { class: 'v-panel', 'aria-label': t('viewer.view') });
const bottom = h('footer', { class: 'v-bottom' });
root.append(top, panel, bottom);
if (innerWidth < 760) { panel.hidden = true; panelBtn.setAttribute('aria-expanded', 'false'); }

function renderPanel() {
  const opt = (key, label) => h('button', { type: 'button', 'aria-pressed': String(ui.colour === key), onclick: () => { ui.colour = key; applyView(); renderPanel(); } }, label);
  const check = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui[key], onchange: (e) => { ui[key] = e.target.checked; applyView(); engine.requestRender(); } }), h('span', {}, label));
  const slider = (key, label, min, max, step, show) => { const out = h('span', { class: 'num muted' }, show(ui[key])); return h('label', { class: 'slider' }, h('span', {}, label), out, h('input', { type: 'range', min, max, step, value: ui[key], oninput: (e) => { ui[key] = Number(e.target.value); out.textContent = show(ui[key]); applyView(); } })); };
  const legend = ui.colour === 'classes' ? h('div', { class: 'legend' }, [['#B38C61', 'cls.ground'], ['#539150', 'cls.vegetation'], ['#8F999C', 'cls.object'], ['#D8412F', 'cls.building'], ['#2E7DA6', 'cls.water']].map(([c, k]) => h('span', {}, h('i', { style: `background:${c}` }), t(k))))
    : ui.colour === 'elevation' ? h('div', { class: 'legend' }, h('span', { class: 'rampbar', style: 'background:linear-gradient(90deg,#295C54,#73A15C,#DBC478,#A8856B,#F5F2ED)' }), h('span', { dir: 'ltr', style: 'justify-content:space-between' }, h('span', {}, fmt.m(meta.dem.zMin + meta.origin[2])), h('span', {}, fmt.m(meta.dem.zMax + meta.origin[2]))))
      : ui.colour === 'slope' ? h('div', { class: 'legend' }, h('span', { class: 'rampbar', style: 'background:linear-gradient(90deg,#4F8A4B,#F2C230,#D8412F)' }), h('span', { dir: 'ltr', style: 'justify-content:space-between' }, h('span', {}, '0°'), h('span', {}, '45°+')))
        : !hasPhoto() ? h('p', { class: 'small muted', style: 'margin:.6rem 0 0' }, t('viewer.noImage')) : meta.texture?.attribution ? h('p', { class: 'small muted', style: 'margin:.6rem 0 0' }, t('viewer.imageBy', { who: meta.texture.attribution })) : null;
  const imgInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '.tif,.tiff,.jpg,.jpeg,.png,.webp,.tfw,.jgw,.pgw,.wld', onchange: (e) => attachImages([...e.target.files]) });
  panel.replaceChildren(...[
    h('section', {}, h('h2', {}, t('viewer.colour')), h('div', { class: 'opts' }, opt('photo', t('viewer.c.photo')), opt('elevation', t('viewer.c.elevation')), opt('classes', t('viewer.c.classes')), opt('slope', t('viewer.c.slope'))), legend),
    h('section', {}, h('h2', {}, t('viewer.layers')), check('points', t('viewer.l.points')), check('mesh', t('viewer.l.mesh')), check('trail', t('viewer.l.trail')), check('markers', t('viewer.l.markers')),
      slider('size', t('viewer.pointSize'), 0.4, 3, 0.1, (v) => `${v.toFixed(1)}×`), slider('detail', t('viewer.detail'), 0.1, 1, 0.05, (v) => fmt.n(Math.round(meta.points.count * v)))),
    h('section', {}, h('h2', {}, t('viewer.trailTitle')), h('p', { class: 'small muted', style: 'margin:0 0 .3rem' }, report.hasPath ? t(`viewer.line.${report.lineSource || 'track'}`) : t('viewer.line.none')),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: startDrawing, html: `${icon('pencil')}<span>${t(report.hasPath ? 'viewer.redraw' : 'viewer.draw')}</span>` }),
      meta.osmPaths ? h('button', { class: 'btn ghost sm', type: 'button', onclick: showOsmPaths, html: `${icon('route')}<span>${t('viewer.adopt')}</span>` }) : null, h('div', { id: 'osm-list' })),
    meta.points.hasRGB ? null : h('section', {}, h('h2', {}, t('viewer.imagery')), imgInput,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => imgInput.click(), html: `${icon('image')}<span>${t('viewer.addImage')}</span>` }),
      meta.georef && !meta.synthetic ? h('button', { class: 'btn ghost sm', type: 'button', onclick: fetchImagery, html: `${icon('download')}<span>${t('viewer.fetchImage')}</span>` }) : null,
      h('p', { class: 'small muted', style: 'margin:.5rem 0 0' }, t('viewer.imageHint')))].filter(Boolean));
}

let chart = null;
function renderBottom() {
  chart?.destroy(); chart = null;
  if (!report.hasPath) { bottom.replaceChildren(h('p', { class: 'small', style: 'margin:.3rem 0 .4rem' }, t('viewer.noLineHint'))); return; }
  const walking = ui.mode === 'walk', total = walk.length;
  const play = h('button', { class: 'btn sm', type: 'button', onclick: () => { walk.playing = !walk.playing; if (walk.playing && walk.d >= total - 0.01) walk.d = 0; syncWalk(); } });
  const speed = h('select', { 'aria-label': t('viewer.speed'), onchange: (e) => { walk.speed = Number(e.target.value); } }, (fine ? [0.3, 0.7, 1.4, 3] : [1.4, 4, 10, 25]).map((v, i) => h('option', { value: v, selected: v === walk.speed }, [t('viewer.sp.stroll'), t('viewer.sp.walk'), t('viewer.sp.fast'), t('viewer.sp.fly')][i])));
  const read = h('div', { class: 'read' });
  const box = h('div');
  bottom.replaceChildren(walking ? h('div', { class: 'v-walk' }, play, speed, read) : h('div', { class: 'v-walk' }, h('span', { class: 'muted' }, t('viewer.profileHint')), read), box);
  chart = profileChart(box, report.profile, { compact: true, height: 84,
    onHover: (dist) => { if (ui.mode !== 'walk') { const p = walk.at(dist); herePos = [p[0], p[1], p[2] + (fine ? 0.1 : 1)]; engine.requestRender(); } },
    onLeave: () => { herePos = null; engine.requestRender(); },
    onSelect: (dist) => { if (ui.mode === 'walk') { walk.d = dist; walk.apply(); syncWalk(); } else setMode('walk', dist); } });
  bottom._sync = () => {
    play.innerHTML = `${icon(walk.playing ? 'pause' : 'play')}<span>${t(walk.playing ? 'viewer.pause' : 'viewer.play')}</span>`;
    const i = nearestProfile(walk.d);
    read.replaceChildren(h('span', {}, h('b', {}, fmt.dist(walking ? walk.d : total)), walking ? ` / ${fmt.dist(total)}` : ''),
      walking ? h('span', {}, `${t('report.elevation')} `, h('b', {}, fmt.m(report.profile.z[i], fine ? 1 : 0))) : h('span', {}, `↑ `, h('b', {}, fmt.m(report.summary.ascentM))),
      walking ? h('span', {}, `${t('report.gradeShort')} `, h('b', {}, fmt.pct(report.profile.grade[i]))) : h('span', {}, h('b', {}, t(`level.${report.difficulty.level}`))));
    if (walking) chart.setCursor(walk.d);
  };
  bottom._sync();
}
const nearestProfile = (dist) => { const d = report.profile.d; let lo = 0, hi = d.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m] <= dist) lo = m; else hi = m; } return lo; };
const syncWalk = () => bottom._sync?.();
walk.onMove = syncWalk;

let wasWalking = false;
function setMode(mode, dist) {
  if (ui.drawing) return;
  ui.mode = mode; card?.remove();
  orbit.enabled = mode === 'orbit'; walk.enabled = mode === 'walk';
  for (const k of Object.keys(modeBtn)) modeBtn[k].setAttribute('aria-pressed', String(k === mode));
  if (mode === 'walk') { if (dist != null) walk.d = Math.max(0, Math.min(walk.length, dist)); walk.started = false; walk.yaw = 0; walk.pitch = -0.12; walk.apply(); }
  else {
    walk.playing = false;
    if (wasWalking && report.hasPath) { const p = walk.at(walk.d); orbit.target = [p[0], p[1], p[2]]; orbit.distance = Math.min(orbit.distance, Math.hypot(W, H) * 0.5); }
    orbit.apply();
  }
  wasWalking = mode === 'walk';
  applyView(); setTrailGeometry(); renderBottom();
}
let last = performance.now();
engine.onFrame = (now) => { const dt = Math.min(0.1, (now - last) / 1000); last = now; walk.update(dt); };

// ───────── drawing a trail line ─────────
let wpMarkers = [], drawBox = null;
function densify(wps) {
  const line = { x: [], y: [], z: [] }, step = Math.max(meta.dem.cell, fine ? 0.1 : 1);
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1], b = wps[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) { const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n, z = engine.heightAt(x, y); line.x.push(x); line.y.push(y); line.z.push(z === z ? z : a[2]); }
  }
  return line;
}
function refreshDraw() {
  for (const m of wpMarkers) m.el.remove();
  wpMarkers = ui.wps.map((p) => { const el = h('span', { class: 'mk wp' }); markerLayer.append(el); return { el, pos: [p[0], p[1], p[2] + (fine ? 0.05 : 0.5)] }; });
  setTrailGeometry(ui.wps.length >= 2 ? densify(ui.wps) : null);
  let len = 0; for (let i = 1; i < ui.wps.length; i++) len += Math.hypot(ui.wps[i][0] - ui.wps[i - 1][0], ui.wps[i][1] - ui.wps[i - 1][1]);
  drawBox.querySelector('.len').textContent = ui.wps.length >= 2 ? t('viewer.drawLen', { n: ui.wps.length, len: fmt.dist(len) }) : t('viewer.drawStart');
  drawBox.querySelector('.save').disabled = ui.wps.length < 2;
  engine.requestRender();
}
function startDrawing() {
  setMode('orbit'); ui.drawing = true; ui.wps = []; root.classList.add('drawing'); card?.remove();
  const prevMarkers = ui.markers; ui.markers = false;
  const stop = () => { ui.drawing = false; ui.markers = prevMarkers; root.classList.remove('drawing'); drawBox.remove(); for (const m of wpMarkers) m.el.remove(); wpMarkers = []; setTrailGeometry(); engine.requestRender(); };
  drawBox = h('div', { class: 'v-draw', role: 'region', 'aria-label': t('viewer.draw') }, h('p', {}, h('b', {}, t('viewer.drawTitle'))), h('p', { class: 'muted' }, t('viewer.drawHelp')), h('p', { class: 'len small' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn sm save', type: 'button', onclick: async () => { const pts = ui.wps.map((p) => [p[0], p[1]]); stop(); await savePath(pts); } }, t('viewer.drawSave')),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { ui.wps.pop(); refreshDraw(); } }, t('viewer.drawUndo')),
      h('button', { class: 'btn quiet sm', type: 'button', onclick: stop }, t('common.cancel'))));
  root.append(drawBox); refreshDraw();
}
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; card?.remove(); });
canvas.addEventListener('pointerup', (e) => {
  if (!ui.drawing || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  const r = canvas.getBoundingClientRect(), hit = engine.pickTerrain(e.clientX - r.left, e.clientY - r.top);
  if (hit) { ui.wps.push(hit); refreshDraw(); } else toast(t('viewer.drawMiss'));
});

async function savePath(points) {
  const busy = h('div', { class: 'v-draw' }, h('p', { style: 'display:flex;gap:.6rem;align-items:center;margin:0' }, h('span', { class: 'spinner' }), t('viewer.measuring')));
  root.append(busy);
  try {
    await api('PUT', `${base}/path`, { points });
    for (let i = 0; i < 120; i++) { await sleep(700); const tr = (await api('GET', base)).trail; if (!tr.busy) { if (tr.error) throw new Error(tr.error.message); break; } }
    [meta, report] = await Promise.all([fetch(`${base}/data/meta.json`, { credentials: 'same-origin', cache: 'reload' }).then((r) => r.json()), fetch(`${base}/data/report.json`, { credentials: 'same-origin', cache: 'reload' }).then((r) => r.json())]);
    const prev = walk; walk = new WalkControls(engine, canvas, report.hasPath ? report.line : null); walk.fine = fine; walk.speed = prev.speed; walk.onMove = syncWalk; prev.enabled = false;
    setTrailGeometry(); buildMarkers(); renderPanel(); renderBottom();
    toast(report.hasPath ? t('viewer.lineSaved') : t('viewer.lineTooShort'), report.hasPath ? '' : 'bad');
  } catch (err) { toast(err.message, 'bad'); }
  busy.remove();
}

async function showOsmPaths() {
  const box = $('#osm-list');
  box.replaceChildren(h('p', { class: 'small muted' }, t('common.loading')));
  try {
    const { paths } = await api('GET', `${base}/osm-paths`);
    if (!paths.length) { box.replaceChildren(h('p', { class: 'small muted' }, t('viewer.adoptNone'))); return; }
    const len = (p) => p.pts.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - p.pts[i - 1][0], q[1] - p.pts[i - 1][1]) : 0), 0);
    paths.sort((a, b) => len(b) - len(a));
    let chosen = null;
    const use = h('button', { class: 'btn sm', type: 'button', disabled: true, onclick: async () => { box.replaceChildren(); await savePath(chosen.pts); } }, t('viewer.adoptUse'));
    box.replaceChildren(h('p', { class: 'small muted', style: 'margin:.5rem 0 0' }, t('viewer.adoptHelp')),
      h('div', { class: 'rowlist' }, paths.slice(0, 40).map((p) => { const b = h('button', { type: 'button', 'aria-pressed': 'false' }, `${p.name || t(`osm.${p.kind}`)}, ${fmt.dist(len(p))}${p.sac ? `, ${p.sac.replace(/_/g, ' ')}` : ''}`);
        b.onclick = () => { chosen = p; box.querySelectorAll('.rowlist button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); use.disabled = false; setTrailGeometry(densify(p.pts.map((q) => [q[0], q[1], engine.heightAt(q[0], q[1]) || 0]))); }; return b; })), use);
  } catch (err) { box.replaceChildren(h('p', { class: 'small' }, err.message)); }
}

// ───────── imagery ─────────
async function attachImages(files) {
  if (!files.length) return;
  toast(t('viewer.imageWorking'));
  try {
    const items = await prepareImages(files);
    if (!items.length) throw new Error(t('viewer.imageNone'));
    const [ox, oy] = meta.origin;
    const baked = await bakeTexture(items, { minX: ox, minY: oy, maxX: ox + W, maxY: oy + H });
    if (!baked) throw new Error(t('new.build.imageryOutside'));
    const { texture } = await api('PUT', `${base}/texture?bounds=0,0,${W},${H}&attribution=${encodeURIComponent(items[0].file.name)}`, await canvasToJpeg(baked.canvas), { type: 'image/jpeg' });
    meta.texture = texture; await loadTexture(); ui.colour = 'photo'; applyView(); renderPanel(); toast(t('viewer.imageDone'));
  } catch (err) { toast(err.message || t('viewer.imageFailed'), 'bad'); }
}
async function fetchImagery() {
  toast(t('viewer.imageWorking'));
  try { const { texture } = await api('POST', `${base}/imagery`); meta.texture = texture; await loadTexture(); ui.colour = 'photo'; applyView(); renderPanel(); toast(t('viewer.imageDone')); }
  catch (err) { toast(err.message, 'bad'); }
}

// ───────── first-visit coaching ─────────
function showCoach(force) {
  let seen = false; try { seen = localStorage.getItem('masar.coach') === '1'; } catch { /* ignore */ }
  if (seen && !force) return;
  root.querySelector('.coach')?.remove();
  const touch = matchMedia('(pointer: coarse)').matches;
  const tips = touch ? ['viewer.coach.t1', 'viewer.coach.t2', 'viewer.coach.t3'] : ['viewer.coach.m1', 'viewer.coach.m2', 'viewer.coach.m3'];
  const el = h('div', { class: 'coach', role: 'note' }, h('h3', {}, t('viewer.coach.title')), h('ul', {}, [...tips, 'viewer.coach.walk', 'viewer.coach.markers'].map((k) => h('li', {}, t(k)))),
    h('button', { class: 'btn sm', type: 'button', onclick: () => { el.remove(); try { localStorage.setItem('masar.coach', '1'); } catch { /* ignore */ } } }, t('viewer.coach.ok')));
  root.append(el);
}

// ───────── go ─────────
applyView(); setTrailGeometry(); buildMarkers(); renderPanel(); renderBottom();
setMode(query.get('mode') === 'walk' || query.has('d') ? 'walk' : 'orbit', query.has('d') ? Number(query.get('d')) : undefined);
loading.remove();
showCoach(false);
addEventListener('keydown', (e) => { if (e.key === 'Escape') { card?.remove(); if (ui.mode === 'walk') setMode('orbit'); } });

// a snapshot for the library card (first visit only)
if (!trail.hasThumb) setTimeout(() => {
  try {
    engine.render();
    const c = document.createElement('canvas'), k = 640 / canvas.width; c.width = 640; c.height = Math.round(canvas.height * k);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    c.toBlob((blob) => { if (blob) api('PUT', `${base}/thumb`, blob, { type: 'image/jpeg' }).catch(() => {}); }, 'image/jpeg', 0.8);
  } catch { /* cosmetic only */ }
}, 1200);
