/**
 * Dividends view — merged & hardened edition.
 *
 *  • Symbol research (profile → seasonality fallback → history link)
 *  • Seasonality heat map + month list (shows how many of YOUR holdings pay each month)
 *  • Live dividend feed:
 *      1) structured CSE `cashDividends` (DPS, XD, record, payment dates)
 *      2) fallback: CSE `approvedAnnouncement` + amount enrichment from news
 *      3) dividend-related news items
 *    → merged, de-duplicated, upcoming XD first, "your income" per row, one-click log to Event log
 *  • Per-holding setup (Avg DPS, typical month, YoC) + smart auto-fill from DIV_PROFILE
 *  • 12-month forecast: confirmed (from Event log) + estimates (split across interim/final months)
 *  • Dividend event log
 */
import { commit, state } from '../core/store.js';
import { DIV_PROFILE, MONTHS, SEASON } from '../data/reference.js';
import { baseSym } from '../core/finance.js';
import { $, esc, fmt, fmtDate, fmtPct, num, safeUrl } from '../core/utils.js';
import { emptyHtml, renderPreservingFocus, setBusy, toast, confirmDialog } from '../core/ui.js';
import { cse, news } from '../core/api.js';
import { loadNews } from './news.js';

/* ======================================================================
 * Constants & small helpers
 * ==================================================================== */

const LIVE_TTL = 5 * 60 * 1000;          // re-fetch CSE data at most every 5 min
const LIVE_RETRY_EMPTY = 30 * 1000;      // …but retry after 30 s if the last fetch came back empty
const LIVE_LIMIT = 30;
const DAY = 86400000;

const STRENGTH_ORDER = { high: 0, med: 1, low: 2 };
const STRENGTH_SCORE = { high: 3, med: 2, low: 1 };
const strengthPill = (s) => (s === 'high' ? 'sell' : s === 'med' ? 'near' : 'neutral');
const strengthColor = (s) => (s === 'high' ? 'var(--pos)' : s === 'med' ? 'var(--warn)' : 'var(--muted)');

const HISTORY_HOME = 'https://stockdividends.iamsupun.com/stocks/';
const historyUrl = (sym) => `${HISTORY_HOME}${encodeURIComponent(sym)}/`;
const CSE_DIV_URL = 'https://www.cse.lk/announcements/?category=CASH+DIVIDEND';
const DIV_NEWS_RE = /dividend|xd date|x-div|ලාභාංශ/i;

let selectedMonth = new Date().getMonth() + 1;

/** "jkh.n0000" → "JKH" (only strips the suffix at the end, not in the middle). */
const cleanSym = (raw) => String(raw || '').trim().toUpperCase().replace(/\.(?:N|X)(?:0000)?$/, '');
const validMonth = (m) => Number.isInteger(m) && m >= 1 && m <= 12;
const nonNeg = (v) => Math.max(0, num(v, 0) || 0);
/** Positive number from a messy value ("2.50", 2.5) or null. */
const posNum = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Accepts ISO strings, "05 Nov 2026", epoch seconds/ms (number or digit string). */
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  let d;
  if (/^\d{10}$/.test(s)) d = new Date(Number(s) * 1000);
  else if (/^\d{13}$/.test(s)) d = new Date(Number(s));
  else d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const showDate = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : String(v || '');
};
const isoDate = (v) => {
  const d = toDate(v);
  if (!d) return String(v || '').trim().slice(0, 20);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthIdx = (y, m) => y * 12 + m;

/**
 * Holdings keyed by base symbol. Multiple lots of the same symbol are summed,
 * so "JKH" and "JKH.N0000" rows don't get counted separately in lookups.
 */
function holdingsMap() {
  const map = new Map();
  for (const h of state.holdings) {
    const k = baseSym(h.name || '');
    if (!k) continue;
    const prev = map.get(k);
    map.set(k, prev ? { ...prev, balance: nonNeg(prev.balance) + nonNeg(h.balance) } : { ...h });
  }
  return map;
}

/* ======================================================================
 * Research
 * ==================================================================== */

function findProfile(q) {
  if (DIV_PROFILE[q]) return { key: q, prof: DIV_PROFILE[q] };

  const hits = Object.entries(DIV_PROFILE).filter(([k, v]) => k.includes(q) || (v.name || '').toUpperCase().includes(q));
  if (hits.length === 1) return { key: hits[0][0], prof: hits[0][1] };
  if (hits.length > 1) {
    // Prefer an exact prefix match on the symbol before asking the user to choose.
    const prefix = hits.filter(([k]) => k.startsWith(q));
    if (prefix.length === 1) return { key: prefix[0][0], prof: prefix[0][1] };
    return { many: hits.map(([k]) => k) };
  }

  // Fallback: build a profile from the seasonality table.
  const found = [];
  for (let m = 1; m <= 12; m++) {
    (SEASON[m] || []).forEach((r) => { if (r[0] === q) found.push({ m, name: r[1], note: r[2], str: r[3] }); });
  }
  if (!found.length) return {};
  const best = [...found].sort((a, b) => STRENGTH_ORDER[a.str] - STRENGTH_ORDER[b.str])[0];
  return {
    key: q,
    prof: {
      name: found[0].name,
      months: [...new Set(found.map((x) => x.m))].sort((a, b) => a - b),
      strength: best.str,
      freq: 'From seasonality pattern',
      note: best.note,
      typicalDps: 'See history site',
    },
  };
}

function analyse(raw) {
  const box = $('#divSearchResult');
  const q = cleanSym(raw);
  if (!q) { box.innerHTML = emptyHtml('Type a symbol'); return; }

  const { key, prof, many } = findProfile(q);

  if (many) {
    box.innerHTML = emptyHtml(`Matching symbols: ${many.map((k) =>
      `<button type="button" class="link-btn" data-analyse="${esc(k)}">${esc(k)}</button>`).join(', ')} — pick one`);
    return;
  }

  if (!prof) {
    box.innerHTML = `<div class="tip" style="margin:0">
      <p style="margin-bottom:10px"><b>${esc(q)}</b> — no built-in pattern data. Full cash-dividend history:</p>
      <a class="btn primary" target="_blank" rel="noopener" href="${historyUrl(q)}">Open history → ${esc(q)}</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="${CSE_DIV_URL}">CSE cash dividends</a>
    </div>`;
    return;
  }

  const months = (prof.months || []).filter(validMonth);
  const now = new Date();
  let nextM = months.find((m) => m >= now.getMonth() + 1);
  let nextY = now.getFullYear();
  if (nextM == null && months.length) { nextM = months[0]; nextY++; }

  const pills = months.map((m) =>
    `<span class="pill ${m === nextM ? 'sell' : prof.strength === 'high' ? 'near' : 'neutral'}">${MONTHS[m]}${m === nextM ? ' · next?' : ''}</span>`).join(' ');

  const hold = holdingsMap().get(key);
  const holdBal = hold ? nonNeg(hold.balance) : 0;
  const holdDps = hold ? nonNeg(hold.avgDps) : 0;
  const portBlock = hold ? `<div class="metric good" style="margin-top:12px"><div class="m-label">Your portfolio</div>
      <div class="m-val sm">${esc(key)} · ${fmt(holdBal)} shares</div>
      <div class="m-hint">${holdDps ? `Avg DPS set: Rs ${fmt(holdDps)} · Est/year ~ Rs ${fmt(holdBal * holdDps)}` : 'Avg DPS not set yet — enter it in the setup table below'}${months.length > 1 ? ` · paid in ~${months.length} instalments` : ''}</div></div>` : '';

  // Apply the *next* expected month (more useful than always the first).
  const applyM = nextM || months[0] || 0;

  box.innerHTML = `
    <div class="metric-grid" style="margin-bottom:14px">
      <div class="metric"><div class="m-label">Company</div><div class="m-val t-gold">${esc(key)}</div><div class="m-hint">${esc(prof.name || '')}</div></div>
      <div class="metric"><div class="m-label">Pattern strength</div><div class="m-val" style="color:${strengthColor(prof.strength)}">${esc((prof.strength || '—').toUpperCase())}</div><div class="m-hint">${esc(prof.freq || '')}</div></div>
      <div class="metric"><div class="m-label">Likely next window</div><div class="m-val sm">${nextM ? `${MONTHS[nextM]} ${nextY}` : '—'}</div><div class="m-hint">Estimate only · confirm CSE</div></div>
      <div class="metric"><div class="m-label">Typical DPS note</div><div class="m-val text">${esc(prof.typicalDps || '—')}</div></div>
    </div>
    <div class="section-title">Past pattern months (when they often paid)</div>
    <div class="pill-row">${pills || '—'}</div>
    ${prof.note ? `<div class="tip">${esc(prof.note)}</div>` : ''}
    ${portBlock}
    <div class="panel-actions" style="margin-top:14px">
      <a class="btn primary" target="_blank" rel="noopener" href="${historyUrl(key)}">Full DPS history ↗</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="${CSE_DIV_URL}">CSE cash dividends</a>
      ${applyM ? `<button class="btn ghost" type="button" data-apply-month="${esc(key)}" data-month="${applyM}">Apply ${MONTHS[applyM]} → portfolio</button>` : ''}
    </div>
    <div class="legend">This analysis is based on history patterns — not a guarantee. Confirm official XD/announcement on the CSE.</div>`;
}

function applyMonth(sym, month) {
  if (!validMonth(month)) { toast('No typical month available for this symbol'); return; }
  let matched = 0, changed = 0;
  state.holdings.forEach((h) => {
    if (baseSym(h.name) !== sym) return;
    matched++;
    if (!validMonth(Number(h.divMonth))) { h.divMonth = month; changed++; }
  });
  if (!matched) { toast('That symbol is not in your portfolio — add it in the Portfolio tab first'); return; }
  if (!changed) { toast(`${sym} already has a typical month set — edit it in the setup table to change it`); return; }
  commit('holdings');
  toast(`Typical month ${MONTHS[month]} → ${changed} holding(s)`);
}

/* ======================================================================
 * Seasonality
 * ==================================================================== */

const monthScore = (m) => (SEASON[m] || []).reduce((s, r) => s + (STRENGTH_SCORE[r[3]] || 1), 0);

function renderSeasonality() {
  const scores = Array.from({ length: 13 }, (_, m) => (m ? monthScore(m) : 0));
  const maxScore = Math.max(0, ...scores);

  // How many of the user's holdings typically pay in each month.
  const mineByMonth = new Array(13).fill(0);
  for (const h of holdingsMap().values()) {
    const m = Number(h.divMonth);
    if (validMonth(m)) mineByMonth[m]++;
  }

  let heat = '';
  for (let m = 1; m <= 12; m++) {
    const rows = SEASON[m] || [];
    const pct = maxScore ? Math.round((scores[m] / maxScore) * 100) : 0;
    // Both class schemes from the two earlier versions, so existing CSS keeps working.
    const lvl = pct > 70 ? 'hot lvl-hi' : pct > 35 ? 'warm lvl-mid' : 'cool';
    const yours = mineByMonth[m] ? ` · ${mineByMonth[m]} yours` : '';
    heat += `<button type="button" class="heat-cell ${lvl}" data-month="${m}" aria-pressed="${m === selectedMonth}" aria-label="${MONTHS[m]}: ${rows.length} companies${yours}">
      <span class="m">${MONTHS[m]}</span><span class="n">${rows.length} names${yours}</span><span class="bar"><span style="width:${pct}%"></span></span></button>`;
  }
  $('#yearHeat').innerHTML = heat;

  $('#monthBtns').innerHTML = MONTHS.slice(1).map((name, i) =>
    `<button type="button" class="btn ${i + 1 === selectedMonth ? 'primary' : 'ghost'}" data-month="${i + 1}" aria-pressed="${i + 1 === selectedMonth}">${name}</button>`).join('');

  const mine = new Set(holdingsMap().keys());
  // Strongest first, then your holdings first within the same strength.
  const rows = [...(SEASON[selectedMonth] || [])].sort((a, b) =>
    (STRENGTH_ORDER[a[3]] - STRENGTH_ORDER[b[3]]) || (Number(mine.has(b[0])) - Number(mine.has(a[0]))));
  if (!rows.length) { $('#seasonList').innerHTML = emptyHtml('No pattern data for this month'); return; }

  $('#seasonList').innerHTML = `
    <p class="hint" style="margin:0 0 10px"><b style="color:var(--ink)">${MONTHS[selectedMonth]}</b> — likely dividend companies from past pattern (${rows.length})</p>
    <div class="table-wrap"><table class="data-table sticky-first" style="min-width:600px">
      <thead><tr><th scope="col">Symbol</th><th scope="col" class="left">Company</th><th scope="col">Pattern</th><th scope="col" class="left">Note</th><th scope="col"><span class="sr-only">Link</span></th></tr></thead>
      <tbody>${rows.map(([sym, name, note, str]) => `<tr>
        <td class="sym-strong">${esc(sym)}${mine.has(sym) ? ' <span class="badge port">YOURS</span>' : ''}</td>
        <td class="text">${esc(name)}</td>
        <td><span class="pill ${strengthPill(str)}">${esc(String(str || '').toUpperCase())}</span></td>
        <td class="text">${esc(note)}</td>
        <td><a href="${historyUrl(sym)}" target="_blank" rel="noopener">History ↗</a></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

/* ======================================================================
 * Live dividends — data layer
 * ==================================================================== */

/**
 * Pull a per-share amount from free text. Returns a number (Rs) or null.
 * Guards against "Rs 2.5 Bn profit" and year numbers like "2025/26".
 */
function parseAmount(text) {
  const s = String(text || '');
  const NOT_BIG = '(?!\\s*(?:bn|mn|billion|million|crore|lakh|m\\b|b\\b))';
  const tries = [
    [new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*cents?\\s*(?:per|/|a)\\s*share`, 'i'), 0.01],
    [new RegExp(`(?:Rs\\.?|LKR|රු\\.?)\\s*([0-9]+(?:\\.[0-9]+)?)(?![0-9.])${NOT_BIG}`, 'i'), 1],
    [new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*(?:rupees?\\s*)?(?:per|/|a)\\s*(?:ordinary\\s+|voting\\s+)?share`, 'i'), 1],
  ];
  for (const [re, k] of tries) {
    const m = s.match(re);
    if (!m) continue;
    const n = Number(m[1]) * k;
    if (n > 0 && n < 10000) return Math.round(n * 10000) / 10000;
  }
  return null;
}

function divType(it) {
  if (it.firstAndFinal) return 'First & Final';
  if (it.finalDividend) return 'Final';
  if (it.typeFirstInt) return '1st Interim';
  if (it.typeSecondInt) return '2nd Interim';
  if (it.typeThirdInt) return '3rd Interim';
  const t = `${it.title || ''} ${it.remarks || ''} ${it.announcementCategory || ''}`;
  if (/first\s*(?:and|&)\s*final/i.test(t)) return 'First & Final';
  if (/final/i.test(t)) return 'Final';
  if (/interim/i.test(t)) return 'Interim';
  return 'Cash Dividend';
}

/** Structured CSE cash-dividend row → common shape. */
function fromCashDividend(it) {
  const dps = posNum(it.votingDivPerShare) ?? parseAmount(it.remarks);
  return {
    kind: 'cse',
    symbol: baseSym(it.symbol || ''),
    rawSym: String(it.symbol || '').trim().toUpperCase(),
    company: it.company || '',
    type: divType(it),
    dps,
    nvDps: posNum(it.nonVotingDivPerShare),
    dpsSource: dps ? 'cse' : null,
    xd: it.xd || '',
    record: it.recordDate || '',
    pay: it.payment || it.paymentDate || '',
    date: it.dateOfAnnouncement || it.createdDate || '',
    link: CSE_DIV_URL,
    note: it.remarks || '',
  };
}

/** Generic CSE announcement row (amount often only in the PDF) → common shape. */
function fromAnnouncement(x) {
  const dps = parseAmount(x.allotment) ?? posNum(x.allotment) ?? parseAmount(x.remarks);
  return {
    kind: 'cse',
    symbol: baseSym(x.symbol || ''),
    rawSym: String(x.symbol || '').trim().toUpperCase(),
    company: x.company || '',
    type: divType(x),
    dps,
    nvDps: null,
    dpsSource: dps ? 'cse' : null,
    xd: x.xd || '',
    record: x.recordDate || '',
    pay: x.paymentDate || x.payment || '',
    date: x.dateOfAnnouncement || x.createdDate || '',
    link: CSE_DIV_URL,
    note: x.remarks || '',
  };
}

function fromNews(it) {
  const text = `${it.title || ''} ${it.summary || ''}`;
  const dps = parseAmount(text);
  return {
    kind: 'news',
    symbol: baseSym(it.symbol || ''),
    rawSym: String(it.symbol || '').trim().toUpperCase(),
    company: '',
    type: divType(it),
    dps,
    nvDps: null,
    dpsSource: dps ? 'news' : null,
    xd: '', record: '', pay: '',
    date: it.pubDate || '',
    link: safeUrl(it.link) || CSE_DIV_URL,
    title: it.title || '',
    source: it.source || 'News',
  };
}

const live = { rows: [], at: 0, inflight: null, via: '' };
let googlePool = { items: [], at: 0 };

/** Fill missing DPS on announcement rows by matching company names in news headlines. */
async function enrichFromNews(rows) {
  const missing = rows.filter((r) => r.dps == null && r.company);
  if (!missing.length) return;

  if (Date.now() - googlePool.at > LIVE_TTL) {
    try {
      const d = await news('google', { q: 'CSE "cash dividend" OR "per share" Colombo' });
      const items = Array.isArray(d?.items) ? d.items : Array.isArray(d) ? d : [];
      googlePool = { items, at: Date.now() };
    } catch {
      googlePool.at = Date.now(); // don't hammer a failing source
    }
  }
  const pool = [...(state.newsCache || []), ...googlePool.items];

  for (const r of missing) {
    const key = r.company.toLowerCase().replace(/\s+plc\.?$/, '').trim().slice(0, 12);
    if (key.length < 4) continue;
    for (const it of pool) {
      const text = `${it.title || ''} ${it.summary || ''}`;
      if (!text.toLowerCase().includes(key)) continue;
      const amt = parseAmount(text);
      if (amt) {
        r.dps = amt;
        r.dpsSource = 'news';
        const l = safeUrl(it.link);
        if (l) r.link = l;
        break;
      }
    }
  }
}

async function fetchCseRows() {
  // 1) Structured endpoint — has DPS + XD/record/payment dates.
  try {
    const data = await cse('cashDividends');
    const list = Array.isArray(data?.cashDividends) ? data.cashDividends : [];
    if (list.length) return { rows: list.map(fromCashDividend), via: 'cashDividends' };
  } catch (err) {
    console.warn('[dividends] cashDividends unavailable', err);
  }
  // 2) Fallback — approved announcements filtered to cash dividends, amounts enriched from news.
  try {
    const data = await cse('approvedAnnouncement');
    const list = (data?.approvedAnnouncements || []).filter((x) => /cash\s*dividend/i.test(x.announcementCategory || ''));
    const rows = list.map(fromAnnouncement);
    await enrichFromNews(rows);
    return { rows, via: 'announcements' };
  } catch (err) {
    console.warn('[dividends] approvedAnnouncement unavailable', err);
  }
  return { rows: [], via: '' };
}

const liveIsStale = () => !live.at || Date.now() - live.at > (live.rows.length ? LIVE_TTL : LIVE_RETRY_EMPTY);

/** Cached + de-duplicated loader: concurrent callers share one request. */
function ensureLive(force = false) {
  if (live.inflight) return live.inflight;
  if (!force && !liveIsStale()) return Promise.resolve(live.rows);
  if (!force && state.live === 'down') return Promise.resolve(live.rows);
  live.inflight = fetchCseRows()
    .then(({ rows, via }) => {
      // Keep the previous good data if a refresh comes back empty.
      if (rows.length || !live.rows.length) { live.rows = rows; live.via = via; }
      live.at = Date.now();
      return live.rows;
    })
    .finally(() => { live.inflight = null; });
  return live.inflight;
}

/** CSE rows + news rows → merged, de-duplicated, sorted (upcoming XD first). */
function buildLiveRows() {
  const today = startOfToday();
  const cseSyms = new Set(live.rows.map((r) => r.symbol).filter(Boolean));

  const newsRows = (state.newsCache || [])
    .filter((it) => it.kind === 'div' || DIV_NEWS_RE.test(`${it.title} ${it.source}`))
    .map(fromNews)
    // A news item about a company already covered by an official CSE row adds nothing.
    .filter((r) => !(r.symbol && cseSyms.has(r.symbol)));

  const seen = new Set();
  const out = [];
  for (const r of [...live.rows, ...newsRows]) {
    const id = r.kind === 'cse'
      ? `c|${r.symbol || r.company.toLowerCase()}|${isoDate(r.xd) || isoDate(r.date)}|${r.type}`
      : `n|${r.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }

  const rank = (r) => {
    const xd = toDate(r.xd);
    if (xd && xd >= today) return [0, xd.getTime()];          // upcoming XD: soonest first
    return [1, -(toDate(r.date)?.getTime() || 0)];             // otherwise: newest first
  };
  out.sort((a, b) => { const ra = rank(a), rb = rank(b); return (ra[0] - rb[0]) || (ra[1] - rb[1]); });
  return out.slice(0, LIVE_LIMIT);
}

/* ======================================================================
 * Live dividends — view
 * ==================================================================== */

let lastLiveRows = [];

function liveItemHtml(r, idx, holds, today) {
  const hold = r.symbol ? holds.get(r.symbol) : null;
  const xd = toDate(r.xd);
  const daysToXd = xd ? Math.round((xd - today) / DAY) : null;

  const symLabel = r.rawSym || r.symbol || '';
  const amountTxt = r.dps
    ? `Rs ${r.dps.toFixed(2)} / share${r.nvDps ? ` (Non-voting Rs ${r.nvDps.toFixed(2)})` : ''}`
    : '';
  const income = hold && r.dps ? nonNeg(hold.balance) * r.dps : 0;

  // Headline: "CWL.N0000 · Dividend Rs 3.00 / share"
  const headline = symLabel
    ? `${symLabel} · Dividend ${amountTxt || 'amount not published yet'}`
    : (r.kind === 'news' ? r.title : `${r.company || 'Company'} · Dividend ${amountTxt || 'amount not published yet'}`);
  // Sub-line: company / type, or the news headline when we built our own headline
  const subline = r.kind === 'news'
    ? (symLabel ? r.title : '')
    : [r.company, r.type].filter(Boolean).join(' · ');

  const meta = [
    r.xd && `XD ${showDate(r.xd)}`,
    r.record && `RD ${showDate(r.record)}`,
    r.pay && `Pay ${showDate(r.pay)}`,
  ].filter(Boolean).join(' · ');

  const xdBadge = daysToXd != null && daysToXd >= 0
    ? `<span class="pill ${daysToXd <= 7 ? 'sell' : 'near'}">${daysToXd === 0 ? 'XD today' : `XD in ${daysToXd}d`}</span>`
    : '';

  const amountRow = amountTxt
    ? `<div class="div-amt"><span class="pill sell" style="font-size:14px"><b>${esc(amountTxt)}</b></span>${r.dpsSource === 'news' ? ' <span class="t-muted">(from news — verify)</span>' : ''}${income ? ` · <span class="t-pos">your ${fmt(nonNeg(hold.balance))} shares → Rs ${fmt(income)}</span>` : ''}</div>`
    : '<div class="div-amt muted">Amount: not in feed yet — open the CSE PDF</div>';

  const canLog = r.symbol && r.dps && hold;
  const link = esc(r.link || CSE_DIV_URL);

  return `<article class="news-item compact">
    <div class="ni-body">
      <a class="title" href="${link}" target="_blank" rel="noopener"><b>${esc(headline)}</b></a>
      ${subline ? `<div class="hint" style="margin:2px 0">${esc(subline)}</div>` : ''}
      ${amountRow}
      <div class="news-meta">
        <span class="badge cse">${r.kind === 'cse' ? 'CSE CASH DIVIDEND' : 'DIVIDEND / NEWS'}</span>
        ${hold ? '<span class="badge port">YOUR PORTFOLIO</span>' : ''}
        ${xdBadge}
      </div>
      <div class="news-source-row"><span class="src-dot"></span><span>${esc(meta || r.source || r.note || 'CSE cash dividend')}</span></div>
    </div>
    <div class="ni-side">
      <span class="ni-time">${esc(r.kind === 'news' ? fmtDate(r.date) : showDate(r.date))}</span>
      <a class="btn ghost sm" href="${link}" target="_blank" rel="noopener">Open ↗</a>
      ${canLog ? `<button type="button" class="btn ghost sm" data-log="${idx}" title="Add to Event log">+ Log</button>` : ''}
    </div>
  </article>`;
}

function renderLiveDividends() {
  const el = $('#liveDivList');
  if (!el) return;

  const rows = buildLiveRows();
  lastLiveRows = rows;

  if (!rows.length) {
    el.innerHTML = emptyHtml(
      live.inflight ? 'Loading CSE announcements…'
        : (state.newsCache?.length || live.at) ? 'No dividend-related announcements right now.'
          : 'Loading announcements… use <strong>↻ Refresh</strong> if this stays empty.'
    );
    return;
  }

  const holds = holdingsMap();
  const today = startOfToday();
  const yours = rows.filter((r) => r.symbol && holds.has(r.symbol)).length;

  el.innerHTML = `
    ${yours ? `<p class="hint" style="margin:0 0 8px"><b class="t-gold">${yours}</b> item(s) affect your portfolio.</p>` : ''}
    <div class="news-list">${rows.map((r, i) => liveItemHtml(r, i, holds, today)).join('')}</div>
    <p class="legend" style="margin-top:8px">Source: ${live.via === 'cashDividends' ? 'CSE cash-dividend table' : live.via === 'announcements' ? 'CSE announcements (amounts may be missing — check the PDF)' : 'news feed'}.
      Use <b>+ Log</b> to copy a dividend into the Event log.</p>`;
}

function logLiveRow(r) {
  if (!r?.symbol || !r.dps) return;
  const xd = isoDate(r.xd);
  const dup = state.divEvents.some((ev) => baseSym(ev.symbol || '') === r.symbol && (ev.xd || '') === xd && num(ev.dps) === r.dps);
  if (dup) { toast(`${r.symbol} ${xd ? `(XD ${xd}) ` : ''}is already in the Event log`); return; }
  state.divEvents.push({
    symbol: r.symbol,
    dps: r.dps,
    type: String(r.type || 'Cash').slice(0, 20),
    xd,
    pay: isoDate(r.pay),
    status: 'Announced',
  });
  commit('divEvents');
  toast(`Logged ${r.symbol} · Rs ${fmt(r.dps)} / share`);
}

/* ======================================================================
 * Setup, forecast, events
 * ==================================================================== */

function renderSetup() {
  let totalEst = 0;
  const html = state.holdings.map((h, i) => {
    const bal = nonNeg(h.balance);
    const dps = nonNeg(h.avgDps);
    const est = bal * dps;
    totalEst += est;
    const cost = nonNeg(h.totalCost);
    const yoc = cost > 0 && dps > 0 ? (est / cost) * 100 : 0;
    return `<tr>
      <td class="sym-strong">${esc(h.name || '—')}</td>
      <td>${fmt(bal)}</td>
      <td><input class="cell" data-key="d${i}:avgDps" data-i="${i}" data-f="avgDps" value="${dps || ''}" placeholder="0" inputmode="decimal" style="max-width:76px" aria-label="Average annual DPS for ${esc(h.name)}"></td>
      <td><input class="cell" data-key="d${i}:divMonth" data-i="${i}" data-f="divMonth" value="${validMonth(Number(h.divMonth)) ? h.divMonth : ''}" placeholder="1-12" inputmode="numeric" style="max-width:54px" title="1-12" aria-label="Typical month (1-12) for ${esc(h.name)}"></td>
      <td class="t-gold"><b>Rs ${fmt(est)}</b></td>
      <td class="${yoc > 0 ? 't-pos' : 't-muted'}">${yoc ? fmtPct(yoc) : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-row">No shares in portfolio yet. Add holdings in the <b>Portfolio</b> tab first, then come back to set Avg DPS.</td></tr>';
  renderPreservingFocus($('#divSetupBody'), html);
  return totalEst;
}

/**
 * Months a holding is expected to pay in. If the profile lists several months
 * (interim + final) and the user's typical month is one of them, the annual
 * amount is split across all of them; otherwise it's one payment.
 */
function payoutMonths(sym, typical) {
  const pm = [...new Set((DIV_PROFILE[sym]?.months || []).filter(validMonth))];
  return pm.length > 1 && pm.includes(typical) ? pm.sort((a, b) => a - b) : [typical];
}

/** Confirmed (Event log, not yet paid) + estimated payments for the next 12 months. */
function buildForecast() {
  const today = startOfToday();
  const horizon = new Date(today);
  horizon.setMonth(horizon.getMonth() + 12);
  const holds = holdingsMap();
  const items = [];
  const confirmedIdx = new Map(); // sym → [monthIdx…]

  for (const ev of state.divEvents) {
    if (ev.status === 'Paid') continue;
    const sym = baseSym(ev.symbol || '');
    const h = holds.get(sym);
    const dps = nonNeg(ev.dps);
    const d = toDate(ev.pay) || toDate(ev.xd);
    if (!h || !dps || !d || d < today || d > horizon) continue;
    const y = d.getFullYear(), m = d.getMonth() + 1;
    items.push({ sym, y, m, amt: nonNeg(h.balance) * dps, kind: 'confirmed', label: ev.type || 'Announced' });
    if (!confirmedIdx.has(sym)) confirmedIdx.set(sym, []);
    confirmedIdx.get(sym).push(monthIdx(y, m));
  }

  const curM = today.getMonth() + 1;
  for (const [sym, h] of holds) {
    const annual = nonNeg(h.balance) * nonNeg(h.avgDps);
    const typical = Number(h.divMonth);
    if (!annual || !validMonth(typical)) continue;
    const ms = payoutMonths(sym, typical);
    const share = annual / ms.length;
    for (const m of ms) {
      const y = m < curM ? today.getFullYear() + 1 : today.getFullYear();
      // Skip an estimate if a confirmed payment lands within ±1 month of it (avoids double counting).
      const near = (confirmedIdx.get(sym) || []).some((ci) => Math.abs(ci - monthIdx(y, m)) <= 1);
      if (near) continue;
      items.push({ sym, y, m, amt: share, kind: 'est', label: ms.length > 1 ? `est. ${ms.length}-part split` : 'est.' });
    }
  }

  items.sort((a, b) => (monthIdx(a.y, a.m) - monthIdx(b.y, b.m)) || (b.amt - a.amt));
  return items;
}

function renderForecast(items) {
  const el = $('#divForecast');
  if (!items.length) {
    el.innerHTML = '<div class="res-row"><span class="l">Enter Avg DPS + typical month (or log an announced dividend) to see the forecast</span><span class="v">—</span></div>';
    return;
  }
  const total = items.reduce((s, it) => s + it.amt, 0);
  el.innerHTML = items.map((it) => `<div class="res-row">
      <span class="l"><b>${esc(it.sym)}</b> · ${it.kind === 'est' ? '~' : ''}${MONTHS[it.m]} ${it.y}
        <span class="pill ${it.kind === 'confirmed' ? 'sell' : 'neutral'}">${esc(it.kind === 'confirmed' ? `confirmed · ${it.label}` : it.label)}</span></span>
      <span class="v t-pos">${it.kind === 'est' ? '~ ' : ''}Rs ${fmt(it.amt)}</span>
    </div>`).join('') +
    `<div class="res-row"><span class="l"><b>Next 12 months total</b></span><span class="v t-gold"><b>~ Rs ${fmt(total)}</b></span></div>`;
}

function renderEvents() {
  const body = $('#divEventBody');
  if (!state.divEvents.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-row">No events — click "+ Event" or use "+ Log" on a live dividend</td></tr>';
    return;
  }
  const holds = holdingsMap();
  const txt = (i, f, v, w, ph = '') =>
    `<input class="cell text-cell" data-key="e${i}:${f}" data-ei="${i}" data-ef="${f}" value="${esc(v ?? '')}" placeholder="${ph}" style="max-width:${w}px" aria-label="${f}">`;

  const html = state.divEvents.map((ev, i) => ({ ev, i })).reverse().map(({ ev, i }) => {
    const hold = holds.get(baseSym(ev.symbol || '')); // matches "JKH" and "JKH.N0000"
    const income = hold ? nonNeg(hold.balance) * nonNeg(ev.dps) : 0;
    return `<tr>
      <td>${txt(i, 'symbol', ev.symbol, 110, 'SYMBOL')}</td>
      <td><input class="cell" data-key="e${i}:dps" data-ei="${i}" data-ef="dps" value="${ev.dps || ''}" placeholder="0" inputmode="decimal" style="max-width:70px" aria-label="DPS"></td>
      <td>${txt(i, 'type', ev.type, 84, 'Final')}</td>
      <td>${txt(i, 'xd', ev.xd, 104, 'YYYY-MM-DD')}</td>
      <td>${txt(i, 'pay', ev.pay, 104, 'YYYY-MM-DD')}</td>
      <td><select class="select" data-key="e${i}:status" data-ei="${i}" data-ef="status" aria-label="Status" style="padding:5px 8px">
        <option value="Announced" ${ev.status !== 'Paid' ? 'selected' : ''}>Announced</option>
        <option value="Paid" ${ev.status === 'Paid' ? 'selected' : ''}>Paid</option></select></td>
      <td class="t-gold">${income ? `~Rs ${fmt(income)}` : '—'}</td>
      <td><button class="del" type="button" data-edel="${i}" aria-label="Delete event">&times;</button></td>
    </tr>`;
  }).join('');
  renderPreservingFocus(body, html);
}

function renderSummary(totalEst, forecast) {
  const today = startOfToday();
  const in90 = new Date(today.getTime() + 90 * DAY);
  const next90 = forecast
    .filter((it) => {
      const d = new Date(it.y, it.m - 1, 15);
      return d <= in90;
    })
    .reduce((s, it) => s + it.amt, 0);
  const open = state.divEvents.filter((e) => e.status !== 'Paid').length;
  const received = state.divEvents
    .filter((e) => e.status === 'Paid')
    .reduce((s, e) => s + nonNeg(holdingsMap().get(baseSym(e.symbol || ''))?.balance) * nonNeg(e.dps), 0);
  const tracked = state.holdings.filter((h) => nonNeg(h.avgDps) > 0).length;

  $('#divSummary').innerHTML = `
    <div class="card"><div class="label">Est. annual dividends</div><div class="value pos">Rs ${fmt(totalEst)}</div><div class="hint">balance × avg DPS</div></div>
    <div class="card"><div class="label">Next ~90 days</div><div class="value">Rs ${fmt(next90)}</div><div class="hint">confirmed + estimated</div></div>
    <div class="card"><div class="label">Logged events</div><div class="value">${state.divEvents.length}</div><div class="hint">${open} open · ~Rs ${fmt(received)} marked paid</div></div>
    <div class="card"><div class="label">Holdings tracked</div><div class="value">${tracked} / ${state.holdings.length}</div><div class="hint">with DPS set · <a href="${HISTORY_HOME}" target="_blank" rel="noopener">DPS history →</a></div></div>`;
}

/* ======================================================================
 * Smart auto-fill
 * ==================================================================== */

/** Fill typical month + numeric DPS from DIV_PROFILE. Shift-click the button to overwrite existing values. */
function autoFillFromProfiles({ force = false } = {}) {
  let months = 0, dpsN = 0;
  const curM = new Date().getMonth() + 1;
  for (const h of state.holdings) {
    const prof = DIV_PROFILE[baseSym(h.name || '')];
    if (!prof) continue;
    const pm = (prof.months || []).filter(validMonth);
    if (pm.length && (force || !validMonth(Number(h.divMonth)))) {
      // Pick the next upcoming month rather than blindly the first one.
      h.divMonth = pm.find((m) => m >= curM) ?? pm[0];
      months++;
    }
    // typicalDps is often a note — only use it when it is a single clean number.
    const t = String(prof.typicalDps ?? '').trim();
    const dps = /^(?:Rs\.?\s*)?\d+(?:\.\d+)?$/i.test(t) ? posNum(t.replace(/^Rs\.?\s*/i, '')) : null;
    if (dps && (force || !(nonNeg(h.avgDps) > 0))) { h.avgDps = dps; dpsN++; }
  }
  if (months || dpsN) {
    commit('holdings');
    toast(`Smart fill: ${months} typical month(s)${dpsN ? `, ${dpsN} DPS value(s)` : ''}. Check Avg DPS against dividend history.`);
  } else {
    toast(force ? 'No profile data to apply.' : 'Nothing to fill — all set, or no profile match. Shift-click to overwrite.');
  }
  render();
}

/* ======================================================================
 * Render & wiring
 * ==================================================================== */

export function render() {
  renderSeasonality();
  renderLiveDividends();
  const totalEst = renderSetup();
  const forecast = buildForecast();
  renderForecast(forecast);
  renderEvents();
  renderSummary(totalEst, forecast);

  // Network only when the cache is stale — not on every render/commit.
  if (liveIsStale() && !live.inflight) {
    ensureLive().then(renderLiveDividends).catch(() => renderLiveDividends());
  }
}

async function refreshLive(btn) {
  if (btn) setBusy(btn, true);
  try {
    const results = await Promise.allSettled([loadNews({ force: true }), ensureLive(true)]);
    renderLiveDividends();
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === results.length) toast('Refresh failed — sources unavailable', { error: true });
    else if (failed) toast('Partly refreshed — one source is unavailable');
    else toast('Dividend feed updated');
  } finally {
    if (btn) setBusy(btn, false);
  }
}

export function init() {
  $('#divSearchForm').addEventListener('submit', (e) => { e.preventDefault(); analyse($('#divSearchBox').value); });
  $('#divSearchResult').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-analyse]');
    if (pick) { $('#divSearchBox').value = pick.dataset.analyse; analyse(pick.dataset.analyse); return; }
    const apply = e.target.closest('[data-apply-month]');
    if (apply) applyMonth(apply.dataset.applyMonth, Number(apply.dataset.month));
  });

  // Quick-research chips anywhere on the page (delegated, so dynamically added chips work too).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-div-sym]');
    if (!btn) return;
    const sym = btn.getAttribute('data-div-sym');
    $('#divSearchBox').value = sym;
    analyse(sym);
    $('#divSearchResult')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  const pickMonth = (e) => {
    const b = e.target.closest('[data-month]');
    if (!b) return;
    selectedMonth = Number(b.dataset.month);
    renderSeasonality();
    if (e.currentTarget.id === 'yearHeat') $('#seasonPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#yearHeat').addEventListener('click', pickMonth);
  $('#monthBtns').addEventListener('click', pickMonth);

  $('#divAutoFillBtn')?.addEventListener('click', (e) => autoFillFromProfiles({ force: e.shiftKey }));

  // Supports either refresh button id used by the two earlier versions.
  ['#divLiveRefresh', '#refreshDivLiveBtn'].forEach((sel) =>
    $(sel)?.addEventListener('click', (e) => refreshLive(e.currentTarget)));

  $('#liveDivList')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-log]');
    if (b) logLiveRow(lastLiveRows[Number(b.dataset.log)]);
  });

  $('#divSetupBody').addEventListener('change', (e) => {
    const inp = e.target.closest('input.cell');
    const h = inp && state.holdings[Number(inp.dataset.i)];
    if (!h) return;
    if (inp.dataset.f === 'divMonth') {
      const m = Math.round(num(inp.value, 0) || 0);
      h.divMonth = validMonth(m) ? m : 0;
    } else {
      h[inp.dataset.f] = nonNeg(inp.value);
    }
    setTimeout(() => commit('holdings'), 0);
  });

  const events = $('#divEventBody');
  events.addEventListener('change', (e) => {
    const el = e.target.closest('[data-ef]');
    const ev = el && state.divEvents[Number(el.dataset.ei)];
    if (!ev) return;
    const f = el.dataset.ef;
    if (f === 'dps') ev.dps = nonNeg(el.value);
    else if (f === 'symbol') ev.symbol = el.value.trim().toUpperCase().slice(0, 24);
    else if (f === 'status') ev.status = el.value === 'Paid' ? 'Paid' : 'Announced';
    else if (f === 'xd' || f === 'pay') ev[f] = isoDate(el.value);   // normalise "5 Nov 2026" → 2026-11-05
    else ev[f] = el.value.trim().slice(0, 20);
    setTimeout(() => commit('divEvents'), 0);
  });
  events.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-edel]');
    if (!btn) return;
    if (!(await confirmDialog('Delete this dividend event?', '', { confirmLabel: 'Delete', danger: true }))) return;
    state.divEvents.splice(Number(btn.dataset.edel), 1);
    commit('divEvents');
  });
  $('#addDivEventBtn').addEventListener('click', () => {
    state.divEvents.push({ symbol: '', dps: 0, type: 'Final', xd: '', pay: '', status: 'Announced' });
    commit('divEvents');
    requestAnimationFrame(() => events.querySelector('input')?.focus());
  });
}

/** On open: render now; pull news + CSE data in the background if needed. */
export function show() {
  render();
  if (!state.newsCache?.length && state.live !== 'down') {
    loadNews().then(renderLiveDividends).catch(() => {});
  }
}

export default { init, render, show };
