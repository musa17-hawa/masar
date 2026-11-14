// The studio: a four-step route from raw files to a built trail.
import { mountApp, t, api, h, $, fmt, icon, toast, sleep } from '../core.js';
import { uploadFile } from '../uploader.js';
import { prepareImages, bakeTexture, canvasToJpeg, IMAGE_EXT, WORLD_EXT } from '../imagery.js';

await mountApp('new');
document.title = `${t('nav.new')} — Masar`;
const cfg = await api('GET', '/api/config').catch(() => ({ crs: [], network: true }));
const root = h('main', { class: 'page' });
$('#app').replaceWith(root);

const EXT = { cloud: ['.las', '.laz', '.ply', '.xyz', '.txt', '.csv', '.pts', '.asc', '.zip'], track: ['.gpx', '.kml', '.geojson', '.json'], image: IMAGE_EXT, world: WORLD_EXT, photo: ['.jpg', '.jpeg', '.png', '.heic', '.webp'] };
const extOf = (name) => (name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
const baseOf = (name) => name.replace(/\.[^.]+$/, '').toLowerCase();
const state = { step: 0, source: new URLSearchParams(location.search).get('source') === 'phone' ? 'phone' : 'aerial', files: [], name: '', location: '', notes: '',
  crs: 'auto', epsgCustom: '', corridor: 60, aoiLat: '', aoiLon: '', aoiRadius: 150, upAxis: 'auto', autoImagery: true, building: false };
const STEPS = ['new.step.source', 'new.step.files', 'new.step.details', 'new.step.build'];

function guessKind(file, all) {
  const e = extOf(file.name);
  if (EXT.world.includes(e)) return 'world';
  if (EXT.cloud.includes(e)) return 'cloud';
  if (['.gpx', '.kml', '.geojson'].includes(e)) return 'track';
  if (e === '.json') return 'track';
  if (['.tif', '.tiff'].includes(e)) return 'image';
  if (EXT.photo.includes(e)) {
    const hasWorld = all.some((f) => EXT.world.includes(extOf(f.name)) && baseOf(f.name) === baseOf(file.name));
    return hasWorld || (state.source === 'aerial' && /ortho|swissimage|aerial|satel|image|tile/i.test(file.name)) ? 'image' : 'photo';
  }
  return 'skip';
}
function addFiles(list) {
  const incoming = [...list].filter((f) => !state.files.some((x) => x.file.name === f.name && x.file.size === f.size));
  const all = [...state.files.map((x) => x.file), ...incoming];
  for (const f of incoming) state.files.push({ file: f, kind: guessKind(f, all), progress: 0 });
  for (const x of state.files) if (x.kind === 'photo' && all.some((f) => EXT.world.includes(extOf(f.name)) && baseOf(f.name) === baseOf(x.file.name))) x.kind = 'image';
  if (!state.name) { const c = state.files.find((x) => x.kind === 'cloud'); if (c) state.name = c.file.name.replace(/\.[^.]+$/, '').replace(/\.las$/i, '').replace(/[_-]+/g, ' ').slice(0, 80); }
  render();
}
const count = (kind) => state.files.filter((x) => x.kind === kind).length;

// ───────── step views ─────────
function routeBar() {
  return h('ol', { class: 'route', 'aria-label': t('new.progress') }, STEPS.map((k, i) => h('li', { class: i < state.step ? 'done' : i === state.step ? 'now' : '', 'aria-current': i === state.step ? 'step' : null },
    h('span', { class: `blaze ${i < state.step ? 'on' : i === state.step ? 'now' : ''}` }), `${i + 1}. ${t(k)}`)));
}
const actions = (back, next) => h('div', { class: 'step-actions' }, back ? h('button', { class: 'btn ghost', type: 'button', onclick: back, html: `${icon('back', 'flip')}<span>${t('common.back')}</span>` }) : h('span'), next);
const nextBtn = (label, onclick, disabled) => h('button', { class: 'btn go', type: 'button', onclick, disabled, html: `<span>${label}</span>${icon('next', 'flip')}` });

function stepSource() {
  const choice = (id, ic, title, body) => h('button', { class: 'choice', type: 'button', 'aria-pressed': String(state.source === id), onclick: () => { state.source = id; render(); }, html: `${icon(ic)}<strong>${title}</strong><span>${body}</span>` });
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, t('new.source.title')), h('p', { class: 'muted' }, t('new.source.lead')),
      h('div', { class: 'choice-grid' }, choice('aerial', 'trails', t('new.source.aerial'), t('new.source.aerialBody')), choice('phone', 'phone', t('new.source.phone'), t('new.source.phoneBody'))),
      state.source === 'phone' ? h('p', { class: 'callout info', style: 'margin-top:1.25rem' }, h('span', {}, t('new.source.phoneTip'), ' ', h('a', { href: '/capture' }, t('new.source.phoneLink')))) : null,
      actions(null, nextBtn(t('common.next'), () => { state.step = 1; render(); }))),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('new.guide.sourceTitle')), h('p', {}, t('new.guide.source1')), h('p', {}, t('new.guide.source2'))));
}

function stepFiles() {
  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });
  const drop = h('div', { class: 'drop', role: 'button', tabindex: '0', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
    h('strong', {}, t('new.files.drop')), h('span', { class: 'muted small' }, t(state.source === 'phone' ? 'new.files.dropHintPhone' : 'new.files.dropHint')));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
  const kinds = ['cloud', 'image', 'world', 'track', 'photo', 'skip'];
  const rows = state.files.map((x, i) => h('li', { class: 'file-row' },
    h('select', { 'aria-label': t('new.files.kind'), onchange: (e) => { x.kind = e.target.value; render(); } }, kinds.map((k) => h('option', { value: k, selected: x.kind === k }, t(`new.kind.${k}`)))),
    h('span', { class: 'name', dir: 'ltr', style: 'text-align:start' }, x.file.name),
    h('button', { class: 'btn danger sm', type: 'button', 'aria-label': `${t('new.files.remove')}: ${x.file.name}`, html: icon('close'), onclick: () => { state.files.splice(i, 1); render(); } }),
    h('span', { class: 'meta' }, fmt.bytes(x.file.size), x.kind === 'skip' ? ` · ${t('new.files.unknown')}` : '')));
  const need = (ok, title, body) => h('li', {}, h('span', { class: `blaze ${ok ? 'on' : ''}` }), h('span', {}, title), h('small', {}, body));
  const phone = state.source === 'phone';
  const checklist = h('ul', { class: 'need-list' },
    need(count('cloud') > 0, t('new.need.cloud'), t(phone ? 'new.need.cloudPhone' : 'new.need.cloudBody')),
    phone ? null : need(count('image') > 0 || state.autoImagery, t('new.need.image'), count('image') ? t('new.need.imageHave', { n: count('image') }) : t('new.need.imageBody')),
    need(count('track') > 0, t('new.need.track'), t(phone ? 'new.need.trackPhone' : 'new.need.trackBody')),
    need(count('photo') > 0, t('new.need.photo'), t('new.need.photoBody')));
  const auto = phone || !cfg.network ? null : h('label', { class: 'check', style: 'margin-top:1rem' }, h('input', { type: 'checkbox', checked: state.autoImagery, onchange: (e) => { state.autoImagery = e.target.checked; render(); } }),
    h('span', {}, t('new.files.auto'), h('br'), h('span', { class: 'small muted' }, t('new.files.autoHint'))));
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, t('new.files.title')), h('p', { class: 'muted' }, t(phone ? 'new.files.leadPhone' : 'new.files.lead')), input, drop,
      state.files.length ? h('ul', { class: 'file-list' }, rows) : null, auto,
      phone && count('cloud') > 1 ? h('p', { class: 'callout', style: 'margin-top:1rem' }, t('new.files.oneScan')) : null,
      actions(() => { state.step = 0; render(); }, nextBtn(t('common.next'), () => { state.step = 2; render(); }, count('cloud') === 0))),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('new.need.title')), checklist,
      phone ? null : h('details', { class: 'more' }, h('summary', {}, t('new.guide.swissTitle')), h('ol', {}, ['new.guide.swiss1', 'new.guide.swiss2', 'new.guide.swiss3', 'new.guide.swiss4'].map((k) => h('li', {}, t(k)))), h('p', { class: 'small muted' }, t('new.guide.swissNote'))),
      h('details', { class: 'more' }, h('summary', {}, t('new.guide.formatsTitle')), h('ul', {}, ['new.guide.fmtCloud', 'new.guide.fmtImage', 'new.guide.fmtTrack', 'new.guide.fmtLaz'].map((k) => h('li', {}, t(k)))))));
}

function stepDetails() {
  const bind = (key, attrs = {}) => h('input', { class: 'input', value: state[key], oninput: (e) => { state[key] = e.target.value; }, ...attrs });
  const phone = state.source === 'phone', hasTrack = count('track') > 0;
  const crsSelect = h('select', { class: 'input', id: 'crs', onchange: (e) => { state.crs = e.target.value; render(); } },
    [['auto', t('new.crs.auto')], ['2056', 'CH1903+ / LV95 (EPSG:2056)'], ['21781', 'CH1903 / LV03 (EPSG:21781)'], ['2039', 'Israel TM Grid (EPSG:2039)'], ['custom', t('new.crs.utm')], ['local', t('new.crs.local')]]
      .map(([v, label]) => h('option', { value: v, selected: state.crs === v }, label)));
  const nameInput = bind('name', { id: 'name', required: true, maxlength: 120, placeholder: t('new.details.namePh') });
  const go = () => { if (!state.name.trim()) { nameInput.focus(); nameInput.closest('.field').classList.add('error'); return; } state.step = 3; render(); build(); };
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, t('new.details.title')), h('p', { class: 'muted' }, t('new.details.lead')),
      h('div', { class: 'field' }, h('label', { for: 'name' }, t('new.details.name')), nameInput),
      h('div', { class: 'field' }, h('label', { for: 'loc' }, t('new.details.location'), ' ', h('span', { class: 'muted' }, `(${t('common.optional')})`)), bind('location', { id: 'loc', maxlength: 160, placeholder: t('new.details.locationPh') })),
      h('div', { class: 'field' }, h('label', { for: 'notes' }, t('new.details.notes'), ' ', h('span', { class: 'muted' }, `(${t('common.optional')})`)), h('textarea', { class: 'input', id: 'notes', maxlength: 2000, oninput: (e) => { state.notes = e.target.value; } }, state.notes)),
      h('details', { class: 'more', open: state.crs !== 'auto' || null }, h('summary', {}, t('new.details.advanced')),
        h('div', { class: 'field' }, h('label', { for: 'crs' }, t('new.crs.label')), crsSelect, h('span', { class: 'hint' }, t('new.crs.hint'))),
        state.crs === 'custom' ? h('div', { class: 'field' }, h('label', { for: 'epsg' }, t('new.crs.code')), bind('epsgCustom', { id: 'epsg', inputmode: 'numeric', placeholder: '32632', dir: 'ltr' }), h('span', { class: 'hint' }, t('new.crs.codeHint'))) : null,
        !phone && hasTrack ? h('div', { class: 'field' }, h('label', { for: 'corr' }, t('new.details.corridor')), bind('corridor', { id: 'corr', type: 'number', min: 10, max: 500, step: 10, dir: 'ltr' }), h('span', { class: 'hint' }, t('new.details.corridorHint'))) : null,
        !phone && !hasTrack ? h('div', {}, h('p', { class: 'label' }, t('new.details.aoi')), h('p', { class: 'hint small muted' }, t('new.details.aoiHint')),
          h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'lat' }, t('new.details.lat')), bind('aoiLat', { id: 'lat', inputmode: 'decimal', placeholder: '46.5770', dir: 'ltr' })),
            h('div', { class: 'field' }, h('label', { for: 'lon' }, t('new.details.lon')), bind('aoiLon', { id: 'lon', inputmode: 'decimal', placeholder: '7.9128', dir: 'ltr' }))),
          h('div', { class: 'field' }, h('label', { for: 'rad' }, t('new.details.radius')), bind('aoiRadius', { id: 'rad', type: 'number', min: 20, max: 1000, step: 10, dir: 'ltr' }))) : null,
        phone || state.crs === 'local' ? h('div', { class: 'field' }, h('label', { for: 'up' }, t('new.details.up')), h('select', { class: 'input', id: 'up', onchange: (e) => { state.upAxis = e.target.value; } },
          [['auto', t('new.details.upAuto')], ['z', 'Z'], ['y', 'Y']].map(([v, l]) => h('option', { value: v, selected: state.upAxis === v }, l))), h('span', { class: 'hint' }, t('new.details.upHint'))) : null),
      actions(() => { state.step = 1; render(); }, nextBtn(t('new.details.build'), go))),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('new.guide.detailsTitle')), h('p', {}, t('new.guide.details1')), h('p', {}, t(phone ? 'new.guide.details2Phone' : 'new.guide.details2'))));
}

// ───────── build ─────────
const STAGES = ['upload', 'read', 'ground', 'pack', 'trail', 'analyze', 'imagery'];
const stageOf = { queued: 'read', prepare: 'read', scan: 'read', read: 'read', ground: 'ground', pack: 'pack', trail: 'trail', context: 'trail', analyze: 'analyze', done: 'imagery' };
const run = { stage: 'upload', pct: 0, error: null, trail: null, done: false, note: null, imageryNote: null };

function stepBuild() {
  const idx = STAGES.indexOf(run.stage);
  const stages = h('ul', { class: 'stage-list' }, STAGES.map((sname, i) => h('li', { class: run.done || i < idx ? 'done' : i === idx ? 'now' : '' },
    run.done || i < idx ? h('span', { class: 'blaze on' }) : i === idx && !run.error ? h('span', { class: 'spinner' }) : h('span', { class: 'blaze' }),
    h('span', {}, t(`new.stage.${sname}`)), i === idx && !run.done && run.note ? h('span', { class: 'small muted' }, run.note) : null)));
  const s = run.trail?.summary;
  const body = run.error
    ? h('div', {}, h('div', { class: 'callout bad' }, h('div', {}, h('p', {}, h('b', {}, t('new.build.failed'))), h('p', {}, run.error))),
      h('div', { class: 'step-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.step = 1; run.error = null; render(); } }, t('new.build.fix')), h('button', { class: 'btn', type: 'button', onclick: () => build() }, t('common.retry'))))
    : run.done
      ? h('div', {}, h('div', { class: 'callout info' }, h('div', {}, h('p', {}, h('b', {}, t('new.build.ready'))),
        h('p', {}, s?.hasPath ? t('new.build.readyStats', { length: fmt.dist(s.lengthM), climb: fmt.m(s.ascentM), level: t(`level.${s.level}`) }) : t('new.build.readyNoLine')),
        run.imageryNote ? h('p', { class: 'small' }, run.imageryNote) : null)),
        ...(s?.warnings || []).filter((wn) => wn.code !== 'osm_unavailable').map((wn) => h('p', { class: 'callout', style: 'margin-top:.75rem' }, t(`warn.${wn.code}`))),
        h('div', { class: 'btn-row', style: 'margin-top:1.5rem' }, h('a', { class: 'btn go', href: `/trail/${run.trail.id}`, html: `${icon('cube')}<span>${t('new.build.open')}</span>` }),
          h('a', { class: 'btn ghost', href: `/trail/${run.trail.id}/report`, html: `${icon('report')}<span>${t('new.build.report')}</span>` })))
      : h('div', {}, h('div', { class: 'bar go' }, h('i', { style: `width:${run.pct}%` })), h('p', { class: 'small muted', style: 'margin-top:.75rem' }, t('new.build.wait')));
  return h('div', { class: 'step-layout' },
    h('section', {}, h('h1', {}, run.done ? t('new.build.doneTitle') : t('new.build.title', { name: state.name })), stages, body),
    h('aside', { class: 'guide sheet pad' }, h('h3', {}, t('new.guide.buildTitle')), h('p', {}, t('new.guide.build1')), h('p', {}, t('new.guide.build2'))));
}

async function build() {
  if (state.building) return;
  state.building = true; Object.assign(run, { stage: 'upload', pct: 0, error: null, done: false, note: null, imageryNote: null });
  render();
  try {
    const epsg = state.crs === 'custom' ? Number(state.epsgCustom) || 'auto' : state.crs === 'auto' ? 'auto' : state.crs === 'local' ? 'local' : Number(state.crs);
    const options = { source: state.source, epsg, corridor: Number(state.corridor) || 60, upAxis: state.upAxis,
      aoi: state.aoiLat && state.aoiLon ? { lat: Number(state.aoiLat), lon: Number(state.aoiLon), radius: Number(state.aoiRadius) || 150 } : null };
    if (!run.trail) run.trail = (await api('POST', '/api/trails', { name: state.name.trim(), location: state.location, notes: state.notes, options })).trail;
    else await api('PATCH', `/api/trails/${run.trail.id}`, { name: state.name.trim(), location: state.location, notes: state.notes, options });
    const id = run.trail.id;
    const todo = state.files.filter((x) => ['cloud', 'track', 'photo'].includes(x.kind) && !x.uploaded);
    const totalBytes = todo.reduce((sum, x) => sum + x.file.size, 0) || 1; let doneBytes = 0;
    for (const x of todo) {
      run.note = x.file.name; render();
      await uploadFile(id, x.file, { kind: x.kind, onProgress: (f) => { run.pct = Math.round((doneBytes + f * x.file.size) / totalBytes * 30); paint(); } });
      x.uploaded = true; doneBytes += x.file.size;
    }
    run.note = null;
    await api('POST', `/api/trails/${id}/process`, { options });
    for (;;) {
      await sleep(900);
      const { trail } = await api('GET', `/api/trails/${id}`);
      run.trail = trail;
      if (trail.status === 'error') throw new Error(trail.error?.message || t('err.server_error'));
      if (trail.status === 'ready') break;
      run.stage = stageOf[trail.progress?.stage] || 'read'; run.pct = 30 + Math.round((trail.progress?.pct || 0) * 0.6); render();
    }
    run.stage = 'imagery'; run.pct = 92; render();
    await attachImagery(id);
    run.done = true; run.pct = 100;
  } catch (err) { run.error = err.message || String(err); }
  state.building = false; render();
}

// After the build we know where the trail sits, so the aerial image can be cut to fit and attached.
async function attachImagery(id) {
  const images = state.files.filter((x) => x.kind === 'image' || x.kind === 'world').map((x) => x.file);
  const meta = await fetch(`/api/trails/${id}/data/meta.json`, { credentials: 'same-origin' }).then((r) => r.json());
  const [ox, oy] = meta.origin, [W, H] = meta.size;
  try {
    if (images.some((f) => IMAGE_EXT.includes(extOf(f.name)))) {
      run.note = t('new.build.baking'); render();
      const items = await prepareImages(images);
      const baked = await bakeTexture(items, { minX: ox, minY: oy, maxX: ox + W, maxY: oy + H }, { onProgress: (f) => { run.pct = 92 + Math.round(f * 7); paint(); } });
      if (!baked) { run.imageryNote = t('new.build.imageryOutside'); return; }
      await api('PUT', `/api/trails/${id}/texture?bounds=0,0,${W},${H}&attribution=${encodeURIComponent(items[0].file.name)}`, await canvasToJpeg(baked.canvas), { type: 'image/jpeg' });
      run.imageryNote = t('new.build.imageryDone');
    } else if (state.autoImagery && meta.georef && !meta.synthetic && state.source !== 'phone' && cfg.network) {
      run.note = t('new.build.fetching'); render();
      const { texture } = await api('POST', `/api/trails/${id}/imagery`);
      run.imageryNote = t('new.build.imageryFetched', { provider: texture.provider || '' });
    }
  } catch (err) { run.imageryNote = `${t('new.build.imageryFailed')} ${err.message || ''}`; }
  run.note = null;
}

function paint() { const bar = root.querySelector('.bar > i'); if (bar) bar.style.width = `${run.pct}%`; }
function render() {
  const view = [stepSource, stepFiles, stepDetails, stepBuild][state.step]();
  root.replaceChildren(routeBar(), view);
}
addEventListener('beforeunload', (e) => { if (state.building) { e.preventDefault(); e.returnValue = ''; } });
render();
