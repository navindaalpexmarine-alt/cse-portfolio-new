/**
 * Hash router for the tabbed sections (#portfolio, #news, ...).
 * - Back/forward buttons and bookmarks work.
 * - WAI-ARIA tabs pattern: roving tabindex + arrow/Home/End keys.
 * - Views render lazily, only when shown.
 */
import { $, $$ } from './utils.js';

const views = new Map();   // id -> { init?, render?, show?(params), hide? }
const inited = new Set();
let currentId = null;
let pendingParams = null;
let defaultId = 'portfolio';

export const register = (id, view) => views.set(id, view);
export const current = () => currentId;
export const viewIds = () => [...views.keys()];

function idFromHash() {
  const id = decodeURIComponent(location.hash.replace(/^#\/?/, '').split(/[?&]/)[0]);
  return views.has(id) ? id : defaultId;
}

function activate(id, params = null) {
  const prev = currentId;
  currentId = id;

  $$('#tabs [role="tab"]').forEach((tab) => {
    const on = tab.dataset.view === id;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    if (on) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  $$('main .view').forEach((panel) => { panel.hidden = panel.id !== `view-${id}`; });

  if (prev && prev !== id) views.get(prev)?.hide?.();
  const view = views.get(id);
  if (!inited.has(id)) { inited.add(id); view.init?.(); }
  if (view.show) view.show(params);
  else view.render?.();

  document.title = `${$(`#tab-${id}`)?.textContent.trim() || 'CSE'} · CSE Portfolio`;
}

/** Navigate to a section, optionally passing params (e.g. { sym: 'SAMP.N0000' }). */
export function go(id, params = null) {
  if (!views.has(id)) return;
  if (id === currentId) { activate(id, params); return; }
  pendingParams = params;
  location.hash = id;
}

/** Re-render the visible view (called when data changes). */
export function refreshCurrent(topic) {
  const view = views.get(currentId);
  if (!view) return;
  if (view.onData) view.onData(topic);
  else view.render?.();
}

export function startRouter(fallback = 'portfolio') {
  defaultId = fallback;

  window.addEventListener('hashchange', () => {
    const params = pendingParams;
    pendingParams = null;
    activate(idFromHash(), params);
  });

  const tablist = $('#tabs');
  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) go(tab.dataset.view);
  });
  tablist.addEventListener('keydown', (e) => {
    const tabs = $$('[role="tab"]', tablist);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
      go(next.dataset.view);
    }
  });

  activate(idFromHash());
}
