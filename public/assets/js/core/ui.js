/**
 * Shared UI primitives: toast, accessible dialogs (replacing alert/confirm),
 * busy buttons, and focus-preserving re-rendering for editable tables.
 */
import { $, esc } from './utils.js';

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, { error = false, ms = 2600 } = {}) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------- dialogs ---------- */
/**
 * Generic choice dialog. Resolves with the chosen value, or null on Esc/backdrop.
 *   choices: [{ value, label, kind: 'primary' | 'ghost' | 'danger' }]
 */
export function choose({ title, message = '', choices }) {
  const dlg = $('#promptDialog');
  $('#promptTitle', dlg).textContent = title;
  $('#promptMsg', dlg).textContent = message;
  $('#promptActions', dlg).innerHTML = choices.map((c) =>
    `<button class="btn ${c.kind === 'primary' ? 'primary' : c.kind === 'danger' ? 'ghost danger' : 'ghost'}" value="${esc(c.value)}">${esc(c.label)}</button>`,
  ).join('');
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue || null), { once: true });
    dlg.showModal();
    // Focus the primary action (or the first button) for keyboard users.
    const primary = dlg.querySelector('.dialog-actions .btn.primary') || dlg.querySelector('.dialog-actions .btn');
    primary?.focus();
  });
}

/** Yes/no confirmation. Resolves true/false. */
export async function confirmDialog(title, message = '', { confirmLabel = 'OK', danger = false } = {}) {
  const v = await choose({
    title,
    message,
    choices: [
      { value: 'cancel', label: 'Cancel', kind: 'ghost' },
      { value: 'ok', label: confirmLabel, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === 'ok';
}

/** Informational message (replaces alert()). */
export function alertDialog(title, message = '') {
  return choose({ title, message, choices: [{ value: 'ok', label: 'OK', kind: 'primary' }] });
}

/**
 * Small form dialog. Resolves with { name: value } or null when cancelled.
 *   fields: [{ name, label, type = 'password', autocomplete, minlength }]
 */
export function promptForm({ title, message = '', fields, submitLabel = 'OK', danger = false }) {
  const dlg = $('#formDialog');
  $('#formTitle', dlg).textContent = title;
  $('#formMsg', dlg).textContent = message;
  $('#formFields', dlg).innerHTML = fields.map((f, i) => `
    <div class="field"><label for="ff${i}">${esc(f.label)}</label>
      <input id="ff${i}" name="${esc(f.name)}" type="${esc(f.type || 'password')}" class="search" required
        ${f.minlength ? `minlength="${f.minlength}"` : ''} autocomplete="${esc(f.autocomplete || 'off')}"></div>`).join('');
  const submit = $('#formSubmit', dlg);
  submit.textContent = submitLabel;
  submit.className = `btn ${danger ? 'ghost danger' : 'primary'}`;
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(fields.map((f) => [f.name, dlg.querySelector(`[name="${f.name}"]`).value])));
    }, { once: true });
    dlg.showModal();
    dlg.querySelector('input')?.focus();
  });
}

/** Shows a new recovery code and only lets the user continue once they confirm they saved it. */
export function showRecoveryCode(code, email = '') {
  const dlg = $('#recoveryDialog');
  const box = $('#recoverySaved', dlg);
  const cont = $('#recoveryContinueBtn', dlg);
  $('#recoveryCode', dlg).textContent = code;
  box.checked = false;
  cont.disabled = true;
  box.onchange = () => { cont.disabled = !box.checked; };
  $('#recoveryCopyBtn', dlg).onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast('Recovery code copied'); } catch { toast('Copy failed — select the code and copy it manually', { error: true }); }
  };
  $('#recoveryDownloadBtn', dlg).onclick = () => {
    const text = `CSE Portfolio — account recovery code\r\n\r\nAccount: ${email}\r\nRecovery code: ${code}\r\nCreated: ${new Date().toLocaleString()}\r\n\r\nUse this code on the sign-in page ("Forgot password?") to set a new password.\r\nKeep it private. A new code replaces this one.\r\n`;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'cse-portfolio-recovery-code.txt' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // Esc must not dismiss it before the user confirmed.
  const block = (e) => { if (!box.checked) e.preventDefault(); };
  dlg.addEventListener('cancel', block);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { dlg.removeEventListener('cancel', block); resolve(); }, { once: true });
    dlg.showModal();
  });
}

// Close any dialog when its backdrop is clicked (except the recovery code dialog).
document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLDialogElement && e.target.open && e.target.id !== 'recoveryDialog') {
    const r = e.target.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) e.target.close();
  }
});

/* ---------- busy state ---------- */
export function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = !!busy;
  btn.classList.toggle('is-loading', !!busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * Re-renders `container.innerHTML` without losing the user's place:
 * if an input inside it (identified by `data-key`) is focused, the same input
 * is re-focused afterwards with any uncommitted text and caret restored.
 * This lets auto price refreshes and Tab-navigation edits coexist.
 */
export function renderPreservingFocus(container, html) {
  const active = document.activeElement;
  let saved = null;
  if (active && container.contains(active) && active.dataset?.key) {
    saved = { key: active.dataset.key, value: active.value, start: active.selectionStart, end: active.selectionEnd };
  }
  container.innerHTML = html;
  if (!saved) return;
  const el = container.querySelector(`[data-key="${CSS.escape(saved.key)}"]`);
  if (!el) return;
  el.value = saved.value;
  el.focus({ preventScroll: true });
  try { el.setSelectionRange(saved.start, saved.end); } catch { /* number inputs */ }
}

/** Builds an empty-state block. */
export const emptyHtml = (html, small = false) => `<div class="empty${small ? ' sm' : ''}">${html}</div>`;
