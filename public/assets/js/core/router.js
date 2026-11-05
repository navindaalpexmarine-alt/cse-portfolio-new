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

/** Scrolls the tab strip so the open tab sits in the middle (never moves the page). */
function centerTab(tab) {
  const strip = tab.parentElement;
  if (!strip || strip.scrollWidth <= strip.clientWidth) return;
  const left = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2;
  strip.scrollTo({ left: Math.max(0, left), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** Fades the strip's edges while more tabs are hidden that way (a hint to swipe). */
function updateFades() {
  const strip = $('#tabs');
  const wrap = strip?.parentElement;
  if (!wrap) return;
  const max = strip.scrollWidth - strip.clientWidth;
  wrap.classList.toggle('more-left', strip.scrollLeft > 4);
  wrap.classList.toggle('more-right', strip.scrollLeft < max - 4);
}

/** Phone bottom bar + "All sections" sheet (built from the top tabs, so they never drift apart). */
function initBottomNav() {
  const bar = $('#bottomNav');
  const sheet = $('#moreSheet');
  const grid = $('#moreGrid');
  if (!bar || !sheet || !grid) return;
  grid.innerHTML = $$('#tabs [role="tab"]').map((t) =>
    `<button type="button" class="sheet-item" data-view="${t.dataset.view}">${t.innerHTML}</button>`).join('');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'moreBtn') { sheet.showModal(); return; }
    go(b.dataset.view);
    window.scrollTo({ top: 0 });
  });
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    sheet.close();
    go(b.dataset.view);
    window.scrollTo({ top: 0 });
  });
  $('#moreClose')?.addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); }); // tap outside
}

function activate(id, params = null) {
  const prev = currentId;
  currentId = id;

  $$('#tabs [role="tab"]').forEach((tab) => {
    const on = tab.dataset.view === id;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    if (on) centerTab(tab);
  });
  // Phone bottom bar + "More" sheet: mark the open section
  const inBar = $$('#bottomNav [data-view]').some((b) => b.dataset.view === id);
  $$('#bottomNav [data-view], #moreGrid [data-view]').forEach((b) => {
    if (b.dataset.view === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#moreBtn')?.classList.toggle('on', !inBar);
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
  initBottomNav();
  tablist.addEventListener('scroll', updateFades, { passive: true });
  window.addEventListener('resize', updateFades);
  requestAnimationFrame(updateFades);
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
