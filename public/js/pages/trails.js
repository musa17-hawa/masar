// Trail library: every trail the team has built, with live build progress.
import { mountApp, t, api, h, $, fmt, icon, toast, confirmDialog } from '../core.js';

await mountApp('trails');
document.title = `${t('nav.trails')} — Masar`;
const root = h('main', { class: 'page' });
$('#app').replaceWith(root);
let trails = [], timer = null;

const statusTag = (tr) => {
  if (tr.status === 'ready') return null;
  const map = { draft: ['tag', t('trails.draft')], queued: ['tag busy', t('trails.queued')], processing: ['tag busy', `${t('trails.building')} ${tr.progress?.pct ?? 0}%`], error: ['tag bad', t('trails.failed')] };
  const [cls, label] = map[tr.status] || ['tag', tr.status];
  return h('span', { class: cls }, label);
};

function card(tr) {
  const s = tr.summary, ready = tr.status === 'ready';
  const thumb = h('div', { class: 'trail-thumb', style: ready && tr.hasThumb ? `background-image:url(/api/trails/${tr.id}/data/thumb.jpg?v=${encodeURIComponent(tr.updatedAt)})` : null },
    !(ready && tr.hasThumb) ? h('span', { html: tr.status === 'processing' || tr.status === 'queued' ? '<span class="spinner"></span>' : icon('trails') }) : null, statusTag(tr));
  const stats = ready && s?.hasPath
    ? h('div', { class: 'trail-stats' }, h('span', {}, h('b', {}, fmt.dist(s.lengthM))), h('span', {}, h('b', {}, `↑ ${fmt.m(s.ascentM)}`)), h('span', {}, h('b', {}, fmt.time(s.minutes))), h('span', {}, t(`level.${s.level}`)))
    : ready ? h('div', { class: 'trail-stats' }, h('span', {}, t('trails.noLine')))
      : tr.status === 'error' ? h('div', { class: 'trail-stats' }, h('span', {}, tr.error?.message || t('trails.failed')))
        : tr.status === 'draft' ? h('div', { class: 'trail-stats' }, h('span', {}, t('trails.draftHint'))) : h('div', { class: 'bar go' }, h('i', { style: `width:${tr.progress?.pct ?? 0}%` }));
  return h('article', { class: 'trail-card' }, thumb,
    h('div', { class: 'trail-info' },
      h('h3', {}, ready ? h('a', { href: `/trail/${tr.id}` }, tr.name) : tr.name),
      h('div', { class: 'small muted' }, [tr.location, tr.source === 'phone' ? t('trails.phoneScan') : tr.source === 'aerial' ? t('trails.survey') : null, fmt.date(tr.createdAt)].filter(Boolean).join(', ')),
      stats,
      h('div', { class: 'trail-actions' },
        ready ? h('a', { class: 'btn quiet sm', href: `/trail/${tr.id}`, html: `${icon('cube')}<span>${t('trails.open3d')}</span>` }) : null,
        ready ? h('a', { class: 'btn quiet sm', href: `/trail/${tr.id}/report`, html: `${icon('report')}<span>${t('trails.report')}</span>` }) : null,
        tr.status === 'error' ? h('button', { class: 'btn quiet sm', onclick: () => rebuild(tr), html: `${icon('refresh')}<span>${t('common.retry')}</span>` }) : null,
        h('button', { class: 'btn danger sm', 'aria-label': `${t('common.delete')}: ${tr.name}`, title: t('common.delete'), onclick: () => remove(tr), html: icon('trash') }))));
}

async function rebuild(tr) { try { await api('POST', `/api/trails/${tr.id}/process`, {}); load(); } catch (err) { toast(err.message, 'bad'); } }
async function remove(tr) {
  if (!await confirmDialog({ title: t('trails.deleteTitle', { name: tr.name }), body: t('trails.deleteBody'), confirm: t('trails.deleteConfirm'), danger: true })) return;
  try { await api('DELETE', `/api/trails/${tr.id}`); toast(t('trails.deleted')); load(); } catch (err) { toast(err.message, 'bad'); }
}
async function sample(kind, btn) {
  btn.disabled = true;
  try { await api('POST', '/api/sample', { kind }); toast(t('trails.sampleStarted')); await load(); } catch (err) { toast(err.message, 'bad'); }
  btn.disabled = false;
}

function starters() {
  const b1 = h('button', { class: 'choice', type: 'button', html: `${icon('trails')}<strong>${t('trails.sampleAlpine')}</strong><span>${t('trails.sampleAlpineBody')}</span>` });
  const b2 = h('button', { class: 'choice', type: 'button', html: `${icon('stairs')}<strong>${t('trails.samplePhone')}</strong><span>${t('trails.samplePhoneBody')}</span>` });
  b1.onclick = () => sample('alpine', b1); b2.onclick = () => sample('phone', b2);
  return h('div', { class: 'choice-grid' },
    h('a', { class: 'choice', href: '/new', html: `${icon('upload')}<strong>${t('trails.startUpload')}</strong><span>${t('trails.startUploadBody')}</span>` }),
    h('a', { class: 'choice', href: '/capture', html: `${icon('phone')}<strong>${t('trails.startPhone')}</strong><span>${t('trails.startPhoneBody')}</span>` }), b1, b2);
}

function render() {
  const head = h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('trails.title')), h('p', {}, t('trails.lead'))), trails.length ? h('a', { class: 'btn go', href: '/new', html: `${icon('plus')}<span>${t('nav.new')}</span>` }) : null);
  if (!trails.length) return root.replaceChildren(head, h('section', { class: 'empty' }, h('h2', {}, t('trails.emptyTitle')), h('p', { class: 'muted' }, t('trails.emptyBody')), starters()));
  root.replaceChildren(head, h('div', { class: 'trail-grid' }, trails.map(card)),
    h('details', { class: 'more', style: 'margin-top:2.5rem' }, h('summary', {}, t('trails.moreWays')), starters()));
}

async function load() {
  try { trails = (await api('GET', '/api/trails')).trails; } catch (err) { toast(err.message, 'bad'); return; }
  const open = root.querySelector('details.more')?.open;
  render();
  if (open) root.querySelector('details.more').open = true;
  clearTimeout(timer);
  if (trails.some((x) => x.status === 'processing' || x.status === 'queued')) timer = setTimeout(load, 1500);
}
load();
