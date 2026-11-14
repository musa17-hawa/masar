// Charts for the trail report and the viewer. Plain SVG, no library.
// One measure per chart, a single hue per series, thin marks, hover read-outs, text in ink (never in series colour).
import { fmt, t, h, lang } from './core.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); el.append(...kids.filter((k) => k != null)); return el; };

// Steepness, light → dark in one hue (sequential): flat, gentle, moderate, steep, very steep.
export const GRADE_RAMP = ['#F1D8C8', '#E6AE8E', '#D87F5D', '#BE4F38', '#8A2D21'];
export const gradeBucket = (g, buckets = [5, 10, 20, 35]) => { const a = Math.abs(g); const i = buckets.findIndex((b) => a < b); return i < 0 ? buckets.length : i; };

function niceStep(range, target) {
  const raw = range / target, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

// Elevation profile with a steepness strip underneath. Returns { setCursor(d), destroy() }.
export function profileChart(box, profile, opts = {}) {
  const { d, z, grade } = profile;
  const hazards = opts.hazards || [];
  const compact = !!opts.compact;
  let cursorD = null, W = 0;
  const tip = h('div', { class: 'chart-tip', hidden: true });
  box.classList.add('chart'); box.style.position = 'relative';
  let svg = null;

  const total = d[d.length - 1] || 1;
  let zLo = Math.min(...z), zHi = Math.max(...z);
  const pad = Math.max((zHi - zLo) * 0.12, compact ? 0.5 : 1);
  const step = niceStep(zHi - zLo + pad * 2, compact ? 2 : 4);
  zLo = Math.floor((zLo - pad) / step) * step; zHi = Math.ceil((zHi + pad * 0.5) / step) * step;
  const Ht = opts.height || (compact ? 96 : 230);
  const m = compact ? { l: 6, r: 6, t: 6, b: 16 } : { l: 46, r: 14, t: 12, b: 44 };

  function draw() {
    W = Math.max(240, box.clientWidth);
    const iw = W - m.l - m.r, ih = Ht - m.t - m.b;
    const X = (v) => m.l + v / total * iw, Y = (v) => m.t + (1 - (v - zLo) / (zHi - zLo)) * ih;
    svg?.remove();
    svg = s('svg', { viewBox: `0 0 ${W} ${Ht}`, width: W, height: Ht, role: 'img', 'aria-label': opts.label || t('report.profile'), dir: 'ltr', class: 'profile-svg' });
    if (!compact) for (let v = zLo; v <= zHi + 1e-6; v += step) {
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
      const label = s('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }); label.textContent = fmt.n(v, step < 1 ? 1 : 0); svg.append(label);
    }
    let path = `M${X(d[0]).toFixed(1)} ${Y(z[0]).toFixed(1)}`;
    for (let i = 1; i < d.length; i++) path += `L${X(d[i]).toFixed(1)} ${Y(z[i]).toFixed(1)}`;
    svg.append(s('path', { d: `${path}L${X(total)} ${m.t + ih}L${X(0)} ${m.t + ih}Z`, class: 'area' }), s('path', { d: path, class: 'line' }));
    // steepness strip: one rect per run of equal bucket, 6px tall, under the baseline
    const sy = m.t + ih + (compact ? 4 : 8);
    const sm = grade.map((_, i) => { let a = 0, c = 0; for (let k = Math.max(0, i - 3); k <= Math.min(grade.length - 1, i + 3); k++) { a += Math.abs(grade[k]); c++; } return a / c; });
    let start = 0, cur = gradeBucket(sm[0]);
    for (let i = 1; i <= d.length; i++) {
      const b = i < d.length ? gradeBucket(sm[i]) : -1;
      if (b !== cur) { svg.append(s('rect', { x: X(d[start]), y: sy, width: Math.max(0.5, X(d[Math.min(i, d.length - 1)]) - X(d[start])), height: 6, fill: GRADE_RAMP[cur] })); start = i; cur = b; }
    }
    if (!compact) {
      const tx = niceStep(total, Math.max(3, Math.min(8, Math.floor(iw / 90))));
      const km = total >= 3000, digits = km ? (tx < 1000 ? 1 : 0) : (tx < 1 ? 1 : 0);
      for (let v = 0; v <= total + 1e-6; v += tx) { const lab = s('text', { x: X(v), y: Ht - 8, 'text-anchor': v === 0 ? 'start' : 'middle', class: 'tick' }); lab.textContent = `${fmt.n(km ? v / 1000 : v, digits)} ${t(km ? 'u.km' : 'u.m')}`; svg.append(lab); }
      for (const hz of hazards) { const i = nearest(hz.d); svg.append(s('circle', { cx: X(hz.d), cy: Y(z[i]), r: 4, class: 'hz' })); }
    }
    const cursor = s('g', { class: 'cursor', visibility: 'hidden' }, s('line', { y1: m.t, y2: m.t + ih, class: 'cursor-line' }), s('circle', { r: 5, class: 'cursor-dot' }));
    svg.append(cursor);
    svg.append(s('rect', { x: m.l, y: 0, width: iw, height: Ht, fill: 'transparent', class: 'hit' }));
    box.prepend(svg);
    svg._X = X; svg._Y = Y; svg._cursor = cursor; svg._iw = iw;
    if (cursorD != null) place(cursorD, false);
  }
  const nearest = (dist) => { let lo = 0, hi = d.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (d[mid] <= dist) lo = mid; else hi = mid; } return dist - d[lo] < d[hi] - dist ? lo : hi; };
  function place(dist, showTip) {
    cursorD = dist;
    const i = nearest(dist), x = svg._X(d[i]), y = svg._Y(z[i]);
    svg._cursor.setAttribute('visibility', 'visible');
    svg._cursor.firstChild.setAttribute('x1', x); svg._cursor.firstChild.setAttribute('x2', x);
    svg._cursor.lastChild.setAttribute('cx', x); svg._cursor.lastChild.setAttribute('cy', y);
    if (showTip) {
      tip.hidden = false;
      tip.replaceChildren(h('b', {}, fmt.dist(d[i])), h('span', {}, `${t('report.elevation')} ${fmt.m(z[i], z[i] < 100 ? 1 : 0)}`), h('span', {}, `${t('report.gradeShort')} ${fmt.pct(grade[i])}`));
      tip.style.left = `${Math.min(W - 150, Math.max(4, x + 12))}px`; tip.style.top = `${Math.max(0, y - 54)}px`;
    }
    return i;
  }
  const fromEvent = (e) => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(total, (e.clientX - r.left - m.l) / svg._iw * total)); };
  const move = (e) => { if (!svg || e.target.closest('svg') !== svg) return; const dist = fromEvent(e); place(dist, true); opts.onHover?.(dist); if (e.buttons === 1) opts.onSelect?.(dist); };
  const leave = () => { tip.hidden = true; opts.onLeave?.(); };
  const click = (e) => { if (svg && e.target.closest('svg') === svg) opts.onSelect?.(fromEvent(e)); };
  box.addEventListener('pointermove', move); box.addEventListener('pointerleave', leave); box.addEventListener('pointerdown', click);
  box.append(tip);
  const ro = new ResizeObserver(() => { if (Math.abs(box.clientWidth - W) > 2) draw(); });
  ro.observe(box);
  draw();
  return { setCursor(dist) { if (svg && dist != null) place(dist, false); }, destroy() { ro.disconnect(); box.replaceChildren(); } };
}

// One stacked bar: share of the trail in each steepness class, with a legend that carries the numbers.
export function gradeShares(box, sharePct, buckets) {
  const labels = [t('grade.flat'), t('grade.gentle'), t('grade.moderate'), t('grade.steep'), t('grade.verySteep')];
  const ranges = [`< ${buckets[0]}%`, `${buckets[0]}–${buckets[1]}%`, `${buckets[1]}–${buckets[2]}%`, `${buckets[2]}–${buckets[3]}%`, `> ${buckets[3]}%`];
  const bar = h('div', { class: 'share-bar', role: 'img', 'aria-label': t('report.gradeMix') },
    sharePct.map((p, i) => (p > 0 ? h('i', { style: `flex:${p} 0 0;background:${GRADE_RAMP[i]}`, title: `${labels[i]} ${fmt.pct(p)}` }) : null)));
  const legend = h('ul', { class: 'share-legend' }, sharePct.map((p, i) => h('li', {}, h('i', { style: `background:${GRADE_RAMP[i]}` }), h('span', {}, labels[i], ' ', h('small', { dir: 'ltr' }, ranges[i])), h('b', { class: 'num' }, fmt.pct(p)))));
  box.replaceChildren(bar, legend);
}

// Horizontal magnitude bars (0–100), single hue.
export function factorBars(box, rows) {
  box.replaceChildren(h('div', { class: 'factor-bars' }, rows.map((r) => h('div', { class: 'factor' },
    h('span', {}, r.label), h('div', { class: 'factor-track', title: `${r.label}: ${r.value}/100` }, h('i', { style: `width:${Math.max(1.5, r.value)}%` })), h('b', { class: 'num' }, fmt.n(r.value)), r.note ? h('small', {}, r.note) : null))));
}
export { lang };
