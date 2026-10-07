/**
 * Header market ticker: ASPI, S&P SL20, market status, turnover, volume, trades.
 * One request to the proxy's virtual `marketOverview` endpoint.
 */
import { cse } from '../core/api.js';
import { $, esc, fmt, fmtCompact, fmtInt } from '../core/utils.js';

function indexTick(label, d) {
  if (!d || d.value == null) return '';
  const chg = Number(d.change) || 0;
  const pct = Number(d.percentage) || 0;
  const cls = chg >= 0 ? 't-pos' : 't-neg';
  const arrow = chg >= 0 ? '▲' : '▼';
  return `<span class="tick"><span class="k">${label}</span><span class="v">${fmt(d.value)}</span>
    <span class="c ${cls}">${arrow} ${fmt(Math.abs(chg))} (${chg >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)</span></span>`;
}

export async function loadMarketOverview() {
  const el = $('#marketStrip');
  if (!el) return;
  try {
    const d = await cse('marketOverview');
    const status = d.marketStatus?.status;
    const sum = d.marketSummery || {};
    const open = /trading|open/i.test(status || '') && !/close/i.test(status || '');
    el.innerHTML = [
      status ? `<span class="tick"><span class="status-dot ${open ? 'ok' : ''}" aria-hidden="true"></span><span class="v">${esc(status)}</span></span>` : '',
      indexTick('ASPI', d.aspiData),
      indexTick('S&amp;P SL20', d.snpData),
      sum.tradeVolume != null ? `<span class="tick"><span class="k">Turnover</span><span class="v">${fmtCompact(sum.tradeVolume)}</span></span>` : '',
      sum.shareVolume != null ? `<span class="tick"><span class="k">Volume</span><span class="v">${fmtInt(sum.shareVolume)}</span></span>` : '',
      sum.trades != null ? `<span class="tick"><span class="k">Trades</span><span class="v">${fmtInt(sum.trades)}</span></span>` : '',
    ].join('');
    el.hidden = !el.innerHTML.trim();
  } catch {
    el.hidden = true; // ticker is optional – fail quietly
  }
}
