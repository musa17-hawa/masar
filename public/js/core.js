// Shared front-end helpers: translations (EN / HE / AR), API calls, the app header, toasts, formatting.
const LANGS = { en: { label: 'EN', dir: 'ltr', name: 'English' }, he: { label: 'עב', dir: 'rtl', name: 'עברית' }, ar: { label: 'ع', dir: 'rtl', name: 'العربية' } };
let dict = {}, fallback = {};
export let lang = 'en';

function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  let saved = null;
  try { saved = localStorage.getItem('masar.lang'); } catch { /* storage blocked */ }
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const pick = [q, saved, nav === 'iw' ? 'he' : nav].find((l) => l && LANGS[l]);
  return pick || 'en';
}

export async function initI18n() {
  lang = pickLang();
  fallback = (await import('./i18n/en.js')).default;
  try { dict = lang === 'en' ? fallback : (await import(`./i18n/${lang}.js`)).default; }
  catch { lang = 'en'; dict = fallback; }
  document.documentElement.lang = lang;
  document.documentElement.dir = LANGS[lang].dir;
  applyI18n(document);
}

export function setLang(l) {
  try { localStorage.setItem('masar.lang', l); } catch { /* ignore */ }
  const url = new URL(location.href); url.searchParams.delete('lang');
  location.replace(url);
}

export function t(key, vars) {
  let s = dict[key] ?? fallback[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
export const has = (key) => key in dict || key in fallback;

export function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) for (const pair of el.dataset.i18nAttr.split(';')) { const [attr, key] = pair.split(':'); el.setAttribute(attr.trim(), t(key.trim())); }
}

// ── DOM ──
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  trails: 'M3 19 9 7l4 7 2-3 6 8Z', plus: 'M12 5v14M5 12h14', phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2',
  team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20c0-3 2.7-5 6-5s6 2 6 5M16 5.5a3 3 0 0 1 0 5.5M18 15c1.8.6 3 2.1 3 5', out: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h10',
  upload: 'M12 16V5M7 9l5-5 5 5M5 19h14', layers: 'm12 4 9 5-9 5-9-5 9-5ZM3 14l9 5 9-5', walk: 'M13 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM9 21l2-6-2-2 1-5 4 3 3 1M11 8l-4 2-1 3M14 15l2 6',
  play: 'M7 4v16l13-8Z', pause: 'M7 4v16M17 4v16', orbit: 'M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0M3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5-9-2-9-4.5Z',
  report: 'M6 3h9l4 4v14H6ZM14 3v5h5M9 13h7M9 17h5', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', check: 'm5 12 5 5 9-10', alert: 'M12 4 2.5 20h19ZM12 10v4M12 17v.5',
  water: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z', stairs: 'M3 20h4v-4h4v-4h4V8h6', rock: 'm3 18 3-8 5-3 6 2 4 9Z', tree: 'M12 3 6 12h3l-4 6h14l-4-6h3ZM12 18v3',
  narrow: 'M4 4l4 8-4 8M20 4l-4 8 4 8M12 7v10', steep: 'M3 20 20 6M20 6v6M20 6h-6M3 20h17', camera: 'M4 8h3l2-3h6l2 3h3v11H4ZM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  gps: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  ruler: 'M3 16 16 3l5 5L8 21ZM7 12l2 2M10 9l2 2M13 6l2 2', sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5',
  close: 'M6 6l12 12M18 6 6 18', next: 'M9 5l7 7-7 7', back: 'M15 5l-7 7 7 7', print: 'M7 9V4h10v5M7 17H4V9h16v8h-3M7 14h10v6H7Z', pencil: 'm4 20 1-4L16 5l3 3L8 19ZM14 7l3 3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', cube: 'm12 3 8 4.5v9L12 21l-8-4.5v-9ZM12 12l8-4.5M12 12v9M12 12 4 7.5', info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.5v.5',
  image: 'M4 5h16v14H4ZM4 16l5-5 4 4 3-3 4 4M15 9.5a1 1 0 1 0 0-.1', hut: 'M4 11 12 4l8 7M6 10v10h12V10M10 20v-6h4v6', peak: 'm3 20 7-13 4 7 2-3 5 9ZM10 7v-3', flag: 'M6 21V4M6 5h11l-2 4 2 4H6',
  exposed: 'M3 8h8v12M11 12l10 8M15 6l3-3M18 9l3-1', overhang: 'M3 6h18M12 6v6M9 12h6M8 20h8', refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4', menu: 'M4 7h16M4 12h16M4 17h16', download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6',
};
export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.info}"/></svg>`;
}
export const iconEl = (name, cls) => { const s = document.createElement('span'); s.innerHTML = icon(name, cls); return s.firstChild; };

// ── API ──
export class ApiError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status; } }
export async function api(method, url, body, opts = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof Blob || body instanceof ArrayBuffer) { init.body = body; if (opts.type) init.headers['Content-Type'] = opts.type; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(url, init); } catch { throw new ApiError('offline', t('err.offline'), 0); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !opts.noRedirect && !/^\/(login|setup)?$/.test(location.pathname)) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; }
    const code = data?.error || 'server_error';
    throw new ApiError(code, has(`err.${code}`) ? t(`err.${code}`) : (data?.message && data.message !== code ? data.message : t('err.server_error')), res.status);
  }
  return data;
}

// ── formatting ──
const nf = (opts) => new Intl.NumberFormat(lang === 'ar' ? 'ar-u-nu-latn' : lang, opts);
export const fmt = {
  n: (v, digits = 0) => (v == null || Number.isNaN(v) ? '–' : nf({ maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v)),
  dist: (m) => (m == null ? '–' : m >= 1000 ? `${fmt.n(m / 1000, m >= 10000 ? 1 : 2)} ${t('u.km')}` : `${fmt.n(m, m < 100 ? 1 : 0)} ${t('u.m')}`),
  m: (v, digits = 0) => (v == null ? '–' : `${fmt.n(v, digits)} ${t('u.m')}`),
  cm: (v, digits = 0) => (v == null ? '–' : `${fmt.n(v, digits)} ${t('u.cm')}`),
  pct: (v, digits = 0) => (v == null ? '–' : `${fmt.n(v, digits)}%`),
  time: (min) => (min == null ? '–' : min < 60 ? `${fmt.n(min)} ${t('u.min')}` : `${fmt.n(Math.floor(min / 60))} ${t('u.h')} ${fmt.n(min % 60)} ${t('u.min')}`),
  bytes: (b) => (b >= 1e9 ? `${fmt.n(b / 1e9, 2)} GB` : b >= 1e6 ? `${fmt.n(b / 1e6, 1)} MB` : `${fmt.n(Math.max(1, b / 1e3))} kB`),
  date: (iso) => { try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(iso)); } catch { return iso; } },
};

// ── toasts / confirm ──
export function toast(message, kind = '') {
  let box = $('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const el = h('div', { class: `toast ${kind}` }, message);
  box.append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}
export function confirmDialog({ title, body, confirm, danger }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal' },
      h('div', { class: 'modal-body' }, h('h3', {}, title), h('p', { class: 'muted' }, body)),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { dlg.close(); resolve(false); } }, t('common.cancel')),
        h('button', { class: `btn ${danger ? 'go' : ''}`, onclick: () => { dlg.close(); resolve(true); } }, confirm)));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    document.body.append(dlg); dlg.showModal();
  });
}

export function langSwitch() {
  return h('div', { class: 'lang', role: 'group', 'aria-label': t('common.language') },
    Object.entries(LANGS).map(([code, l]) => h('button', { type: 'button', 'aria-pressed': String(code === lang), title: l.name, onclick: () => code !== lang && setLang(code) }, l.label)));
}

// ── app chrome ──
export async function mountApp(active) {
  await initI18n();
  let me;
  try { me = (await api('GET', '/api/me')).user; } catch { me = null; }
  if (!me) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return new Promise(() => {}); }
  const link = (href, key, ic, id) => h('a', { href, 'aria-current': active === id ? 'page' : null, html: `${icon(ic)}<span>${esc(t(key))}</span>` });
  const header = h('header', { class: 'app-header' },
    h('a', { class: 'brand', href: '/trails', html: '<img src="/img/logo.svg" alt="" width="30" height="30"><span>Masar</span>' }),
    h('nav', { class: 'app-nav', 'aria-label': t('nav.main') }, link('/trails', 'nav.trails', 'trails', 'trails'), link('/new', 'nav.new', 'plus', 'new'), link('/capture', 'nav.capture', 'phone', 'capture'), link('/team', 'nav.team', 'team', 'team')),
    h('div', { class: 'header-end' }, langSwitch(), h('span', { class: 'user-chip' }, me.name),
      h('button', { class: 'btn quiet sm', title: t('nav.signout'), 'aria-label': t('nav.signout'), html: icon('out', 'flip'), onclick: async () => { await api('POST', '/api/logout'); location.href = '/'; } })));
  document.body.prepend(header);
  document.body.classList.add('has-nav');
  return me;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
