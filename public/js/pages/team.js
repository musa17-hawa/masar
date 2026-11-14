// Team page: who has access. Admins add and remove people; everyone can change their own password.
import { mountApp, t, api, h, $, fmt, icon, toast, confirmDialog } from '../core.js';

const me = await mountApp('team');
document.title = `${t('nav.team')} — Masar`;
const root = h('main', { class: 'page narrow' });
$('#app').replaceWith(root);
const admin = me.role === 'admin';

async function render() {
  const { users } = await api('GET', '/api/users');
  const rows = users.map((u) => h('tr', {},
    h('td', {}, h('b', {}, u.name), u.id === me.id ? h('span', { class: 'muted' }, ` (${t('team.you')})`) : null, h('div', { class: 'small muted', dir: 'ltr', style: 'text-align:start' }, u.email)),
    h('td', {}, h('span', { class: `tag ${u.role === 'admin' ? 'ok' : ''}` }, t(u.role === 'admin' ? 'team.admin' : 'team.member'))),
    h('td', { class: 'small muted' }, fmt.date(u.createdAt)),
    h('td', { class: 'end' }, admin && u.id !== me.id ? h('button', { class: 'btn danger sm', title: t('team.remove'), 'aria-label': `${t('team.remove')}: ${u.name}`, html: icon('trash'), onclick: async () => {
      if (!await confirmDialog({ title: t('team.removeTitle', { name: u.name }), body: t('team.removeBody'), confirm: t('team.remove'), danger: true })) return;
      try { await api('DELETE', `/api/users/${u.id}`); toast(t('team.removed')); render(); } catch (err) { toast(err.message, 'bad'); }
    } }) : null)));

  const field = (id, label, attrs = {}, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { class: 'input', id, name: id, required: true, ...attrs }), hint ? h('span', { class: 'hint' }, hint) : null);
  const addForm = h('form', { class: 'sheet pad' }, h('h3', {}, t('team.addTitle')), h('p', { class: 'muted small' }, t('team.addLead')),
    h('div', { class: 'grid-2' }, field('name', t('auth.name'), { autocomplete: 'off' }), field('email', t('auth.email'), { type: 'email', autocomplete: 'off', dir: 'ltr' })),
    h('div', { class: 'grid-2' }, field('password', t('team.tempPassword'), { type: 'text', minlength: 8, autocomplete: 'off', dir: 'ltr' }, t('auth.passwordHint')),
      h('div', { class: 'field' }, h('label', { for: 'role' }, t('team.role')), h('select', { class: 'input', id: 'role', name: 'role' }, h('option', { value: 'member' }, t('team.member')), h('option', { value: 'admin' }, t('team.admin'))))),
    h('button', { class: 'btn', type: 'submit' }, t('team.add')));
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/users', Object.fromEntries(new FormData(addForm))); toast(t('team.added')); render(); } catch (err) { toast(err.message, 'bad'); }
  });

  const pwForm = h('form', { class: 'sheet pad' }, h('h3', {}, t('team.passwordTitle')),
    h('div', { class: 'grid-2' }, field('current', t('team.currentPassword'), { type: 'password', autocomplete: 'current-password', dir: 'ltr' }), field('newpw', t('team.newPassword'), { type: 'password', minlength: 8, autocomplete: 'new-password', dir: 'ltr' }, t('auth.passwordHint'))),
    h('button', { class: 'btn ghost', type: 'submit' }, t('team.changePassword')));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(pwForm);
    try { await api('POST', `/api/users/${me.id}/password`, { current: f.get('current'), password: f.get('newpw') }); toast(t('team.passwordChanged')); pwForm.reset(); } catch (err) { toast(err.message, 'bad'); }
  });

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('team.title')), h('p', {}, t('team.lead')))),
    h('div', { class: 'sheet', style: 'overflow-x:auto;margin-bottom:1.5rem' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, t('team.person')), h('th', {}, t('team.role')), h('th', {}, t('team.since')), h('th', {}))), h('tbody', {}, rows))),
    admin ? addForm : h('p', { class: 'callout info' }, t('team.memberNote')),
    h('div', { style: 'height:1.5rem' }), pwForm);
}
render().catch((err) => toast(err.message, 'bad'));
