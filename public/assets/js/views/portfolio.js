/**
 * Portfolio view: summary cards, editable holdings table, ATrade import, CSV export.
 */
import { commit, state } from '../core/store.js';
import { calcBes, computeRow, normalizeSymbol, STATUS_LABEL, syncCost, totals } from '../core/finance.js';
import { $, esc, fmt, fmtPct, num, round2, todayISO, download, toCsv } from '../core/utils.js';
import { choose, confirmDialog, alertDialog, renderPreservingFocus, toast } from '../core/ui.js';
import { ensureXLSX } from '../core/loader.js';
import { refreshPrices } from '../core/prices.js';

let searchQuery = '';
let sortMode = 'default';

/* ---------- rendering ---------- */

function displayList() {
  const rate = state.commissionRate;
  let list = state.holdings.map((h, idx) => ({ h, idx, c: computeRow(h, rate) }));
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter((x) => (x.h.name || '').toLowerCase().includes(q) || (state.priceMap[x.h.name]?.name || '').toLowerCase().includes(q));
  }
  const totalMV = list.reduce((s, x) => s + x.c.marketValue, 0);
  const rank = { sell: 0, near: 1, hold: 2 };
  const sorters = {
    gain: (a, b) => b.c.gainLoss - a.c.gainLoss,
    loss: (a, b) => a.c.gainLoss - b.c.gainLoss,
    alloc: (a, b) => b.c.marketValue - a.c.marketValue,
    status: (a, b) => rank[a.c.status] - rank[b.c.status],
    name: (a, b) => (a.h.name || '').localeCompare(b.h.name || ''),
  };
  if (sorters[sortMode]) list.sort(sorters[sortMode]);
  return { list, totalMV };
}

const cellInput = (idx, field, value, extra = '', label = '') =>
  `<input class="cell ${extra}" data-key="${idx}:${field}" data-i="${idx}" data-f="${field}" value="${esc(value)}"
    inputmode="${field === 'name' ? 'text' : 'decimal'}" autocomplete="off" aria-label="${esc(label)}">`;

function rowHtml({ h, idx, c }, totalMV) {
  const live = state.priceMap[(h.name || '').toUpperCase().trim()];
  const hasLive = live?.price != null;
  let chg = '';
  if (hasLive && live.changePct != null) {
    const up = live.changePct >= 0;
    chg = `<span class="chg ${up ? 'up' : 'down'}">${up ? '+' : ''}${Number(live.changePct).toFixed(1)}%</span>`;
  }
  const alloc = totalMV > 0 ? (c.marketValue / totalMV) * 100 : 0;
  const glCls = c.gainLoss >= 0 ? 't-pos' : 't-neg';
  const sign = c.gainLoss >= 0 ? '+' : '';
  const nm = h.name || 'new share';
  const rowCls = c.status === 'sell' ? 'sell-row' : c.status === 'near' ? 'near-row' : '';
  return `<tr class="${rowCls}">
    <td><div class="sym-cell">
      ${cellInput(idx, 'name', h.name, 'text-cell', 'Symbol')}
      ${live?.name ? `<span class="sym-full" title="${esc(live.name)}">${esc(live.name)}</span>` : ''}
    </div></td>
    <td>${cellInput(idx, 'balance', h.balance, '', `Balance for ${nm}`)}</td>
    <td>${cellInput(idx, 'avgPrice', h.avgPrice, '', `Average price for ${nm}`)}</td>
    <td>${cellInput(idx, 'besPrice', h.besPrice, '', `Break-even sell for ${nm}`)}</td>
    <td>${cellInput(idx, 'totalCost', h.totalCost, '', `Total cost for ${nm}`)}</td>
    <td>${cellInput(idx, 'tradedPrice', h.tradedPrice, hasLive ? 'live' : '', `Market price for ${nm}`)}${chg}</td>
    <td>${fmt(c.marketValue)}</td>
    <td>${fmt(c.netProceeds)}</td>
    <td class="${glCls}"><b>${sign}${fmt(c.gainLoss)}</b></td>
    <td class="${glCls}"><b>${sign}${fmtPct(c.gainLossPct)}</b></td>
    <td style="min-width:70px">${fmtPct(alloc)}<div class="alloc-bar"><span style="width:${Math.min(100, alloc)}%"></span></div></td>
    <td><span class="pill ${c.status}">${STATUS_LABEL[c.status]}</span></td>
    <td><button class="del" type="button" data-del="${idx}" aria-label="Delete ${esc(nm)}">&times;</button></td>
  </tr>`;
}

function renderSummary() {
  const t = totals(state.holdings, state.commissionRate);
  const pos = t.gl >= 0;
  $('#summaryCards').innerHTML = `
    <div class="card"><div class="label">Total Cost</div><div class="value">Rs ${fmt(t.cost)}</div></div>
    <div class="card"><div class="label">Market Value</div><div class="value">Rs ${fmt(t.mv)}</div></div>
    <div class="card"><div class="label">Gain / Loss</div><div class="value ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}Rs ${fmt(t.gl)}</div><div class="hint">${pos ? '+' : ''}${fmtPct(t.glPct)} after sell commission</div></div>
    <div class="card"><div class="label">Signals</div><div class="value" style="font-size:17px">${t.sell ? `<span class="t-pos">${t.sell} SELL</span>` : '—'}</div><div class="hint">${t.near ? t.near + ' near · ' : ''}${state.holdings.length} shares</div></div>`;
}

export function render() {
  renderSummary();
  const { list, totalMV } = displayList();
  renderPreservingFocus($('#tableBody'), list.map((x) => rowHtml(x, totalMV)).join(''));
  $('#emptyState').hidden = state.holdings.length > 0;
}

/* ---------- editing ---------- */

function onCellChange(e) {
  const inp = e.target.closest('input.cell');
  if (!inp) return;
  const h = state.holdings[+inp.dataset.i];
  if (!h) return;
  const f = inp.dataset.f;
  if (f === 'name') h.name = normalizeSymbol(inp.value).slice(0, 24);
  else h[f] = num(inp.value);
  if (f === 'balance' || f === 'avgPrice') syncCost(h);
  // Render after the browser has moved focus (Tab) so the new focus is preserved.
  setTimeout(() => commit('holdings'), 0);
}

async function onTableClick(e) {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const i = +btn.dataset.del;
  const h = state.holdings[i];
  if (!h) return;
  if (!(await confirmDialog(`Delete ${h.name || 'this share'}?`, `"${h.name || 'share'}" delete කරන්නද? This cannot be undone.`, { confirmLabel: 'Delete', danger: true }))) return;
  state.holdings.splice(i, 1);
  commit('holdings');
  toast('Deleted');
}

function addHolding() {
  state.holdings.push({ name: '', balance: 0, avgPrice: 0, besPrice: 0, totalCost: 0, tradedPrice: 0, avgDps: 0, divMonth: 0 });
  commit('holdings');
  requestAnimationFrame(() => {
    const ins = document.querySelectorAll('#tableBody input.text-cell');
    ins[ins.length - 1]?.focus();
  });
}

function recalcBes() {
  let n = 0;
  state.holdings.forEach((h) => { if (h.avgPrice > 0) { h.besPrice = calcBes(h.avgPrice, state.commissionRate); n++; } });
  commit('holdings');
  toast(`B.E.S updated · ${n}`);
}

/* ---------- ATrade import (Excel / CSV) ---------- */

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const numVal = (v) => (typeof v === 'number' ? (Number.isNaN(v) ? 0 : v) : num(String(v ?? '').replace(/rs\.?/gi, '').replace(/%/g, '')));

function pickCol(headers, aliases) {
  const norms = headers.map(normHeader);
  for (const a of aliases) {
    const na = normHeader(a);
    const i = norms.findIndex((h) => h && (h === na || h.includes(na) || na.includes(h)));
    if (i >= 0) return i;
  }
  return -1;
}

/** Same column detection as the original: tolerant to ATrade header variations. */
export function parseRowsToHoldings(rows, rate) {
  if (!rows || rows.length < 2) throw new Error('File එකේ data නෑ');
  let headerIdx = 0;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    if ((rows[i] || []).map(normHeader).some((c) => /security|symbol|stock|code|ticker/.test(c))) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map((h) => String(h || ''));
  const iSym = pickCol(headers, ['security', 'symbol', 'stock', 'stockcode', 'securitycode', 'code', 'ticker', 'instrument']);
  const iQty = pickCol(headers, ['quantity', 'qty', 'balance', 'available', 'availablebalance', 'cleared', 'holding', 'shares', 'netqty']);
  const iAvg = pickCol(headers, ['averageprice', 'avgprice', 'average', 'avg', 'costprice', 'buyprice', 'wavg']);
  const iBes = pickCol(headers, ['besprice', 'bes', 'breakeven', 'breakevensell', 'breakevensellingprice']);
  const iCost = pickCol(headers, ['totalcost', 'cost', 'investment', 'totalinvestment', 'bookvalue']);
  const iMkt = pickCol(headers, ['tradedprice', 'marketprice', 'lasttraded', 'ltp', 'price', 'lastprice', 'close', 'closingprice']);
  if (iSym < 0) throw new Error('Symbol / Security column හොයාගන්න බෑ. ATrade Portfolio Excel upload කරන්න.');
  if (iQty < 0) throw new Error('Quantity / Balance column හොයාගන්න බෑ.');

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const raw = String(row[iSym] || '').trim().toUpperCase();
    if (!raw || raw === 'TOTAL' || raw === 'TOTALS' || raw.startsWith('ACCOUNT')) continue;
    const name = normalizeSymbol(raw).slice(0, 24);
    const balance = numVal(row[iQty]);
    if (balance <= 0) continue;
    const avgPrice = iAvg >= 0 ? numVal(row[iAvg]) : 0;
    const besPrice = iBes >= 0 ? numVal(row[iBes]) : (avgPrice ? calcBes(avgPrice, rate) : 0);
    let totalCost = iCost >= 0 ? numVal(row[iCost]) : 0;
    if (!totalCost && avgPrice && balance) totalCost = round2(balance * avgPrice);
    const tradedPrice = iMkt >= 0 ? numVal(row[iMkt]) : avgPrice;
    out.push({ name, balance, avgPrice, besPrice, totalCost, tradedPrice, avgDps: 0, divMonth: 0 });
  }
  if (!out.length) throw new Error('Valid holdings හොයාගන්න බෑ. File columns check කරන්න.');
  return out;
}

async function importFile(file) {
  if (file.size > 10 * 1024 * 1024) { await alertDialog('File too large', 'Please choose an ATrade export under 10 MB.'); return; }
  try {
    toast('Reading file…');
    const XLSX = await ensureXLSX();
    const isCsv = /\.csv$/i.test(file.name);
    const wb = isCsv
      ? XLSX.read(await file.text(), { type: 'string' })
      : XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const parsed = parseRowsToHoldings(rows, state.commissionRate);

    const mode = await choose({
      title: `${parsed.length} shares හොයාගත්තා`,
      message: 'Replace = මුළු portfolio replace කරන්න.\nMerge = existing එකට merge කරන්න (same symbols updated, dividend settings kept).',
      choices: [
        { value: 'cancel', label: 'Cancel', kind: 'ghost' },
        { value: 'merge', label: 'Merge', kind: 'ghost' },
        { value: 'replace', label: 'Replace all', kind: 'primary' },
      ],
    });
    if (!mode || mode === 'cancel') return;
    if (mode === 'replace') {
      state.holdings = parsed;
    } else {
      const map = new Map(state.holdings.map((h, i) => [h.name, i]));
      for (const p of parsed) {
        if (map.has(p.name)) {
          const old = state.holdings[map.get(p.name)];
          state.holdings[map.get(p.name)] = { ...p, avgDps: old.avgDps, divMonth: old.divMonth };
        } else state.holdings.push(p);
      }
    }
    commit('holdings');
    toast(`ATrade import ✓ · ${parsed.length} shares`);
    refreshPrices({ silent: true });
  } catch (err) {
    console.error(err);
    await alertDialog('Import failed', err.message || String(err));
  }
}

function exportCsv() {
  const rows = [['Symbol', 'Balance', 'AvgPrice', 'BES', 'TotalCost', 'MarketPrice', 'MarketValue', 'NetProceeds', 'GainLoss', 'GainLossPct', 'Status']];
  for (const h of state.holdings) {
    const c = computeRow(h, state.commissionRate);
    rows.push([h.name, h.balance, h.avgPrice, h.besPrice, h.totalCost, h.tradedPrice,
      c.marketValue.toFixed(2), c.netProceeds.toFixed(2), c.gainLoss.toFixed(2), c.gainLossPct.toFixed(2), STATUS_LABEL[c.status]]);
  }
  download(`portfolio_${todayISO()}.csv`, '﻿' + toCsv(rows), 'text/csv;charset=utf-8');
  toast('CSV downloaded');
}

/* ---------- wiring ---------- */

export function init() {
  const tbody = $('#tableBody');
  tbody.addEventListener('change', onCellChange);
  tbody.addEventListener('click', onTableClick);
  // Enter commits a cell and moves down like a spreadsheet.
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input.cell')) return;
    e.preventDefault();
    const { i, f } = e.target.dataset;
    const rows = [...tbody.querySelectorAll(`input[data-f="${f}"]`)];
    const next = rows[rows.findIndex((x) => x.dataset.i === i) + 1];
    (next || e.target).focus();
    if (!next) e.target.blur();
  });
  $('#addBtn').addEventListener('click', addHolding);
  $('#besBtn').addEventListener('click', recalcBes);
  $('#exportBtn').addEventListener('click', exportCsv);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importFile(f);
    e.target.value = '';
  });
  $('#searchBox').addEventListener('input', (e) => { searchQuery = e.target.value.trim(); render(); });
  $('#sortSelect').addEventListener('change', (e) => { sortMode = e.target.value; render(); });
}

export default { init, render };
