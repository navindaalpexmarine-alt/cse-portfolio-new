/**
 * CSE Portfolio – application entry point.
 *
 * Start-up: theme -> check the session (sign-in screen if needed) -> download
 * the user's portfolio from their account -> boot the app (router, live
 * prices, auto-refresh). Also wired here: keyboard shortcuts, multi-tab and
 * multi-device sync, offline notices, service worker.
 */
import { state, load, commit, onChange, reloadFromStorage, KEYS, ACCOUNT_KEYS, writeRaw } from './core/store.js';
import * as account from './core/account.js';
import * as sync from './core/sync.js';
import { showAuth, hideAuth } from './views/auth.js';
import { register, startRouter, refreshCurrent, current, go, viewIds } from './core/router.js';
import { refreshPrices, startAutoRefresh } from './core/prices.js';
import { applyChartTheme } from './core/loader.js';
import { $, num } from './core/utils.js';
import { toast } from './core/ui.js';
import { initSettings } from './views/settings.js';

import portfolio from './views/portfolio.js';
import calculator from './views/calculator.js';
import dividends from './views/dividends.js';
import charts from './views/charts.js';
import history from './views/history.js';
import news from './views/news.js';
import fundamentals from './views/fundamentals.js';
import technical from './views/technical.js';

/* ---------- views ---------- */
register('portfolio', portfolio);
register('calc', calculator);
register('div', dividends);
register('charts', charts);
register('history', history);
register('news', news);
register('fund', fundamentals);
register('tech', technical);

/* ---------- theme ---------- */
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  writeRaw(KEYS.theme, theme);
  const btn = $('#themeBtn');
  btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  btn.querySelector('use').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0B0F14' : '#F6F4EE');
  applyChartTheme();
  if (current() === 'tech') technical.onTheme();
  else refreshCurrent('theme');
}
const toggleTheme = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

/* ---------- live-data banner ---------- */
function updateLiveBanner() {
  const down = state.live === 'down';
  $('#liveBanner').hidden = !down;
}

/* ---------- keyboard shortcuts ---------- */
function isTyping(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
function onKey(e) {
  if (document.body.classList.contains('locked')) return;
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (isTyping(document.activeElement)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  const ids = viewIds();
  if (/^[1-8]$/.test(e.key)) { go(ids[Number(e.key) - 1]); e.preventDefault(); return; }
  switch (e.key) {
    case 'r': case 'R': refreshPrices(); break;
    case 't': case 'T': toggleTheme(); break;
    case '?': $('#helpDialog').showModal(); break;
    case '/': {
      const box = document.querySelector('main .view:not([hidden]) [data-search]');
      if (box) { e.preventDefault(); box.focus(); box.select?.(); }
      break;
    }
    default: return;
  }
}

/* ---------- sign-in ---------- */

/** Resolves with the signed-in user, showing the sign-in screen when needed. */
async function authenticate() {
  let notice = '';
  let disabled = false;
  try {
    const { user } = await account.me();
    if (user) return await prepare(user);
  } catch (err) {
    if (err.code === 'offline') {
      const cached = sync.cachedAccount();
      if (cached) {
        await sync.startSession(cached, { offline: true });
        toast('Offline — showing the copy saved on this device', { ms: 4000 });
        return cached;
      }
      notice = 'You are offline. Connect to the internet to sign in.';
    } else if (err.code === 'db_not_configured') {
      notice = 'Accounts are not set up on this site yet. (Site owner: connect "Upstash for Redis" in Vercel → Storage, then redeploy.)';
      disabled = true;
    } else if (err.code === 'unavailable') {
      notice = 'The account service is not running here. Start the site with "npm run dev", or open the deployed Vercel site.';
      disabled = true;
    } else if (err.status !== 401) {
      notice = err.message;
    }
  }
  const user = await showAuth({ notice, disabled });
  return prepare(user);
}

/** Downloads (or imports) the user's portfolio before the app renders. */
async function prepare(user) {
  try {
    await sync.startSession(user);
  } catch (err) {
    console.warn('initial sync failed', err);
    await sync.startSession(user, { offline: true });
    toast('Could not reach your account — using the copy on this device for now', { error: true, ms: 5000 });
  }
  return user;
}

function showAccount(user) {
  const label = (user.name || user.email || '?').trim();
  $('#accountInitial').textContent = label.charAt(0).toUpperCase();
  $('#accountBtn').setAttribute('aria-label', `Account: ${user.email}`);
}

/* ---------- boot ---------- */
function boot(user) {
  hideAuth();
  showAccount(user);
  load();
  $('#commissionRate').value = state.commissionRate;

  onChange((topic) => {
    if (topic === 'live') { updateLiveBanner(); return; }
    if (topic === 'all') {
      $('#commissionRate').value = state.commissionRate;
      updateLiveBanner();
    }
    refreshCurrent(topic);
  });

  $('#commissionRate').addEventListener('change', (e) => {
    const v = num(e.target.value, NaN);
    if (!(v >= 0 && v < 50)) { e.target.value = state.commissionRate; toast('Commission must be between 0 and 50%', { error: true }); return; }
    state.commissionRate = v;
    commit('rate');
  });
  $('#refreshBtn').addEventListener('click', () => refreshPrices());
  $('#bannerRetryBtn').addEventListener('click', () => refreshPrices());
  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
  document.addEventListener('keydown', onKey);
  initSettings();

  // Another tab saved changes -> reload so tabs never overwrite each other.
  // Another tab signed out / switched account -> restart this one too.
  window.addEventListener('storage', (e) => {
    if (e.key === KEYS.theme && e.newValue) setTheme(e.newValue);
    else if (e.key === ACCOUNT_KEYS.account || (e.key === null)) location.reload();
    else if (e.key && Object.values(KEYS).includes(e.key)) reloadFromStorage();
  });

  window.addEventListener('online', () => { toast('Back online'); refreshPrices({ silent: true }); });
  window.addEventListener('offline', () => toast('You are offline — showing saved data', { error: true }));

  // Coming back to the tab after a while: refresh once.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); sync.flush(); return; }
    sync.pull(); // changes made on another device
    const sec = Number(state.settings.refreshSec) || 0;
    if (sec && hiddenAt && Date.now() - hiddenAt > sec * 1000) refreshPrices({ silent: true });
  });

  window.addEventListener('pagehide', () => sync.flush());

  startRouter('portfolio');
  refreshPrices({ silent: true });
  startAutoRefresh();
}

async function start() {
  setTheme(document.documentElement.dataset.theme || 'dark');
  $('#themeBtn').addEventListener('click', toggleTheme);

  // Offline support + installable app (PWA). Not available on file:// or plain http (except localhost).
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }

  boot(await authenticate());
}

start();
