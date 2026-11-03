/**
 * Dividends view: symbol research, seasonality heat map + month list,
 * live dividend mentions (from the news feed), per-holding setup,
 * 12-month forecast and the dividend event log.
 */
import { commit, state } from '../core/store.js';
import { DIV_PROFILE, MONTHS, SEASON } from '../data/reference.js';
import { baseSym } from '../core/finance.js';
import { $, esc, fmt, fmtDate, fmtPct, num, safeUrl } from '../core/utils.js';
import { emptyHtml, renderPreservingFocus, setBusy, toast, confirmDialog } from '../core/ui.js';
import { cse, news } from '../core/api.js';
import { loadNews } from './news.js';

let selectedMonth = new Date().getMonth() + 1;
const STRENGTH_ORDER = { high: 0, med: 1, low: 2 };
const strengthPill = (s) => (s === 'high' ? 'sell' : s === 'med' ? 'near' : 'neutral');
const historyUrl = (sym) => `https://stockdividends.iamsupun.com/stocks/${encodeURIComponent(sym)}/`;
const CSE_DIV_URL = 'https://www.cse.lk/announcements/?category=CASH+DIVIDEND';

/* ---------- research ---------- */

function analyse(raw) {
  const box = $('#divSearchResult');
  const q = String(raw || '').trim().toUpperCase().replace(/\.N0000|\.X0000|\.N|\.X/g, '');
  if (!q) { box.innerHTML = emptyHtml('Type a symbol'); return; }

  let key = null, prof = null;
  if (DIV_PROFILE[q]) { key = q; prof = DIV_PROFILE[q]; } else {
    const hits = Object.entries(DIV_PROFILE).filter(([k, v]) => k.includes(q) || (v.name || '').toUpperCase().includes(q));
    if (hits.length === 1) [[key, prof]] = hits;
    else if (hits.length > 1) {
      box.innerHTML = emptyHtml(`Matching symbols: ${hits.map(([k]) => `<button type="button" class="link-btn" data-analyse="${esc(k)}">${esc(k)}</button>`).join(', ')} — pick one`);
      return;
    }
  }

  // Fall back to the seasonality table if there is no dedicated profile.
  if (!prof) {
    const found = [];
    for (let m = 1; m <= 12; m++) (SEASON[m] || []).forEach((r) => { if (r[0] === q) found.push({ m, name: r[1], note: r[2], str: r[3] }); });
    if (found.length) {
      const best = [...found].sort((a, b) => STRENGTH_ORDER[a.str] - STRENGTH_ORDER[b.str])[0];
      prof = { name: found[0].name, months: [...new Set(found.map((x) => x.m))].sort((a, b) => a - b), strength: best.str, freq: 'From seasonality pattern', note: best.note, typicalDps: 'See history site' };
      key = q;
    }
  }

  if (!prof) {
    box.innerHTML = `<div class="tip" style="margin:0">
      <p style="margin-bottom:10px"><b>${esc(q)}</b> — no built-in pattern data. Full cash-dividend history:</p>
      <a class="btn primary" target="_blank" rel="noopener" href="${historyUrl(q)}">Open history → ${esc(q)}</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="${CSE_DIV_URL}">CSE cash dividends</a>
    </div>`;
    return;
  }

  const months = prof.months || [];
  const now = new Date();
  let nextM = months.find((m) => m >= now.getMonth() + 1);
  let nextY = now.getFullYear();
  if (nextM == null && months.length) { nextM = months[0]; nextY++; }
  const strColor = prof.strength === 'high' ? 'var(--pos)' : prof.strength === 'med' ? 'var(--warn)' : 'var(--muted)';
  const pills = months.map((m) => `<span class="pill ${m === nextM ? 'sell' : prof.strength === 'high' ? 'near' : 'neutral'}">${MONTHS[m]}${m === nextM ? ' · next?' : ''}</span>`).join(' ');
  const hold = state.holdings.find((h) => baseSym(h.name) === key);
  const portBlock = hold ? `<div class="metric good" style="margin-top:12px"><div class="m-label">Your portfolio</div>
      <div class="m-val sm">${esc(hold.name)} · ${hold.balance} shares</div>
      <div class="m-hint">Avg DPS set: Rs ${fmt(hold.avgDps)} · Est/year ~ Rs ${fmt(hold.balance * hold.avgDps)}</div></div>` : '';

  box.innerHTML = `
    <div class="metric-grid" style="margin-bottom:14px">
      <div class="metric"><div class="m-label">Company</div><div class="m-val t-gold">${esc(key)}</div><div class="m-hint">${esc(prof.name)}</div></div>
      <div class="metric"><div class="m-label">Pattern strength</div><div class="m-val" style="color:${strColor}">${esc((prof.strength || '').toUpperCase())}</div><div class="m-hint">${esc(prof.freq)}</div></div>
      <div class="metric"><div class="m-label">Likely next window</div><div class="m-val sm">${nextM ? MONTHS[nextM] + ' ' + nextY : '—'}</div><div class="m-hint">Estimate only · confirm CSE</div></div>
      <div class="metric"><div class="m-label">Typical DPS note</div><div class="m-val text">${esc(prof.typicalDps || '—')}</div></div>
    </div>
    <div class="section-title">Past pattern months (when they often paid)</div>
    <div class="pill-row">${pills || '—'}</div>
    <div class="tip">${esc(prof.note)}</div>
    ${portBlock}
    <div class="panel-actions" style="margin-top:14px">
      <a class="btn primary" target="_blank" rel="noopener" href="${historyUrl(key)}">Full DPS history ↗</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="${CSE_DIV_URL}">CSE cash dividends</a>
      <button class="btn ghost" type="button" data-apply-month="${esc(key)}" data-month="${months[0] || 0}">Apply typical month → portfolio</button>
    </div>
    <div class="legend">This analysis is based on history patterns — not a guarantee. Confirm official XD/announcement on the CSE.</div>`;
}

function applyMonth(sym, month) {
  let n = 0;
  state.holdings.forEach((h) => {
    if (baseSym(h.name) === sym) { if (!h.divMonth) h.divMonth = month; n++; }
  });
  if (n) { commit('holdings'); toast(`Typical month ${MONTHS[month]} → ${n} holding(s)`); } else toast('That symbol is not in your portfolio — add it manually in the setup table');
}

/* ---------- seasonality ---------- */

function renderSeasonality() {
  const maxScore = Math.max(...Object.values(SEASON).map((rows) => rows.reduce((s, r) => s + (r[3] === 'high' ? 3 : r[3] === 'med' ? 2 : 1), 0)));
  let heat = '';
  for (let m = 1; m <= 12; m++) {
    const rows = SEASON[m] || [];
    const score = rows.reduce((s, r) => s + (r[3] === 'high' ? 3 : r[3] === 'med' ? 2 : 1), 0);
    const pct = Math.round((score / maxScore) * 100);
    const lvl = pct > 60 ? 'lvl-hi' : pct > 30 ? 'lvl-mid' : '';
    heat += `<button type="button" class="heat-cell ${lvl}" data-month="${m}" aria-pressed="${m === selectedMonth}" aria-label="${MONTHS[m]}: ${rows.length} companies">
      <span class="m">${MONTHS[m]}</span><span class="n">${rows.length} names</span><span class="bar"><span style="width:${pct}%"></span></span></button>`;
  }
  $('#yearHeat').innerHTML = heat;

  $('#monthBtns').innerHTML = MONTHS.slice(1).map((name, i) =>
    `<button type="button" class="btn ${i + 1 === selectedMonth ? 'primary' : 'ghost'}" data-month="${i + 1}" aria-pressed="${i + 1 === selectedMonth}">${name}</button>`).join('');

  const rows = [...(SEASON[selectedMonth] || [])].sort((a, b) => STRENGTH_ORDER[a[3]] - STRENGTH_ORDER[b[3]]);
  if (!rows.length) { $('#seasonList').innerHTML = emptyHtml('No pattern data for this month'); return; }
  const mine = new Set(state.holdings.map((h) => baseSym(h.name)));
  $('#seasonList').innerHTML = `
    <p class="hint" style="margin:0 0 10px"><b style="color:var(--ink)">${MONTHS[selectedMonth]}</b> — likely dividend companies from past pattern (${rows.length})</p>
    <div class="table-wrap"><table class="data-table sticky-first" style="min-width:600px">
      <thead><tr><th scope="col">Symbol</th><th scope="col" class="left">Company</th><th scope="col">Pattern</th><th scope="col" class="left">Note</th><th scope="col"><span class="sr-only">Link</span></th></tr></thead>
      <tbody>${rows.map(([sym, name, note, str]) => `<tr>
        <td class="sym-strong">${esc(sym)}${mine.has(sym) ? ' <span class="badge port">YOURS</span>' : ''}</td>
        <td class="text">${esc(name)}</td>
        <td><span class="pill ${strengthPill(str)}">${esc(str.toUpperCase())}</span></td>
        <td class="text">${esc(note)}</td>
        <td><a href="${historyUrl(sym)}" target="_blank" rel="noopener">History ↗</a></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

/* ---------- live dividend mentions ---------- */

/** Pull DPS / per-share amounts out of announcement titles when present. */
function extractDivAmount(text) {
  const s = String(text || '');
  const patterns = [
    /(?:Rs\.?|LKR|රු\.?)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:per\s*share|\/\s*share|a share|per ordinary share)?/i,
    /([0-9]+(?:\.[0-9]+)?)\s*(?:Rs\.?|LKR)\s*(?:per\s*share|\/\s*share)?/i,
    /(?:DPS|dividend(?:\s+per\s+share)?)\s*(?:of|:)?\s*(?:Rs\.?|LKR)?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /([0-9]+(?:\.[0-9]+)?)\s*cents?\s*per\s*share/i,
    /cash\s+dividend\s+of\s+(?:Rs\.?|LKR)?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /interim\s+dividend\s+(?:of\s+)?(?:Rs\.?|LKR)?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /final\s+dividend\s+(?:of\s+)?(?:Rs\.?|LKR)?\s*([0-9]+(?:\.[0-9]+)?)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 100000) {
        const cents = /cents?/i.test(m[0]);
        return cents ? `Rs ${(n / 100).toFixed(2)} / share` : `Rs ${fmt(n)} / share`;
      }
    }
  }
  return null;
}

let cseCashDivCache = [];
let cseCashDivAt = 0;

/** Official CSE cash-dividend rows (amount often only inside the PDF, not the API). */

async function enrichAmountsFromNews(cseRows) {
  // Use already-loaded newsCache; also pull a focused google query once
  const pool = [...(state.newsCache || [])];
  try {
    const data = await news('google', { q: 'CSE "cash dividend" OR "per share" Colombo' });
    const items = data.items || data || [];
    if (Array.isArray(items)) pool.push(...items);
  } catch { /* optional */ }

  for (const row of cseRows) {
    if (row.amount) continue;
    const company = (row.company || '').toLowerCase();
    const short = company.replace(/\s+plc\.?$/, '').trim();
    if (short.length < 4) continue;
    for (const it of pool) {
      const title = `${it.title || ''} ${it.summary || ''}`;
      if (!title.toLowerCase().includes(short.slice(0, Math.min(12, short.length)))) continue;
      const amt = extractDivAmount(title);
      if (amt) {
        row.amount = amt;
        if (it.link) row.link = it.link;
        break;
      }
    }
  }
  return cseRows;
}

async function loadCseCashDividends(force = false) {
  if (!force && Date.now() - cseCashDivAt < 120000 && cseCashDivCache.length) return cseCashDivCache;
  try {
    const data = await cse('approvedAnnouncement');
    const rows = (data.approvedAnnouncements || []).filter((x) =>
      /cash\s*dividend/i.test(x.announcementCategory || '')
    );
    // Map to objects that can hold amount
    const mapped = rows.map((x) => ({ ...x }));
    await enrichAmountsFromNews(
      mapped.map((x) => ({
        company: x.company,
        amount: x.allotment ? String(x.allotment) : null,
        link: null,
        _raw: x,
      }))
    ).then((enriched) => {
      enriched.forEach((e, i) => {
        if (e.amount && !mapped[i].allotment) mapped[i]._amountHint = e.amount;
        if (e.link) mapped[i]._newsLink = e.link;
      });
    });
    cseCashDivCache = mapped;
    cseCashDivAt = Date.now();
  } catch (err) {
    console.warn('CSE cash dividends', err);
  }
  return cseCashDivCache;
}

function renderLiveDividends() {
  const el = $('#liveDivList');
  if (!el) return;

  const newsRows = state.newsCache
    .filter((it) => it.kind === 'div' || /dividend|xd date|x-div|cash dividend|interim dividend|final dividend|ලාභාංශ/i.test(`${it.title} ${it.source}`))
    .map((it) => ({
      kind: 'news',
      title: it.title,
      link: it.link,
      source: it.source || 'News',
      symbol: it.symbol,
      date: it.pubDate,
      amount: extractDivAmount(it.title),
    }));

  const cseRows = cseCashDivCache.map((x) => {
    const title = `${x.company || 'Company'} — Cash dividend` +
      (x.xd ? ` · XD ${x.xd}` : '') +
      (x.paymentDate ? ` · Pay ${x.paymentDate}` : '') +
      (x.allotment ? ` · ${x.allotment}` : '');
    const amount = x.allotment
      ? (String(x.allotment).match(/rs|lkr|[0-9]/i) ? String(x.allotment) : `Rs ${x.allotment}`)
      : (x._amountHint || extractDivAmount(x.remarks || '') || null);
    return {
      kind: 'cse',
      title,
      link: x._newsLink || CSE_DIV_URL,
      source: 'CSE announcement',
      symbol: x.symbol,
      company: x.company,
      date: x.dateOfAnnouncement || x.createdDate,
      amount,
      xd: x.xd,
      pay: x.paymentDate,
    };
  });

  // Merge: CSE official first, then news (dedupe rough by company+date)
  const seen = new Set();
  const rows = [];
  for (const it of [...cseRows, ...newsRows]) {
    const key = `${(it.company || it.symbol || it.title || '').toLowerCase()}|${it.date || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(it);
    if (rows.length >= 30) break;
  }

  if (!rows.length) {
    el.innerHTML = emptyHtml(
      state.newsCache.length || cseCashDivCache.length
        ? 'No dividend-related announcements yet.'
        : 'Loading announcements… use <strong>↻ Refresh</strong> if empty.'
    );
    return;
  }

  const mine = new Set(state.holdings.map((h) => baseSym(h.name)).filter(Boolean));
  el.innerHTML = `<div class="news-list">${rows.map((it) => {
    const sym = baseSym(it.symbol);
    const link = safeUrl(it.link) || CSE_DIV_URL;
    const amt = it.amount
      ? `<div class="div-amt"><b>${esc(it.amount)}</b></div>`
      : `<div class="div-amt muted">Amount: see announcement PDF / CSE</div>`;
    return `<article class="news-item compact">
      <div class="ni-body">
        <a class="title" href="${esc(link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        ${amt}
        <div class="news-meta"><span class="badge cse">${it.kind === 'cse' ? 'CSE CASH DIVIDEND' : 'DIVIDEND / NEWS'}</span>
          ${sym && mine.has(sym) ? '<span class="badge port">YOUR PORTFOLIO</span>' : ''}
          ${sym ? `<b class="t-gold">${esc(sym)}</b>` : ''}</div>
        <div class="news-source-row"><span class="src-dot"></span><span>${esc(it.source)}</span></div>
      </div>
      <div class="ni-side"><span class="ni-time">${esc(fmtDate(it.date))}</span>
        <a class="btn ghost sm" href="${esc(link)}" target="_blank" rel="noopener">Open ↗</a></div>
    </article>`;
  }).join('')}</div>
  <p class="legend" style="margin-top:8px">If amount is missing, open the CSE PDF — the feed often has the company name only. Log DPS in <b>Event log</b> when you know it.</p>`;
}

/* ---------- setup, forecast, events ---------- */

function renderSetup() {
  let totalEst = 0;
  const html = state.holdings.map((h, i) => {
    const est = h.balance * h.avgDps;
    totalEst += est;
    const yoc = h.totalCost > 0 && h.avgDps > 0 ? (est / h.totalCost) * 100 : 0;
    return `<tr>
      <td class="sym-strong">${esc(h.name || '—')}</td>
      <td>${h.balance}</td>
      <td><input class="cell" data-key="d${i}:avgDps" data-i="${i}" data-f="avgDps" value="${h.avgDps}" inputmode="decimal" style="max-width:76px" aria-label="Average DPS for ${esc(h.name)}"></td>
      <td><input class="cell" data-key="d${i}:divMonth" data-i="${i}" data-f="divMonth" value="${h.divMonth}" inputmode="numeric" style="max-width:54px" title="1-12" aria-label="Typical month (1-12) for ${esc(h.name)}"></td>
      <td class="t-gold"><b>Rs ${fmt(est)}</b></td>
      <td class="${yoc > 0 ? 't-pos' : 't-muted'}">${yoc ? fmtPct(yoc) : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-row">No shares in portfolio yet. Add holdings in the <b>Portfolio</b> tab first, then come back to set Avg DPS.</td></tr>';
  renderPreservingFocus($('#divSetupBody'), html);
  return totalEst;
}

function renderForecast() {
  const now = new Date();
  const items = state.holdings
    .filter((h) => h.avgDps > 0 && h.divMonth >= 1 && h.divMonth <= 12)
    .map((h) => {
      const year = h.divMonth < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
      return { name: h.name, month: h.divMonth, year, amt: h.balance * h.avgDps };
    })
    .sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));
  $('#divForecast').innerHTML = items.length
    ? items.map((it) => `<div class="res-row"><span class="l"><b>${esc(it.name)}</b> · ~${MONTHS[it.month]} ${it.year}</span><span class="v t-pos">~ Rs ${fmt(it.amt)}</span></div>`).join('')
    : '<div class="res-row"><span class="l">Enter Avg DPS + typical month to see forecast</span><span class="v">—</span></div>';
}

function renderEvents() {
  const body = $('#divEventBody');
  if (!state.divEvents.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-row">No events — click "+ Event"</td></tr>';
    return;
  }
  const txt = (i, f, v, w, ph = '') => `<input class="cell text-cell" data-key="e${i}:${f}" data-ei="${i}" data-ef="${f}" value="${esc(v)}" placeholder="${ph}" style="max-width:${w}px" aria-label="${f}">`;
  const html = state.divEvents.map((ev, i) => ({ ev, i })).reverse().map(({ ev, i }) => {
    const hold = state.holdings.find((h) => h.name === ev.symbol);
    const income = hold ? hold.balance * ev.dps : 0;
    return `<tr>
      <td>${txt(i, 'symbol', ev.symbol, 110, 'SYMBOL')}</td>
      <td><input class="cell" data-key="e${i}:dps" data-ei="${i}" data-ef="dps" value="${ev.dps}" inputmode="decimal" aria-label="DPS"></td>
      <td>${txt(i, 'type', ev.type, 84)}</td>
      <td>${txt(i, 'xd', ev.xd, 104, 'YYYY-MM-DD')}</td>
      <td>${txt(i, 'pay', ev.pay, 104, 'YYYY-MM-DD')}</td>
      <td><select class="select" data-key="e${i}:status" data-ei="${i}" data-ef="status" aria-label="Status" style="padding:5px 8px">
        <option ${ev.status !== 'Paid' ? 'selected' : ''}>Announced</option><option ${ev.status === 'Paid' ? 'selected' : ''}>Paid</option></select></td>
      <td class="t-gold">${hold ? '~Rs ' + fmt(income) : '—'}</td>
      <td><button class="del" type="button" data-edel="${i}" aria-label="Delete event">&times;</button></td>
    </tr>`;
  }).join('');
  renderPreservingFocus(body, html);
}


/** Fill avgDps + typicalMonth from DIV_PROFILE when holding has no DPS yet. */
function autoFillFromProfiles({ force = false } = {}) {
  let months = 0;
  let dpsN = 0;
  for (const h of state.holdings) {
    const base = baseSym(h.name || '');
    const prof = DIV_PROFILE[base];
    if (!prof) continue;
    if (prof.months?.length && (!h.divMonth || force)) {
      h.divMonth = prof.months[0];
      months++;
    }
    // typicalDps is often a note, not a number — only apply real numeric values
    const dps = num(String(prof.typicalDps || '').replace(/[^0-9.]/g, ''), 0);
    if (dps > 0 && (force || !(h.avgDps > 0))) {
      h.avgDps = dps;
      dpsN++;
    }
  }
  if (months || dpsN) {
    commit('holdings');
    toast(`Smart fill: ${months} typical month(s)` + (dpsN ? `, ${dpsN} DPS value(s)` : '') + '. Set Avg DPS from dividend history if still empty.');
  } else {
    toast('No profile match — research a symbol above, or type Avg DPS from past years (history link).');
  }
  render();
}

export function render() {
  renderSeasonality();
  loadCseCashDividends().then(() => renderLiveDividends()).catch(() => renderLiveDividends());
  renderLiveDividends();
  const totalEst = renderSetup();
  renderForecast();
  renderEvents();
  const open = state.divEvents.filter((e) => e.status !== 'Paid').length;
  $('#divSummary').innerHTML = `
    <div class="card"><div class="label">Est. annual dividends</div><div class="value pos">Rs ${fmt(totalEst)}</div><div class="hint">balance × avg DPS</div></div>
    <div class="card"><div class="label">Logged events</div><div class="value">${state.divEvents.length}</div><div class="hint">${open} open / announced</div></div>
    <div class="card"><div class="label">Holdings tracked</div><div class="value">${state.holdings.filter((h) => h.avgDps > 0).length}</div><div class="hint">with DPS set</div></div>
    <div class="card"><div class="label">Research</div><div class="value" style="font-size:14px"><a href="https://stockdividends.iamsupun.com/stocks/" target="_blank" rel="noopener">History →</a></div><div class="hint">past years DPS</div></div>`;
}

/* ---------- wiring ---------- */

export function init() {
  $('#divSearchForm').addEventListener('submit', (e) => { e.preventDefault(); analyse($('#divSearchBox').value); });
  $('#divSearchResult').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-analyse]');
    if (pick) { $('#divSearchBox').value = pick.dataset.analyse; analyse(pick.dataset.analyse); }
    const apply = e.target.closest('[data-apply-month]');
    if (apply) applyMonth(apply.dataset.applyMonth, +apply.dataset.month);
  });

  const pickMonth = (e) => {
    const b = e.target.closest('[data-month]');
    if (!b) return;
    selectedMonth = +b.dataset.month;
    renderSeasonality();
    if (e.currentTarget.id === 'yearHeat') $('#seasonPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#yearHeat').addEventListener('click', pickMonth);
  
  $('#monthBtns').addEventListener('click', pickMonth);
  $('#divAutoFillBtn')?.addEventListener('click', () => autoFillFromProfiles({ force: false }));
  $('#divLiveRefresh')?.addEventListener('click', async () => {
    const btn = $('#divLiveRefresh');
    setBusy(btn, true);
    try {
      await loadNews({ force: true });
      await loadCseCashDividends(true);
      renderLiveDividends();
      toast('Announcements refreshed');
    } catch (err) {
      toast(err.message || 'Refresh failed', { error: true });
    } finally {
      setBusy(btn, false);
    }
  });
  document.querySelectorAll('[data-div-sym]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sym = btn.getAttribute('data-div-sym');
      $('#divSearchBox').value = sym;
      analyse(sym);
      $('#divSearchResult')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  $('#divSetupBody').addEventListener('change', (e) => {
    const inp = e.target.closest('input.cell');
    const h = inp && state.holdings[+inp.dataset.i];
    if (!h) return;
    let v = num(inp.value);
    if (inp.dataset.f === 'divMonth') v = Math.max(0, Math.min(12, Math.round(v)));
    h[inp.dataset.f] = v;
    setTimeout(() => commit('holdings'), 0);
  });

  const events = $('#divEventBody');
  events.addEventListener('change', (e) => {
    const el = e.target.closest('[data-ef]');
    const ev = el && state.divEvents[+el.dataset.ei];
    if (!ev) return;
    const f = el.dataset.ef;
    if (f === 'dps') ev.dps = num(el.value);
    else if (f === 'symbol') ev.symbol = el.value.trim().toUpperCase().slice(0, 24);
    else if (f === 'status') ev.status = el.value === 'Paid' ? 'Paid' : 'Announced';
    else ev[f] = el.value.trim().slice(0, 20);
    setTimeout(() => commit('divEvents'), 0);
  });
  events.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-edel]');
    if (!btn) return;
    if (!(await confirmDialog('Delete this dividend event?', '', { confirmLabel: 'Delete', danger: true }))) return;
    state.divEvents.splice(+btn.dataset.edel, 1);
    commit('divEvents');
  });
  $('#addDivEventBtn').addEventListener('click', () => {
    state.divEvents.push({ symbol: '', dps: 0, type: 'Final', xd: '', pay: '', status: 'Announced' });
    commit('divEvents');
    requestAnimationFrame(() => events.querySelector('input')?.focus());
  });
  $('#refreshDivLiveBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // currentTarget is null after the await
    setBusy(btn, true);
    await loadNews();
    setBusy(btn, false);
    renderLiveDividends();
    toast('Dividend feed updated');
  });
}

/** On open: render now, and pull news in the background for the live dividend list. */
export function show() {
  render();
  if (!state.newsCache.length && state.live !== 'down') loadNews().catch(() => {});
}

export default { init, render, show };
