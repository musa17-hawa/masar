// Sign-in and first-run setup share this page script.
import { initI18n, t, api, h, $, langSwitch, icon } from '../core.js';

await initI18n();
const setup = document.body.classList.contains('page-setup');
document.title = `${t(setup ? 'auth.setupTitle' : 'auth.signin')} — Masar`;
const next = new URLSearchParams(location.search).get('next');
const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/trails';

// contour lines for the side panel, drawn once from a few sine terms
function contours() {
  let paths = '';
  for (let i = 0; i < 13; i++) {
    const r = 60 + i * 46; let d = '';
    for (let a = 0; a <= 360; a += 6) {
      const k = a * Math.PI / 180, rr = r * (1 + 0.16 * Math.sin(k * 2 + i * 0.35) + 0.09 * Math.sin(k * 5 - i * 0.6) + 0.05 * Math.cos(k * 3 + 1));
      d += `${a ? 'L' : 'M'}${(520 + rr * Math.cos(k)).toFixed(1)} ${(380 + rr * 0.8 * Math.sin(k)).toFixed(1)}`;
    }
    paths += `<path d="${d}Z" fill="none" stroke="#F3F4EE" stroke-opacity="${i % 4 === 0 ? 0.3 : 0.13}" stroke-width="${i % 4 === 0 ? 1.4 : 1}"/>`;
  }
  return `<svg viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${paths}
    <path d="M250 610 430 560 330 470 520 400 470 330" fill="none" stroke="#D8412F" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M250 610 430 560 330 470 520 400 470 330" fill="none" stroke="#F3F4EE" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".0"/>
    <circle cx="470" cy="330" r="8" fill="#F2C230" stroke="#13252C" stroke-width="3"/></svg>`;
}

const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
const field = (id, label, attrs, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { class: 'input', id, name: id, required: true, ...attrs }), hint ? h('span', { class: 'hint' }, hint) : null);
const submit = h('button', { class: 'btn go', type: 'submit' }, t(setup ? 'auth.create' : 'auth.signin'));
const form = h('form', { novalidate: true },
  h('h1', {}, t(setup ? 'auth.setupTitle' : 'auth.welcome')),
  h('p', { class: 'muted' }, t(setup ? 'auth.setupLead' : 'auth.lead')),
  error,
  setup ? field('name', t('auth.name'), { autocomplete: 'name' }) : null,
  field('email', t('auth.email'), { type: 'email', autocomplete: setup ? 'email' : 'username', inputmode: 'email', dir: 'ltr' }),
  field('password', t('auth.password'), { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', minlength: 8, dir: 'ltr' }, setup ? t('auth.passwordHint') : null),
  h('div', { class: 'btn-row' }, submit),
  setup ? null : h('p', { class: 'small muted', style: 'margin-top:1.5rem' }, t('auth.noAccount')));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true; submit.disabled = true;
  const body = Object.fromEntries(new FormData(form));
  try {
    await api('POST', setup ? '/api/setup' : '/api/login', body, { noRedirect: true });
    location.href = setup ? '/trails' : dest;
  } catch (err) {
    error.replaceChildren(h('span', { html: icon('alert') }), err.message); error.hidden = false; submit.disabled = false;
    $('#password').focus();
  }
});

$('#app').replaceWith(h('main', { class: 'auth' },
  h('section', { class: 'auth-form' },
    h('div', { class: 'auth-top' }, h('a', { class: 'brand', href: '/', html: '<img src="/img/logo.svg" alt="" width="30" height="30"><span>Masar</span>' }), langSwitch()),
    form),
  h('aside', { class: 'auth-art', html: `${contours()}<blockquote>${t('auth.quote')}</blockquote>` })));
$(setup ? '#name' : '#email').focus();
