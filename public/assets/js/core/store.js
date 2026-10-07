/**
 * Application state + local persistence + change notifications.
 *
 * The signed-in user's portfolio lives on the server (see sync.js); this
 * module keeps a local copy in localStorage so the app opens instantly and
 * works offline. Every local save notifies sync.js, which uploads it.
 *
 * Storage keys are IDENTICAL to the original single-file app, so data saved
 * by the old version can be imported into an account on first sign-in.
 */
import { sanitizeHolding } from './finance.js';
import { $ } from './utils.js';

export const KEYS = {
  holdings: 'cse_portfolio_v4',
  rate: 'cse_commission_v4',
  divEvents: 'cse_div_events_v1',
  transactions: 'cse_tx_v1',
  valueSnaps: 'cse_value_snap_v1',
  alertSeen: 'cse_alert_seen_v1',
  settings: 'cse_settings_v1',
  theme: 'cse_theme',
};

/** Keys owned by the account/sync layer (who is signed in, last synced version). */
export const ACCOUNT_KEYS = {
  account: 'cse_account_v1',
  syncMeta: 'cse_sync_meta_v1',
};

export const DEFAULT_RATE = 1.12;
export const DEFAULT_SETTINGS = Object.freeze({
  refreshSec: 120,      // auto price refresh interval; 0 = off
  marketHoursOnly: true,
  notify: false,
});

/** Single source of truth. Persisted fields + runtime-only caches. */
export const state = {
  holdings: [],
  divEvents: [],
  transactions: [],
  valueSnaps: [],
  alertSeen: {},
  commissionRate: DEFAULT_RATE,
  settings: { ...DEFAULT_SETTINGS },
  // runtime only (never persisted)
  priceMap: {},     // SYMBOL -> { price, change, changePct, name, id }
  market: [],       // full CSE list [{symbol, name, id, price}]
  newsCache: [],
  live: 'unknown',  // 'ok' | 'down' | 'unknown'
};

/* ---------- low-level storage (never throws) ---------- */
function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
export function readRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writeRaw(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

/* ---------- sanitisers ---------- */
const arr = (v) => (Array.isArray(v) ? v : []);
const sanitizeEvent = (e = {}) => ({
  symbol: String(e.symbol || '').toUpperCase().slice(0, 24),
  dps: Number(e.dps) || 0,
  type: String(e.type || 'Final').slice(0, 20),
  xd: String(e.xd || '').slice(0, 20),
  pay: String(e.pay || '').slice(0, 20),
  status: e.status === 'Paid' ? 'Paid' : 'Announced',
});
const sanitizeTx = (t = {}) => ({
  type: t.type === 'sell' ? 'sell' : 'buy',
  symbol: String(t.symbol || '').toUpperCase().slice(0, 24),
  qty: Number(t.qty) || 0,
  price: Number(t.price) || 0,
  gross: Number(t.gross) || 0,
  fee: Number(t.fee) || 0,
  net: Number(t.net) || 0,
  realized: Number(t.realized) || 0,
  date: String(t.date || '').slice(0, 10),
  note: String(t.note || '').slice(0, 200),
  ts: Number(t.ts) || Date.now(),
});
const sanitizeSnap = (s = {}) => ({ day: String(s.day || '').slice(0, 10), mv: Number(s.mv) || 0, cost: Number(s.cost) || 0, ts: Number(s.ts) || 0 });

function applyData(d) {
  state.holdings = arr(d.holdings).map(sanitizeHolding);
  state.divEvents = arr(d.divEvents).map(sanitizeEvent);
  state.transactions = arr(d.transactions).map(sanitizeTx);
  state.valueSnaps = arr(d.valueSnaps).map(sanitizeSnap).filter((s) => s.day).slice(-365);
  state.alertSeen = d.alertSeen && typeof d.alertSeen === 'object' ? d.alertSeen : {};
  const r = parseFloat(d.commissionRate);
  state.commissionRate = Number.isFinite(r) && r >= 0 && r < 50 ? r : DEFAULT_RATE;
  const saved = d.settings && typeof d.settings === 'object' ? d.settings : {};
  state.settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, saved[k] ?? DEFAULT_SETTINGS[k]]));
}

/** Loads the local copy from localStorage (new accounts start empty). */
export function load() {
  applyData({
    holdings: read(KEYS.holdings, []),
    divEvents: read(KEYS.divEvents, []),
    transactions: read(KEYS.transactions, []),
    valueSnaps: read(KEYS.valueSnaps, []),
    alertSeen: read(KEYS.alertSeen, {}),
    commissionRate: read(KEYS.rate, DEFAULT_RATE),
    settings: read(KEYS.settings, {}),
  });
}

/* ---------- saving (debounced, with visible status) ---------- */
let saveTimer = null;
let afterSave = null;
/** sync.js registers here to upload every local save to the account. */
export const setAfterSave = (fn) => { afterSave = fn; };

export function setSaveStatus(text, saving) {
  const el = $('#saveStatus');
  if (el) el.textContent = text;
  el?.parentElement?.classList.toggle('saving', !!saving);
}
export function saveNow({ sync = true } = {}) {
  clearTimeout(saveTimer);
  try {
    write(KEYS.holdings, state.holdings);
    write(KEYS.rate, state.commissionRate);
    write(KEYS.divEvents, state.divEvents);
    write(KEYS.transactions, state.transactions);
    write(KEYS.valueSnaps, state.valueSnaps);
    write(KEYS.alertSeen, state.alertSeen);
    write(KEYS.settings, state.settings);
    setSaveStatus('Saved', false);
    if (sync) afterSave?.();
    return true;
  } catch (err) {
    console.error('save failed', err);
    setSaveStatus('Save failed — storage full or blocked', false);
    return false;
  }
}
export function save() {
  setSaveStatus('Saving…', true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}

/* ---------- change bus ---------- */
const bus = new EventTarget();
/** Notify listeners that `topic` changed (no save). */
export function emit(topic = 'data') {
  bus.dispatchEvent(new CustomEvent('change', { detail: topic }));
}
export function onChange(fn) {
  bus.addEventListener('change', (e) => fn(e.detail));
}
/** Save + notify. Call after any user-data mutation. */
export function commit(topic = 'data') {
  save();
  emit(topic);
}

/* ---------- whole-portfolio snapshots (sync + backup) ---------- */

/** Everything that belongs to the user's portfolio, as one plain object. */
export function snapshotData() {
  return {
    holdings: state.holdings,
    commissionRate: state.commissionRate,
    divEvents: state.divEvents,
    transactions: state.transactions,
    valueSnaps: state.valueSnaps,
    alertSeen: state.alertSeen,
    settings: state.settings,
  };
}

/** Replaces the local copy with `data` (e.g. downloaded from the account). */
export function replaceData(data, { sync = false, notify = true } = {}) {
  applyData(data || {});
  saveNow({ sync });
  if (notify) emit('all');
}

/** Portfolio data in this browser that was saved without an account (old version). */
export function hasLegacyLocalData() {
  if (readRaw(ACCOUNT_KEYS.account)) return false;
  const h = read(KEYS.holdings, []);
  const tx = read(KEYS.transactions, []);
  return (Array.isArray(h) && h.length > 0) || (Array.isArray(tx) && tx.length > 0);
}

/** Removes the local copy and account markers (on sign-out / account switch). Theme is kept. */
export function clearLocalData() {
  [...Object.entries(KEYS).filter(([k]) => k !== 'theme').map(([, v]) => v), ...Object.values(ACCOUNT_KEYS)]
    .forEach((key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } });
  applyData({});
}

/* ---------- backup / restore ---------- */
export function exportBackup() {
  const { alertSeen, ...data } = snapshotData();
  return { app: 'cse-portfolio', version: 1, exportedAt: new Date().toISOString(), data };
}

/** Validates + applies a backup object. Throws with a readable message. */
export function importBackup(obj) {
  if (!obj || obj.app !== 'cse-portfolio' || !obj.data || typeof obj.data !== 'object') {
    throw new Error('This file is not a CSE Portfolio backup.');
  }
  if (!Array.isArray(obj.data.holdings)) throw new Error('Backup has no holdings list.');
  applyData({ ...obj.data, alertSeen: {} });
  saveNow();
  emit('all');
}

/** Empties the portfolio (locally and, via sync, in the account). Settings and theme are kept. */
export function resetAll() {
  applyData({ holdings: [], settings: state.settings });
  saveNow();
  emit('all');
}

/** Re-reads storage after another tab changed it (multi-tab sync). */
export function reloadFromStorage() {
  load();
  emit('all');
}
