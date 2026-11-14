// Trail report: every number comes from report.json, written by the build pipeline.
import { mountApp, t, api, h, $, fmt, icon } from '../core.js';
import { profileChart, gradeShares, factorBars } from '../charts.js';

await mountApp('trails');
const id = location.pathname.split('/')[2], base = `/api/trails/${id}`;
const root = h('main', { class: 'page report' });
$('#app').replaceWith(root);

let trail, meta, r;
try {
  trail = (await api('GET', base)).trail;
  if (trail.status !== 'ready') throw new Error(t('err.not_ready'));
  [meta, r] = await Promise.all([fetch(`${base}/data/meta.json`, { credentials: 'same-origin' }).then((x) => x.json()), fetch(`${base}/data/report.json`, { credentials: 'same-origin' }).then((x) => x.json())]);
} catch (err) {
  root.append(h('h1', {}, t('report.unavailable')), h('p', { class: 'muted' }, err.message), h('a', { class: 'btn', href: '/trails' }, t('viewer.backToTrails')));
  throw err;
}
document.title = `${trail.name} — ${t('report.title')} — Masar`;

const HZ_ICON = { steep: 'steep', crossing: 'water', stream: 'water', exposed: 'exposed', stairs: 'stairs', step: 'stairs', high_step: 'stairs', obstacle: 'rock', overhang: 'overhang', narrow: 'narrow' };
const fig = (value, label, note) => h('div', {}, h('b', {}, value), h('span', {}, label), note ? h('small', {}, note) : null);
const fact = (label, value, note) => h('div', {}, h('dt', {}, label), h('dd', {}, value, note ? h('small', {}, note) : null));
const section = (title, ...kids) => h('section', {}, h('h2', {}, title), ...kids);
const sourceLabel = t(meta.fine ? 'report.src.phone' : 'report.src.aerial');
const z0 = meta.origin[2];

const head = h('header', { class: 'report-head' },
  h('p', { class: 'small muted' }, [t('report.title'), trail.location, fmt.date(meta.builtAt), sourceLabel].filter(Boolean).join(', ')),
  h('h1', {}, trail.name),
  r.hasPath ? h('p', { class: 'lead' }, t('report.lead', { level: t(`level.${r.difficulty.level}`).toLowerCase(), length: fmt.dist(r.summary.lengthM), climb: fmt.m(r.summary.ascentM), time: fmt.time(r.time.minutes) })) : null,
  h('div', { class: 'btn-row no-print', style: 'margin-top:.8rem' },
    h('a', { class: 'btn go', href: `/trail/${id}`, html: `${icon('cube')}<span>${t('report.open3d')}</span>` }),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => print(), html: `${icon('print')}<span>${t('report.print')}</span>` })));
root.append(head);
if (meta.synthetic) root.append(h('p', { class: 'callout', style: 'margin-bottom:1.5rem' }, t('report.synthetic')));

function hazardDetail(hz) {
  const bits = [];
  if (hz.grade) bits.push(t('viewer.hz.grade', { v: fmt.pct(hz.grade) }));
  if (hz.count) bits.push(t('viewer.hz.steps', { n: hz.count, rise: fmt.m(hz.rise, 2) }));
  if (hz.type === 'step' || hz.type === 'high_step') bits.push(t('viewer.hz.rise', { v: fmt.cm(hz.rise) }));
  if (hz.height) bits.push(t('viewer.hz.height', { v: fmt.cm(hz.height * 100) }));
  if (hz.width) bits.push(t('viewer.hz.width', { v: fmt.m(hz.width, 2) }));
  if (hz.length && hz.type !== 'obstacle') bits.push(t('viewer.hz.length', { v: fmt.m(hz.length) }));
  return bits.join(', ') || t(`hzNote.${hz.type}`);
}

if (!r.hasPath) {
  root.append(h('section', { class: 'empty' }, h('h2', {}, t('report.noLineTitle')), h('p', { class: 'muted' }, t('report.noLineBody')),
    h('a', { class: 'btn go', href: `/trail/${id}`, html: `${icon('pencil')}<span>${t('report.noLineCta')}</span>` })),
  h('div', { style: 'height:2rem' }),
  section(t('report.area'), h('dl', { class: 'facts' }, fact(t('report.extent'), `${fmt.m(r.area.widthM)} × ${fmt.m(r.area.heightM)}`), fact(t('report.elevRange'), `${fmt.m(r.area.minElevation)} – ${fmt.m(r.area.maxElevation)}`), fact(t('report.meanSlope'), `${fmt.n(r.area.meanSlopeDeg)}°`))));
} else {
  const s = r.summary, f = r.footing, dfc = r.difficulty;
  root.append(h('div', { class: 'figures' },
    fig(fmt.dist(s.lengthM), t('report.distance')), fig(fmt.m(s.ascentM), t('report.ascent'), `${t('report.descent')} ${fmt.m(s.descentM)}`), fig(fmt.time(r.time.minutes), t('report.time'), t('report.timeBack', { v: fmt.time(r.time.minutesBack) })),
    fig(t(`level.${dfc.level}`), t('report.difficulty'), t('report.score', { v: dfc.score })), fig(fmt.m(s.maxElevation, meta.fine ? 1 : 0), t('report.highest'), `${t('report.lowest')} ${fmt.m(s.minElevation, meta.fine ? 1 : 0)}`), fig(fmt.pct(s.p90GradePct), t('report.steepest'), t('report.maxGrade', { v: fmt.pct(s.maxGradePct) }))));

  const chart = h('div'), shares = h('div');
  root.append(section(t('report.profile'), h('div', { class: 'cols' }, h('div', {}, chart, h('p', { class: 'small muted', style: 'margin-top:.6rem' }, t('report.profileNote'))), h('div', {}, h('h4', {}, t('report.gradeMix')), shares))));
  profileChart(chart, r.profile, { hazards: r.hazards, onSelect: (d) => { location.href = `/trail/${id}?d=${Math.round(d)}`; } });
  gradeShares(shares, r.grade.sharePct, r.grade.buckets);

  const levels = ['easy', 'moderate', 'demanding', 'difficult', 'severe'], li = levels.indexOf(dfc.level);
  const factors = h('div');
  root.append(section(t('report.difficulty'), h('div', { class: 'cols' },
    h('div', {}, h('div', { class: 'level' }, h('b', {}, t(`level.${dfc.level}`)), h('span', { class: 'muted' }, t('report.sac', { v: dfc.sac }))),
      h('div', { class: 'level-scale', role: 'img', 'aria-label': `${li + 1} / 5` }, levels.map((_, i) => h('i', { class: i <= li ? 'on' : '' }))),
      h('p', {}, t(`levelNote.${dfc.level}`)), dfc.accessible ? h('p', { class: 'callout info' }, t('report.accessible')) : null),
    h('div', {}, h('h4', {}, t('report.why')), factors, h('p', { class: 'small muted', style: 'margin-top:.9rem' }, t('report.whyNote', { v: fmt.n(dfc.effortKm, 1) }))))));
  factorBars(factors, [{ label: t('factor.steepness'), value: dfc.factors.steepness }, { label: t('factor.footing'), value: dfc.factors.footing }, { label: t('factor.exposure'), value: dfc.factors.exposure }, { label: t('factor.effort'), value: dfc.factors.effort }]);

  root.append(section(t('report.underfoot'),
    h('dl', { class: 'facts' },
      fact(t('report.roughness'), fmt.cm(f.roughnessCm, 1), t(f.resolved ? 'report.roughnessFine' : 'report.roughnessCoarse')),
      f.resolved ? fact(t('report.steps'), fmt.n(f.steps), f.stairFlights ? t('report.flights', { n: f.stairFlights }) : t('report.noFlights')) : null,
      f.resolved ? fact(t('report.obstacles'), fmt.n(f.obstacles), t('report.obstaclesNote')) : null,
      f.resolved && f.clearWidthMinM != null ? fact(t('report.width'), f.clearWidthMinM >= 3.9 ? t('report.widthOpen') : fmt.m(f.clearWidthMinM, 2), f.clearWidthMedianM >= 3.9 ? t('report.widthTypicalOpen') : t('report.widthTypical', { v: fmt.m(f.clearWidthMedianM, 2) })) : null),
    f.resolved ? null : h('p', { class: 'callout info', style: 'margin-top:1.2rem' }, h('span', {}, t('report.needScan'), ' ', h('a', { href: '/capture' }, t('report.needScanLink'))))));

  const w = r.water;
  root.append(section(t('report.waterShade'), h('dl', { class: 'facts' },
    fact(t('report.crossings'), fmt.n(w.crossings + w.streams), w.streams ? t('report.crossingsMapped', { n: w.streams }) : w.inferred ? t('report.crossingsInferred') : t('report.crossingsNone')),
    fact(t('report.sources'), fmt.n(w.sources.length), w.sources.length ? w.sources.slice(0, 3).map((x) => `${x.name || t(`water.${x.kind}`)} (${fmt.dist(x.d)})`).join(', ') : t(meta.hasOsm ? 'report.sourcesNone' : 'report.sourcesUnknown')),
    fact(t('report.shade'), r.shade ? fmt.pct(r.shade.sharePct) : '–', r.shade ? t('report.shadeNote') : t('report.shadeUnknown')),
    r.exposure ? fact(t('report.exposure'), fmt.pct(r.exposure.sharePct), t('report.exposureNote')) : null)));

  if (r.hazards.length) root.append(section(t('report.found'), h('div', { class: 'sheet', style: 'overflow-x:auto' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, t('report.col.what')), h('th', {}, t('report.col.where')), h('th', {}, t('report.col.detail')), h('th', { class: 'no-print' }))),
    h('tbody', {}, r.hazards.map((hz) => h('tr', {},
      h('td', {}, h('span', { class: `hz-icon ${hz.type === 'crossing' || hz.type === 'stream' ? 'water' : ''}`, html: icon(HZ_ICON[hz.type] || 'alert') })),
      h('td', {}, h('b', {}, t(`hz.${hz.type}`))), h('td', { class: 'num' }, fmt.dist(hz.d)), h('td', { class: 'muted' }, hazardDetail(hz)),
      h('td', { class: 'end no-print' }, h('a', { href: `/trail/${id}?d=${Math.max(0, Math.round(hz.d0 - (meta.fine ? 2 : 10)))}` }, t('report.show3d'))))))))));

  const gradeWord = (g) => { const a = Math.abs(g), k = a < 3 ? 'flat' : a < 8 ? 'gentle' : a < 15 ? 'moderate' : a < 30 ? 'steep' : 'verySteep'; return a < 3 ? t('sec.flat') : t(g > 0 ? 'sec.up' : 'sec.down', { how: t(`grade.${k}`).toLowerCase() }); };
  root.append(section(t('report.sections'), h('div', { class: 'sheet', style: 'overflow-x:auto' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, t('report.col.stretch')), h('th', {}, t('report.col.going')), h('th', { class: 'end' }, t('report.gradeShort')), h('th', {}, t('report.col.notes')))),
    h('tbody', {}, r.sections.map((sec) => h('tr', {},
      h('td', { class: 'num', dir: 'ltr', style: 'text-align:start;white-space:nowrap' }, `${fmt.n(sec.d0)}–${fmt.dist(sec.d1)}`), h('td', {}, gradeWord(sec.grade)), h('td', { class: 'num end' }, fmt.pct(sec.grade)),
      h('td', { class: 'muted' }, [...new Set(sec.hazards)].map((x) => t(`hz.${x}`)).join(', ') || (sec.shadePct != null && sec.shadePct > 60 ? t('sec.shaded') : '–')))))))));

  const photos = (meta.photos || []);
  if (photos.length) root.append(section(t('report.photos'), h('div', { class: 'gallery' }, photos.map((p) => h('a', { href: `${base}/photo/${p.id}`, target: '_blank', rel: 'noopener' }, h('img', { src: `${base}/photo/${p.id}`, alt: p.name, loading: 'lazy' }))))));
}

const lineKey = r.lineSource ? `viewer.line.${r.lineSource}` : 'viewer.line.none';
root.append(section(t('report.data'),
  h('dl', { class: 'facts' },
    fact(t('report.d.points'), fmt.n(meta.points.count), t('report.d.pointsNote', { read: fmt.n(meta.points.read), voxel: fmt.cm(meta.points.voxel * 100, meta.fine ? 0 : 0) })),
    fact(t('report.d.ground'), fmt.cm(meta.dem.cell * 100), t(meta.dem.classified ? 'report.d.groundClass' : 'report.d.groundFilter')),
    fact(t('report.d.crs'), meta.crs ? `EPSG:${meta.crs.epsg}` : t('report.d.local'), meta.crs ? meta.crs.name : t('report.d.localNote')),
    fact(t('report.d.line'), t(`report.lineShort.${r.lineSource || 'none'}`), t(lineKey)),
    meta.wgs?.center ? fact(t('report.d.where'), `${fmt.n(meta.wgs.center[1], 4)}, ${fmt.n(meta.wgs.center[0], 4)}`, t('report.d.whereNote')) : null,
    fact(t('report.d.elev0'), fmt.m(z0), t(meta.georef ? 'report.d.elevAbs' : 'report.d.elevRel'))),
  ...(meta.warnings || []).map((wn) => h('p', { class: 'callout', style: 'margin-top:1rem' }, t(`warn.${wn.code}`))),
  h('ul', { class: 'fineprint', style: 'margin-top:1.4rem' }, ['report.fine1', 'report.fine2', 'report.fine3', meta.texture?.attribution ? null : null].filter(Boolean).map((k) => h('li', {}, t(k))),
    meta.texture?.attribution ? h('li', {}, t('viewer.imageBy', { who: meta.texture.attribution })) : null, meta.hasOsm ? h('li', {}, t('report.osmCredit')) : null)));
