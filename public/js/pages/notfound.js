import { initI18n, t, h, $ } from '../core.js';
await initI18n();
$('#app').replaceWith(h('main', { class: 'page narrow' }, h('a', { class: 'brand', href: '/', html: '<img src="/img/logo.svg" alt="" width="30" height="30"><span>Masar</span>' }),
  h('h1', { style: 'margin-top:3rem' }, t('nf.title')), h('p', { class: 'muted' }, t('nf.body')), h('a', { class: 'btn', href: '/' }, t('nf.home'))));
