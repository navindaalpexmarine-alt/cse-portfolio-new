/**
 * Transaction log with realized P/L (average-cost method).
 * Logging a BUY/SELL also updates the matching holding.
 */
import { commit, state } from '../core/store.js';
import { calcBes, normalizeSymbol } from '../core/finance.js';
import { $, esc, fmt, num, round2, todayISO, download, toCsv } from '../core/utils.js';
import { confirmDialog, toast } from '../core/ui.js';

/** Average cost per share for a symbol: current holding first, else logged buys. */
function costBasisForSymbol(sym) {
  const h = state.holdings.find((x) => x.name === sym);
  if (h && h.balance > 0 && h.totalCost > 0) return h.totalCost / h.balance;
  let qty = 0, cost = 0;
  state.transactions.filter((t) => t.symbol === sym && t.type === 'buy').forEach((t) => { qty += t.qty; cost += t.net; });
  return qty > 0 ? cost / qty : 0;
}

export function render() {
  let realized = 0, buyN = 0, sellN = 0, buyVol = 0, sellVol = 0;
  state.transactions.forEach((t) => {
    if (t.type === 'buy') { buyN++; buyVol += t.net; } else { sellN++; sellVol += t.net; realized += t.realized; }
  });
  const pos = realized >= 0;
  $('#histSummary').innerHTML = `
    <div class="card"><div class="label">Realized P/L</div><div class="value ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}Rs ${fmt(realized)}</div></div>
    <div class="card"><div class="label">Buys</div><div class="value">${buyN}</div><div class="hint">Rs ${fmt(buyVol)} net</div></div>
    <div class="card"><div class="label">Sells</div><div class="value">${sellN}</div><div class="hint">Rs ${fmt(sellVol)} net</div></div>
    <div class="card"><div class="label">Open positions</div><div class="value">${state.holdings.length}</div><div class="hint">unrealized in Portfolio</div></div>`;

  const body = $('#txBody');
  if (!state.transactions.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty-row">Transactions නෑ — උඩින් log කරන්න</td></tr>';
    return;
  }
  // Newest first, but keep the real index for deletion.
  body.innerHTML = state.transactions.map((t, i) => ({ t, i })).reverse().map(({ t, i }) => {
    const real = t.type === 'sell' ? t.realized : null;
    return `<tr>
      <td class="left">${esc(t.date)}</td>
      <td class="left"><span class="pill ${t.type === 'buy' ? 'near' : 'sell'}">${t.type.toUpperCase()}</span></td>
      <td class="left sym-strong">${esc(t.symbol)}</td>
      <td>${t.qty}</td><td>${fmt(t.price)}</td><td>${fmt(t.gross)}</td><td>${fmt(t.fee)}</td><td>${fmt(t.net)}</td>
      <td class="${real == null ? 't-muted' : real >= 0 ? 't-pos' : 't-neg'}"><b>${real == null ? '—' : (real >= 0 ? '+' : '') + fmt(real)}</b></td>
      <td class="text">${esc(t.note)}</td>
      <td><button class="del" type="button" data-txdel="${i}" aria-label="Delete transaction">&times;</button></td>
    </tr>`;
  }).join('');
}

async function addTransaction(e) {
  e.preventDefault();
  const type = $('#txType').value === 'sell' ? 'sell' : 'buy';
  const symbol = normalizeSymbol($('#txSym').value).slice(0, 24);
  const qty = num($('#txQty').value);
  const price = num($('#txPrice').value);
  const date = $('#txDate').value || todayISO();
  const note = $('#txNote').value.trim().slice(0, 200);
  if (!symbol || qty <= 0 || price <= 0) { toast('Symbol, qty, price අවශ්‍යයි', { error: true }); return; }

  const rate = state.commissionRate;
  const gross = qty * price;
  const fee = gross * (rate / 100);
  const net = type === 'buy' ? gross + fee : gross - fee;
  const h = state.holdings.find((x) => x.name === symbol);

  if (type === 'sell' && (!h || qty > h.balance)) {
    const ok = await confirmDialog('Sell more than you hold?',
      `Portfolio shows ${h ? h.balance : 0} ${symbol}. Log this SELL of ${qty} anyway?`, { confirmLabel: 'Log anyway' });
    if (!ok) return;
  }
  const realized = type === 'sell' ? net - costBasisForSymbol(symbol) * qty : 0;
  state.transactions.push({ type, symbol, qty, price, gross, fee, net, realized, date, note, ts: Date.now() });

  // Keep holdings in sync (average-cost method).
  if (type === 'buy') {
    if (!h) {
      state.holdings.push({ name: symbol, balance: qty, avgPrice: net / qty, besPrice: calcBes(net / qty, rate), totalCost: round2(net), tradedPrice: price, avgDps: 0, divMonth: 0 });
    } else {
      const newBal = h.balance + qty;
      const newCost = h.totalCost + net;
      Object.assign(h, { balance: newBal, totalCost: round2(newCost), avgPrice: newBal ? newCost / newBal : 0 });
      h.besPrice = calcBes(h.avgPrice, rate);
    }
  } else if (h) {
    const newBal = Math.max(0, h.balance - qty);
    if (newBal === 0) state.holdings = state.holdings.filter((x) => x !== h);
    else { h.totalCost = round2(h.totalCost * (newBal / h.balance)); h.balance = newBal; }
  }
  commit('transactions');
  toast(type === 'buy' ? 'Buy logged ✓' : `Sell logged · realized ${fmt(realized)}`);
  $('#txNote').value = '';
}

function exportCsv() {
  const rows = [['Date', 'Type', 'Symbol', 'Qty', 'Price', 'Gross', 'Fee', 'Net', 'Realized', 'Note']];
  state.transactions.forEach((t) => rows.push([t.date, t.type.toUpperCase(), t.symbol, t.qty, t.price, t.gross.toFixed(2), t.fee.toFixed(2), t.net.toFixed(2), t.type === 'sell' ? t.realized.toFixed(2) : '', t.note]));
  download(`transactions_${todayISO()}.csv`, '﻿' + toCsv(rows), 'text/csv;charset=utf-8');
}

export function init() {
  $('#txDate').value = todayISO();
  $('#txForm').addEventListener('submit', addTransaction);
  $('#txExportBtn').addEventListener('click', exportCsv);
  $('#txBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-txdel]');
    if (!btn) return;
    if (!(await confirmDialog('Delete this transaction?', 'Holdings are not changed back automatically.', { confirmLabel: 'Delete', danger: true }))) return;
    state.transactions.splice(+btn.dataset.txdel, 1);
    commit('transactions');
  });
  $('#txClearBtn').addEventListener('click', async () => {
    if (!state.transactions.length) return;
    if (!(await confirmDialog('Clear all transactions?', 'This cannot be undone. Export a CSV first if you need it.', { confirmLabel: 'Clear all', danger: true }))) return;
    state.transactions = [];
    commit('transactions');
    toast('History cleared');
  });
}

export default { init, render };
