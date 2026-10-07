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
  if (!q) { box.innerHTML = emptyHtml('Symbol type කරන්න'); return; }

  let key = null, prof = null;
  if (DIV_PROFILE[q]) { key = q; prof = DIV_PROFILE[q]; } else {
    const hits = Object.entries(DIV_PROFILE).filter(([k, v]) => k.includes(q) || (v.name || '').toUpperCase().includes(q));
    if (hits.length === 1) [[key, prof]] = hits;
    else if (hits.length > 1) {
      box.innerHTML = emptyHtml(`ගැලපෙන symbols: ${hits.map(([k]) => `<button type="button" class="link-btn" data-analyse="${esc(k)}">${esc(k)}</button>`).join(', ')} — එකක් තෝරන්න`);
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
      <p style="margin-bottom:10px"><b>${esc(q)}</b> — built-in pattern data නෑ. Full cash-dividend history:</p>
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
    <div class="legend">මේ analysis එක history pattern මත පදනම් — guarantee නෙවෙයි. Official XD/announcement CSE එකෙන් confirm කරන්න.</div>`;
}

function applyMonth(sym, month) {
  let n = 0;
  state.holdings.forEach((h) => {
    if (baseSym(h.name) === sym) { if (!h.divMonth) h.divMonth = month; n++; }
  });
  if (n) { commit('holdings'); toast(`Typical month ${MONTHS[month]} → ${n} holding(s)`); } else toast('Portfolio එකේ ඒ symbol නෑ — setup table එකේ manually දාන්න');
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
  if (!rows.length) { $('#seasonList').innerHTML = emptyHtml('මේ month එකට pattern data නෑ'); return; }
  const mine = new Set(state.holdings.map((h) => baseSym(h.name)));
  $('#seasonList').innerHTML = `
    <p class="hint" style="margin:0 0 10px"><b style="color:var(--ink)">${MONTHS[selectedMonth]}</b> — past pattern එකෙන් likely dividend companies (${rows.length})</p>
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

function renderLiveDividends() {
  const el = $('#liveDivList');
  const rows = state.newsCache.filter((it) => it.kind === 'div' || /dividend|xd date|x-div|cash dividend|interim dividend|final dividend|ලාභාංශ/i.test(`${it.title} ${it.source}`)).slice(0, 25);
  if (!rows.length) {
    el.innerHTML = emptyHtml(state.newsCache.length ? 'Dividend-related announcements තවම නෑ.' : 'News load වෙලා නෑ — <strong>↻ Refresh</strong> click කරන්න.');
    return;
  }
  const mine = new Set(state.holdings.map((h) => baseSym(h.name)).filter(Boolean));
  el.innerHTML = `<div class="news-list">${rows.map((it) => {
    const sym = baseSym(it.symbol);
    const link = safeUrl(it.link);
    return `<article class="news-item compact">
      <div class="ni-body">
        <a class="title" href="${esc(link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <div class="news-meta"><span class="badge cse">DIVIDEND / CSE</span>
          ${sym && mine.has(sym) ? '<span class="badge port">YOUR PORTFOLIO</span>' : ''}
          ${sym ? `<b class="t-gold">${esc(sym)}</b>` : ''}</div>
        <div class="news-source-row"><span class="src-dot"></span><span>${esc(it.source)}</span></div>
      </div>
      <div class="ni-side"><span class="ni-time">${esc(fmtDate(it.pubDate))}</span>
        <a class="btn ghost sm" href="${esc(link)}" target="_blank" rel="noopener">Open ↗</a></div>
    </article>`;
  }).join('')}</div>`;
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
  }).join('') || '<tr><td colspan="6" class="empty-row">Portfolio එකේ shares නෑ</td></tr>';
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
    : '<div class="res-row"><span class="l">Avg DPS + typical month දැම්මොත් forecast පෙනෙනවා</span><span class="v">—</span></div>';
}

function renderEvents() {
  const body = $('#divEventBody');
  if (!state.divEvents.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-row">Events නෑ — "+ Event" click කරන්න</td></tr>';
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

export function render() {
  renderSeasonality();
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
