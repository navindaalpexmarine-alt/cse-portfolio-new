/**
 * Sign-in / create-account / forgot-password screen.
 * `showAuth()` resolves with the signed-in user once any of the forms succeed.
 */
import * as api from '../core/account.js';
import { showRecoveryCode } from '../core/ui.js';
import { $, $$ } from '../core/utils.js';

const screen = () => $('#authScreen');

function setPanel(name) {
  screen().dataset.panel = name;
  $$('[data-auth-panel]').forEach((f) => { f.hidden = f.dataset.authPanel !== name; });
  $$('.auth-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.authTab === name)));
  showError('');
  const form = $(`[data-auth-panel="${name}"]`);
  // carry the typed e-mail across panels
  const email = $$('.auth-form input[type="email"]').map((i) => i.value).find(Boolean) || '';
  form.querySelectorAll('input[type="email"]').forEach((i) => { if (!i.value) i.value = email; });
  const inputs = [...form.querySelectorAll('input')];
  (inputs.find((i) => !i.value) || inputs[0])?.focus();
}

function showError(msg) {
  const el = $('#authError');
  el.textContent = msg;
  el.hidden = !msg;
}

function setNotice(msg) {
  const el = $('#authNotice');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function busy(form, on) {
  const btn = form.querySelector('.auth-submit');
  btn.disabled = on;
  btn.dataset.label ||= btn.textContent;
  btn.textContent = on ? 'Please wait…' : btn.dataset.label;
}

/** Client-side checks mirror the server so users get instant feedback. */
function validate(form) {
  for (const input of form.querySelectorAll('input[required]')) {
    if (!input.value.trim()) { input.focus(); return `Please fill in ${input.labels?.[0]?.textContent.replace(/\(.*\)/, '').trim() || 'all fields'}.`; }
    if (input.type === 'email' && !input.checkValidity()) { input.focus(); return 'Please enter a valid e-mail address.'; }
    if (input.minLength > 0 && input.value.length < input.minLength) { input.focus(); return `Password must be at least ${input.minLength} characters.`; }
  }
  return '';
}

let wired = false;
let resolveUser = null;

function wire() {
  if (wired) return;
  wired = true;

  $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.authTab)));
  $$('.pw-toggle').forEach((b) => b.addEventListener('click', () => {
    const input = b.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));

  const handle = (form, action) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const problem = validate(form);
    if (problem) { showError(problem); return; }
    showError('');
    busy(form, true);
    try {
      const user = await action(Object.fromEntries(new FormData(form)));
      form.reset();
      resolveUser?.(user);
    } catch (err) {
      showError(err.message || 'Something went wrong. Please try again.');
    } finally {
      busy(form, false);
    }
  });

  handle($('#loginForm'), async ({ email, password }) => (await api.login(email, password)).user);

  handle($('#registerForm'), async ({ name, email, password, password2 }) => {
    if (password !== password2) { $('#regPassword2').focus(); throw new Error('The two passwords do not match.'); }
    const r = await api.register(email, password, name);
    await showRecoveryCode(r.recoveryCode, r.user.email);
    return r.user;
  });

  handle($('#resetForm'), async ({ email, code, password }) => {
    const r = await api.resetWithRecovery(email, code, password);
    await showRecoveryCode(r.recoveryCode, r.user.email); // the old code is now invalid
    return r.user;
  });
}

/**
 * Shows the auth screen. `notice` explains why (offline, not configured…);
 * `disabled` blocks the forms when accounts cannot work on this host.
 */
export function showAuth({ notice = '', disabled = false } = {}) {
  wire();
  document.body.classList.add('locked');
  screen().dataset.state = 'ready';
  setNotice(notice);
  $$('.auth-form button, .auth-form input, .auth-tab').forEach((el) => { el.disabled = disabled; });
  setPanel('login');
  return new Promise((resolve) => { resolveUser = resolve; });
}

/** Hides the auth screen and reveals the app. */
export function hideAuth() {
  resolveUser = null;
  document.body.classList.remove('locked');
}
