/**
 * Small, dependency-free helpers shared by every module.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- number formatting ---------- */
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const isNum = (n) => n != null && n !== '' && !Number.isNaN(Number(n));

/** 1234.5 -> "1,234.50" (invalid -> "0.00", like the original) */
export const fmt = (n) => (isNum(n) ? nf2.format(Number(n)) : '0.00');
/** Same as fmt but shows "—" for missing values (used for live data). */
export const fmtOr = (n, dash = '—') => (isNum(n) && Number(n) !== 0 ? nf2.format(Number(n)) : dash);
export const fmtInt = (n, dash = '—') => (isNum(n) ? nf0.format(Number(n)) : dash);
export const fmtPct = (n) => (isNum(n) ? Number(n).toFixed(2) + '%' : '0.00%');
export const signed = (n, f = fmt) => (Number(n) >= 0 ? '+' : '') + f(n);
/** Rupees in millions/billions for big figures. */
export function fmtCompact(n) {
  if (!isNum(n)) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1e9) return 'Rs ' + (v / 1e9).toFixed(2) + ' Bn';
  if (Math.abs(v) >= 1e6) return 'Rs ' + (v / 1e6).toFixed(2) + ' Mn';
  return 'Rs ' + nf2.format(v);
}
export const num = (v, def = 0) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : def;
};
export const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- safety ---------- */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escape any value for text or attribute context. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Only allow http(s) links from external data (blocks javascript: URLs in feeds). */
export function safeUrl(u, fallback = '#') {
  try {
    const url = new URL(String(u || ''), location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : fallback;
  } catch {
    return fallback;
  }
}

/* ---------- dates ---------- */
export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export function fmtDate(when, withTime = false) {
  if (!when) return '—';
  const d = typeof when === 'number' ? new Date(when) : new Date(String(when));
  if (Number.isNaN(d.getTime())) return String(when);
  const opts = { day: '2-digit', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('en-GB', opts);
}
export const timeHM = (d = new Date()) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Is the CSE in its regular session right now? (Mon–Fri 09:30–14:30 Asia/Colombo).
 *  Public holidays are not known here – a refresh on a holiday just returns the last prices. */
export function isMarketHours(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  if (['Sat', 'Sun'].includes(get('weekday'))) return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return mins >= 9 * 60 + 25 && mins <= 14 * 60 + 35; // small buffer either side
}

/* ---------- misc ---------- */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Triggers a client-side file download. */
export function download(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV cell quoting (RFC 4180) + formula-injection guard for Excel. */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/** Reads a CSS custom property from :root (used to theme charts). */
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
