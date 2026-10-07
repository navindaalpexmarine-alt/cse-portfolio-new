/**
 * Live price refresh: pulls the CSE trade summary, updates holdings,
 * records a daily value snapshot and raises SELL / NEAR alerts.
 * Auto-refresh pauses when the tab is hidden and (optionally) outside CSE hours.
 */
import { cse } from './api.js';
import { commit, state } from './store.js';
import { computeRow } from './finance.js';
import { setMarketList, populateSymbolSelects } from './symbols.js';
import { toast, setBusy } from './ui.js';
import { $, isMarketHours, timeHM } from './utils.js';
import { loadMarketOverview } from '../views/market.js';

let refreshing = false;
let timer = null;

export function setPriceStatus(msg, cls = '') {
  const t = $('#statusText');
  const d = $('#statusDot');
  if (t) t.textContent = msg;
  if (d) d.className = 'status-dot' + (cls ? ' ' + cls : '');
}

/** Applies live prices to holdings. Returns how many holdings matched. */
function applyPrices(list) {
  setMarketList(list);
  let n = 0;
  for (const h of state.holdings) {
    const info = state.priceMap[(h.name || '').toUpperCase().trim()];
    if (info?.price != null && !Number.isNaN(Number(info.price))) {
      h.tradedPrice = Number(info.price);
      n++;
    }
  }
  return n;
}

/** One snapshot per day (the last refresh of the day wins). Keeps a year. */
function recordValueSnapshot() {
  if (!state.holdings.length) return;
  let mv = 0, cost = 0;
  state.holdings.forEach((h) => { mv += computeRow(h, state.commissionRate).marketValue; cost += h.totalCost || 0; });
  const day = new Date().toISOString().slice(0, 10);
  const last = state.valueSnaps[state.valueSnaps.length - 1];
  if (last && last.day === day) Object.assign(last, { mv, cost, ts: Date.now() });
  else state.valueSnaps.push({ day, mv, cost, ts: Date.now() });
  if (state.valueSnaps.length > 365) state.valueSnaps = state.valueSnaps.slice(-365);
}

/** Toast + optional browser notification when a holding newly reaches SELL/NEAR. */
function checkPriceAlerts() {
  const msgs = [];
  for (const h of state.holdings) {
    const { status } = computeRow(h, state.commissionRate);
    const name = h.name || '';
    if ((status === 'sell' || status === 'near') && !state.alertSeen[`${name}:${status}`]) {
      msgs.push(status === 'sell' ? `${name} → SELL (market ≥ B.E.S)` : `${name} → NEAR B.E.S`);
      state.alertSeen[`${name}:${status}`] = Date.now();
    }
    if (status === 'hold') {
      delete state.alertSeen[`${name}:sell`];
      delete state.alertSeen[`${name}:near`];
    }
  }
  if (!msgs.length) return;
  toast(msgs.slice(0, 3).join(' · '), { ms: 5000 });
  try {
    if (state.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('CSE Portfolio', { body: msgs.join('\n'), icon: 'assets/icons/icon-192.png', tag: 'cse-signal' });
    }
  } catch { /* some mobile browsers only allow notifications from a service worker */ }
}

export async function refreshPrices({ silent = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  const btn = $('#refreshBtn');
  setBusy(btn, true);
  setPriceStatus('Loading…', 'load');
  loadMarketOverview(); // header ticker, in parallel
  try {
    const data = await cse('tradeSummary');
    const list = data.reqTradeSummery || data || [];
    if (!Array.isArray(list) || !list.length) throw new Error('Empty price list');
    const n = applyPrices(list);
    recordValueSnapshot();
    checkPriceAlerts();
    populateSymbolSelects();
    setPriceStatus(`${n}/${state.holdings.length} · ${timeHM()}`, 'ok');
    commit('prices');
    if (n && !silent) toast('Prices updated ✓');
  } catch (err) {
    setPriceStatus('Manual OK', 'err');
    if (!silent) toast(`Live prices unavailable — Market Price manual type කරන්න (${err.message})`, { error: true, ms: 4000 });
  } finally {
    refreshing = false;
    setBusy(btn, false);
  }
}

/** (Re)arms the auto-refresh timer from current settings. */
export function startAutoRefresh() {
  clearInterval(timer);
  const sec = Number(state.settings.refreshSec) || 0;
  if (sec <= 0) return;
  timer = setInterval(() => {
    if (document.hidden) return;
    if (state.settings.marketHoursOnly && !isMarketHours()) return;
    refreshPrices({ silent: true });
  }, Math.max(30, sec) * 1000);
}
