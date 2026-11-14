// Landing page: the pinned 3D scene is driven entirely by scroll position.
import { initI18n, t, api, fmt, h, langSwitch, icon, $ } from '../core.js';
import { Engine, MODE, loadTrailData, loadImage } from '../gl/engine.js';
import { profileChart, gradeShares } from '../charts.js';

await initI18n();
$('#header-end').prepend(langSwitch());
api('GET', '/api/me', undefined, { noRedirect: true }).then(({ user, needsSetup }) => {
  const href = user ? '/trails' : needsSetup ? '/setup' : '/login';
  for (const id of ['cta-top', 'cta-hero', 'cta-end']) $(`#${id}`).href = href;
  if (user) $('#cta-top').textContent = t('land.open');
}).catch(() => {});

const header = $('.site-header');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const lerp = (a, b, k) => a + (b - a) * k;
const ramp = (p, a, b) => Math.max(0, Math.min(1, (p - a) / (b - a)));
const ease = (k) => k * k * (3 - 2 * k);

const [meta, report] = await Promise.all([fetch('/demo/meta.json').then((r) => r.json()), fetch('/demo/report.json').then((r) => r.json())]);
buildSampleReport();
const rail = buildRail();

let engine = null;
try { engine = new Engine($('#scene'), { transparent: true }); }
catch { $('#stage-note').textContent = t('land.noWebgl'); }

if (engine) {
  const data = await loadTrailData('/demo', meta);
  engine.setPoints(data.points); engine.setTerrain(data.terrain);
  loadImage('/demo/texture.jpg').then((img) => engine.setTexture(img, [0, 0, meta.size[0], meta.size[1]]));
  const L = report.line;
  engine.setTrail(L, 2.6, 0.5);
  $('#stage-note').remove();

  const [W, H] = meta.size, zc = (meta.dem.zMin + meta.dem.zMax) / 2, span = Math.hypot(W, H);
  const centre = [W / 2, H / 2, zc];
  // one camera pose per chapter: azimuth, elevation, distance (× scene span)
  const POSES = [[0.55, 0.52, 1.16], [0.2, 0.8, 1.22], [0.95, 0.6, 1.12], [1.35, 0.72, 1.08], [0.25, 0.98, 1.12], [0.6, 0.5, 1.1], [0.75, 0.56, 1.3]];
  const orbit = ([az, el, dist], spin) => { const d = dist * span, ce = Math.cos(el), a = az + spin; return { eye: [centre[0] + d * ce * Math.sin(a), centre[1] - d * ce * Math.cos(a), centre[2] + d * Math.sin(el)], target: centre }; };
  const total = L.d[L.d.length - 1];
  const along = (dist) => { let i = 1; while (i < L.d.length - 1 && L.d[i] < dist) i++; const k = (dist - L.d[i - 1]) / Math.max(1e-6, L.d[i] - L.d[i - 1]); return [lerp(L.x[i - 1], L.x[i], k), lerp(L.y[i - 1], L.y[i], k), lerp(L.z[i - 1], L.z[i], k)]; };

  const pins = [];
  const addPin = (label, pos, cls = '') => { const el = h('div', { class: `pin ${cls}` }, h('i'), label); $('#pins').append(el); pins.push({ el, pos }); };
  addPin(t('land.pin.start'), [L.x[0], L.y[0], L.z[0] + 4]);
  for (const hz of report.hazards.filter((x) => ['steep', 'crossing', 'exposed'].includes(x.type)).slice(0, 3)) addPin(t(`hz.${hz.type}`), [hz.x, hz.y, hz.z + 4]);
  addPin(t('land.pin.end'), [L.x[L.x.length - 1], L.y[L.y.length - 1], L.z[L.z.length - 1] + 4], 'end');

  const story = $('#story');
  let progress = 0, visible = true, lastP = -1, lastSpin = -1, trailNarrow = false;
  const readScroll = () => { progress = Math.max(0, Math.min(6.2, (scrollY - story.offsetTop) / innerHeight)); header.classList.toggle('scrolled', scrollY > 8); };
  addEventListener('scroll', readScroll, { passive: true }); addEventListener('resize', readScroll);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(story);
  readScroll();

  engine.onFrame = (now) => {
    if (!visible) return;
    const p = progress, spin = reduced ? 0 : now * 0.00002;
    if (p === lastP && (reduced || p > 4.4 && p < 5.9) && spin === lastSpin) return;
    lastP = p; lastSpin = spin;
    // camera
    const c = Math.min(5, Math.floor(p)), k = ease(ramp(p - c, 0.2, 0.8));
    const a = orbit(POSES[c], spin), b = orbit(POSES[c + 1], spin);
    let eye = a.eye.map((v, i) => lerp(v, b.eye[i], k)), target = centre.slice();
    const walk = ease(ramp(p, 4.45, 4.9)) * (1 - ease(ramp(p, 5.5, 5.95)));
    if (walk > 0) {
      const dist = lerp(0.1, 0.52, ramp(p, 4.5, 5.6)) * total, here = along(dist), ahead = along(Math.min(total, dist + 14));
      const we = [here[0], here[1], here[2] + 2.2], wt = [ahead[0], ahead[1], ahead[2] + 1.2];
      eye = eye.map((v, i) => lerp(v, we[i], walk)); target = target.map((v, i) => lerp(v, wt[i], walk));
    }
    engine.camera.eye = eye; engine.camera.target = target;
    // what is drawn
    const toClasses = ramp(p, 1.55, 1.9), toPhoto = ramp(p, 2.6, 3.05);
    const vegKeep = p < 2.7 ? 1 - 0.97 * ramp(p, 2.05, 2.4) : 0.03 + 0.97 * ramp(p, 2.85, 3.2);
    engine.set({
      mode: toPhoto > 0 ? MODE.classes : MODE.ink, modeB: toPhoto > 0 ? MODE.photo : MODE.classes, mix: toPhoto > 0 ? toPhoto : toClasses,
      sweep: p < 0.5 ? -1 : lerp(-0.06, 1.1, ramp(p, 0.55, 1.25)), keep: 0.16, vegKeep,
      showMesh: p > 2.05, meshAlpha: ramp(p, 2.1, 2.5),
      trailProgress: ramp(p, 3.35, 4.0), fogAmount: lerp(0.5, 0.75, walk),
      pointSize: lerp(1.0, 1.5, toPhoto), minPx: lerp(1.3, 1.8, toClasses), maxPx: lerp(5, 26, walk),
    });
    // labels on the trail
    const narrow = walk > 0.35;                         // a wide ribbon reads from the air; at eye level it must be path-sized
    if (narrow !== trailNarrow) { trailNarrow = narrow; engine.setTrail(L, narrow ? 0.5 : 2.6, narrow ? 0.08 : 0.5); }
    const pinAlpha = ramp(p, 3.75, 3.98) * (1 - ramp(p, 4.42, 4.6));
    $('#pins').style.opacity = pinAlpha;
    if (pinAlpha > 0) { engine.render(); for (const pin of pins) { const s = engine.project(pin.pos); pin.el.style.transform = s ? `translate(${s[0] - 12}px, ${s[1] - 12}px)` : 'translate(-999px,-999px)'; } }
    rail.set(p);
  };
} else {
  const story = $('#story');
  const onScroll = () => { rail.set(Math.max(0, Math.min(6.2, (scrollY - story.offsetTop) / innerHeight))); header.classList.toggle('scrolled', scrollY > 8); };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
}

function buildRail() {
  const box = $('#rail'), { d, z } = report.profile;
  const lo = Math.min(...z), hi = Math.max(...z), total = d[d.length - 1];
  const pts = d.map((v, i) => [v / total * 100, 30 - (z[i] - lo) / (hi - lo) * 26]);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 100 32'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('dir', 'ltr');
  const mk = (cls) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('class', cls); svg.append(p); return p; };
  const base = mk('profile'), walked = mk('walked');
  base.setAttribute('d', `M${pts.map((p) => p.join(' ')).join('L')}`);
  const dot = h('span', { class: 'dot' });
  const names = ['scan', 'sort', 'drape', 'trace', 'walk', 'report'];
  const list = h('ol', {}, names.map((n, i) => h('li', {}, h('a', { href: `#ch-${i + 1}` }, h('b', {}, String(i + 1)), h('span', {}, t(`land.rail.${n}`))))));
  box.append(svg, dot, list);
  const rtl = document.documentElement.dir === 'rtl';
  if (rtl) svg.style.transform = 'scaleX(-1)';
  return { set(p) {
    const f = Math.max(0, Math.min(1, p / 6)), n = Math.max(1, Math.round(f * (pts.length - 1)));
    walked.setAttribute('d', `M${pts.slice(0, n + 1).map((q) => q.join(' ')).join('L')}`);
    const q = pts[n];
    dot.style.left = `${rtl ? 100 - q[0] : q[0]}%`; dot.style.top = `${q[1] / 32 * 2.4}rem`;
    list.childNodes.forEach((li, i) => li.classList.toggle('on', Math.round(p) === i + 1));
  } };
}

function buildSampleReport() {
  const box = $('#sample-report'), s = report.summary;
  const fig = (value, label) => h('div', {}, h('b', {}, value), h('span', {}, label));
  const chart = h('div'), shares = h('div');
  const typeIcon = { steep: 'steep', crossing: 'water', exposed: 'exposed', stairs: 'stairs', obstacle: 'rock' };
  box.append(
    h('div', { class: 'figures' }, fig(fmt.dist(s.lengthM), t('report.distance')), fig(fmt.m(s.ascentM), t('report.ascent')), fig(fmt.time(report.time.minutes), t('report.time')), fig(t(`level.${report.difficulty.level}`), t('report.difficulty'))),
    h('div', { class: 'sample-cols' },
      h('div', {}, h('h3', {}, t('report.profile')), chart),
      h('div', {}, h('h3', {}, t('report.gradeMix')), shares, h('h3', { style: 'margin-top:1.6rem' }, t('report.found')),
        h('ul', { class: 'found' }, report.hazards.slice(0, 4).map((hz) => h('li', { html: `${icon(typeIcon[hz.type] || 'alert')}<span>${t(`hz.${hz.type}`)}</span><small>${fmt.dist(hz.d)}</small>` }))))));
  profileChart(chart, report.profile, { hazards: report.hazards });
  gradeShares(shares, report.grade.sharePct, report.grade.buckets);
}
