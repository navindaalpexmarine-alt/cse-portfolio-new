/**
 * Buy / Sell calculator with break-even price and profit check.
 */
import { state } from '../core/store.js';
import { $, fmt, num } from '../core/utils.js';

let mode = 'buy';

const row = (label, value, cls = '') => `<div class="res-row ${cls}"><span class="l">${label}</span><span class="v">${value}</span></div>`;

export function render() {
  const qty = num($('#cQty').value);
  const price = num($('#cPrice').value);
  const rate = state.commissionRate;
  const gross = qty * price;
  const fee = gross * (rate / 100);
  const be = $('#cBe');
  const pl = $('#cPL');

  if (mode === 'buy') {
    const total = gross + fee;
    const cps = qty > 0 ? total / qty : 0;
    const factor = 1 - rate / 100;
    const bePrice = qty > 0 && factor > 0 ? total / (qty * factor) : 0;
    $('#cResults').innerHTML =
      row('Gross (qty × price)', `Rs ${fmt(gross)}`) +
      row(`Commission (${fmt(rate)}%)`, `+ Rs ${fmt(fee)}`, 'neg') +
      row('මුළු Cost (ඔයාගෙන් යනවා)', `Rs ${fmt(total)}`, 'hi') +
      row('Cost / share', `Rs ${fmt(cps)}`);
    be.hidden = false;
    be.innerHTML = `<div class="t">Break-even Sell Price</div><div class="p">Rs ${fmt(bePrice)}</div>
      <div class="n">මේකට උඩින් විකුණුවොත් (sell commission එක්ක) loss නෑ.</div>`;
    pl.innerHTML = row('SELL tab එකේ profit බලන්න', '—');
    return;
  }

  const net = gross - fee;
  $('#cResults').innerHTML =
    row('Gross (qty × sell)', `Rs ${fmt(gross)}`) +
    row(`Commission (${fmt(rate)}%)`, `− Rs ${fmt(fee)}`, 'neg') +
    row('Net (ඔයාට ලැබෙනවා)', `Rs ${fmt(net)}`, 'hi pos') +
    row('Net / share', `Rs ${fmt(qty > 0 ? net / qty : 0)}`);
  be.hidden = true;

  const buyCost = num($('#cBuyCost').value, NaN);
  if (!(buyCost > 0)) {
    pl.innerHTML = row('Buy cost දැම්මොත් P/L පෙනෙනවා', '—');
    return;
  }
  const gl = net - buyCost;
  const pct = (gl / buyCost) * 100;
  const pos = gl >= 0;
  pl.innerHTML =
    row('Buy cost', `Rs ${fmt(buyCost)}`) +
    row(pos ? 'Profit' : 'Loss', `${pos ? '+' : ''}Rs ${fmt(gl)}`, pos ? 'pos' : 'neg') +
    row(`${pos ? 'Profit' : 'Loss'} %`, `${pos ? '+' : ''}${pct.toFixed(2)}%`, pos ? 'pos' : 'neg');
}

function setMode(m) {
  mode = m;
  const buy = $('#cTabBuy'), sell = $('#cTabSell');
  buy.className = 'calc-tab' + (m === 'buy' ? ' on-buy' : '');
  sell.className = 'calc-tab' + (m === 'sell' ? ' on-sell' : '');
  buy.setAttribute('aria-checked', String(m === 'buy'));
  sell.setAttribute('aria-checked', String(m === 'sell'));
  $('#cPriceLbl').textContent = m === 'buy' ? 'Market Price (Rs)' : 'Sell Price (Rs)';
  render();
}

export function init() {
  $('#cTabBuy').addEventListener('click', () => setMode('buy'));
  $('#cTabSell').addEventListener('click', () => setMode('sell'));
  ['#cQty', '#cPrice', '#cBuyCost'].forEach((id) => $(id).addEventListener('input', render));
}

export default { init, render };
