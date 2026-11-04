/**
 * Technical view: TradingView embed + CSE price/volume chart with moving averages,
 * RSI and a plain-language trend summary, 52-week position, relative volume,
 * beta and classic floor-trader pivots.
 */
import { cse } from '../core/api.js';
import { state } from '../core/store.js';
import { baseSym, normalizeSymbol } from '../core/finance.js';
import { ensureMarketSymbols, populateSymbolSelects, resolveSymbol } from '../core/symbols.js';
import { ensureChart } from '../core/loader.js';
import { analyze } from '../core/indicators.js';
import { $, cssVar, esc, fmt, fmtInt, fmtPct } from '../core/utils.js';
import { emptyHtml, setBusy, toast } from '../core/ui.js';

let selected = '';
let priceChart = null, volChart = null;
const PERIOD_LABEL = { 1: 'Intraday', 2: 'Weekly', 3: 'Monthly', 5: 'Daily' };

const metric = (label, value, hint = '', cls = '', valCls = '') =>
  `<div class="metric ${cls}"><div class="m-label">${label}</div><div class="m-val ${valCls}">${value}</div>${hint ? `<div class="m-hint">${hint}</div>` : ''}</div>`;

/** TradingView iframe embed (theme follows the app).
 *  TradingView lists CSE shares with the full suffix, e.g. CSELK:SAMP.N0000. */
function mountTradingView(sym) {
  const wrap = $('#tvWidgetWrap');
  const full = normalizeSymbol(sym).replace(/[^A-Z0-9.]/g, '');
  const base = baseSym(full);
  if (!base) { wrap.hidden = true; return; }
  const tvSym = `CSELK:${full}`;
  const interval = $('#tvInterval').value || 'D';
  const dark = document.documentElement.dataset.theme !== 'light';
  const params = new URLSearchParams({
    frameElementId: 'tradingview_cse', symbol: tvSym, interval, hidesidetoolbar: '0', symboledit: '1',
    saveimage: '1', toolbarbg: cssVar('--panel').replace('#', ''), theme: dark ? 'dark' : 'light', style: '1',
    timezone: 'Asia/Colombo', withdateranges: '1', hideideas: '1', allow_symbol_change: '1',
    studies: JSON.stringify(['RSI@tv-basicstudies', 'MASimple@tv-basicstudies']),
  });
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;
  $('#tvOpenLink').href = tvUrl;
  $('#tv_chart_container').innerHTML = `
    <iframe title="TradingView chart for ${esc(base)}" src="https://s.tradingview.com/widgetembed/?${params}"
      loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>
    <div class="tv-foot"><span>Symbol: <b class="t-gold">${esc(tvSym)}</b></span><span>Interval: ${esc(interval)}</span>
      <a href="${tvUrl}" target="_blank" rel="noopener">Full TradingView ↗</a><span>Data may be delayed · not investment advice</span></div>`;
  wrap.hidden = false;
}

async function stockIdFor(sym) {
  let id = state.priceMap[sym]?.id;
  if (id == null) {
    await ensureMarketSymbols(true);
    id = state.priceMap[sym]?.id;
  }
  return id;
}

export async function loadTechnicals(symOverride) {
  const box = $('#techContent'), st = $('#techStatus');
  const sym = symOverride || resolveSymbol($('#techSearch'), $('#techSymbol'));
  if (!sym) { box.innerHTML = emptyHtml('Select or type a symbol'); return; }
  selected = sym;
  $('#techSearch').value = sym;
  if ($('#techSymbol').querySelector(`option[value="${CSS.escape(sym)}"]`)) $('#techSymbol').value = sym;
  st.textContent = 'Loading…';
  const btn = $('#techLoadBtn');
  setBusy(btn, true);
  mountTradingView(sym);

  const period = $('#techPeriod').value || '5';
  let info, beta, points = [];
  try {
    const data = await cse('companyInfoSummery', { symbol: sym });
    info = data.reqSymbolInfo || {};
    beta = data.reqSymbolBetaInfo || {};
    if (!info.symbol && !info.name) throw new Error(`No data for ${sym} — check the symbol`);
  } catch (err) {
    st.textContent = 'Failed';
    box.innerHTML = emptyHtml(esc(err.message));
    setBusy(btn, false);
    return;
  }
  try {
    const stockId = await stockIdFor(sym);
    if (stockId != null) {
      const ch = await cse('companyChartDataByStock', { stockId, period });
      const raw = ch.chartData || ch.reqTradeSummery?.chartData || [];
      points = (Array.isArray(raw) ? raw : []).filter((p) => Number(p.p ?? p.c) > 0);
    }
  } catch (err) { console.warn('chart data', err); }
  setBusy(btn, false);

  const price = Number(info.lastTradedPrice || info.previousClose || 0);
  const lo52 = Number(info.p12LowPrice || info.ytdLowPrice || 0);
  const hi52 = Number(info.p12HiPrice || info.ytdHiPrice || 0);
  const dayLo = Number(info.lowTrade || price), dayHi = Number(info.hiTrade || price);
  const pos52 = hi52 > lo52 ? Math.max(0, Math.min(100, ((price - lo52) / (hi52 - lo52)) * 100)) : 50;
  const betaV = Number(beta.triASIBetaValue) ? Number(beta.triASIBetaValue) : null; // 0 = not calculated
  const chgPct = Number(info.changePercentage || 0);

  // Moving averages + RSI need daily or weekly bars (not intraday ticks).
  const ind = period === '5' || period === '2'
    ? analyze(points.map((p) => Number(p.p ?? p.c)), { price, unit: period === '2' ? 'week' : 'day' })
    : null;

  let trend = 'neut', trendLabel = 'Neutral / range';
  if (ind) { trend = ind.trend; trendLabel = ind.label.en; }
  else if (pos52 > 70 && chgPct >= 0) { trend = 'bull'; trendLabel = 'Near highs'; }
  else if (pos52 < 30 && chgPct <= 0) { trend = 'bear'; trendLabel = 'Near lows'; }
  else if (pos52 > 55) { trend = 'bull'; trendLabel = 'Above mid-range'; }
  else if (pos52 < 45) { trend = 'bear'; trendLabel = 'Below mid-range'; }
  const unit = period === '2' ? 'wk' : 'd';
  const vsMa = (ma) => (ma == null ? '' : price >= ma ? `<span class="t-pos">price above ▲ ${(((price - ma) / ma) * 100).toFixed(1)}%</span>` : `<span class="t-neg">price below ▼ ${(((price - ma) / ma) * 100).toFixed(1)}%</span>`);
  const rsiTxt = (x) => (x == null ? '' : x >= 70 ? 'overbought' : x <= 30 ? 'oversold' : x >= 50 ? 'positive momentum' : 'weak momentum');
  const indHtml = !ind
    ? `<div class="legend">${period === '1' ? 'Moving averages and RSI are shown on the Daily or Weekly chart.' : 'Not enough price history for moving averages / RSI.'}</div>`
    : `
      <div class="section-title">Trend summary · ${ind.bars} ${period === '2' ? 'weeks' : 'trading days'} of data</div>
      <div class="ind-summary ${ind.trend}">
        <div class="ind-head"><span class="tech-signal ${ind.trend}">${esc(ind.label.en)}</span></div>
        <ul>${ind.points.map((pt) => `<li class="${pt.tone}"><span>${esc(pt.en)}</span></li>`).join('')}</ul>
        <div class="legend">Rule-based reading of the averages and RSI — a hint for your own research, not a buy/sell signal.</div>
      </div>

      <div class="section-title">Moving averages · RSI</div>
      <div class="metric-grid">
        ${metric(`SMA 20${unit}`, ind.sma20 != null ? `Rs ${fmt(ind.sma20)}` : '—', vsMa(ind.sma20), '', 'sm')}
        ${metric(`SMA 50${unit}`, ind.sma50 != null ? `Rs ${fmt(ind.sma50)}` : '—', ind.sma50 != null ? vsMa(ind.sma50) : `needs 50 ${period === '2' ? 'weeks' : 'days'} of data`, '', 'sm')}
        ${metric(`SMA 200${unit}`, ind.sma200 != null ? `Rs ${fmt(ind.sma200)}` : '—', ind.sma200 != null ? vsMa(ind.sma200) : `needs 200 ${period === '2' ? 'weeks' : 'days'} of data`, '', 'sm')}
        ${metric('RSI (14)', ind.rsi != null ? ind.rsi.toFixed(0) : '—', `${rsiTxt(ind.rsi)}${ind.rsi != null ? `<div class="rsi-bar" role="img" aria-label="RSI ${ind.rsi.toFixed(0)} of 100"><i style="left:${Math.max(0, Math.min(100, ind.rsi))}%"></i></div>` : ''}`, ind.rsi != null && ind.rsi <= 30 ? 'good' : '', ind.rsi != null && (ind.rsi >= 70 || ind.rsi <= 30) ? 't-gold' : '')}
      </div>
      ${ind.returns.length ? `<div class="ret-row">${ind.returns.map((r) => `<span class="ret ${r.v >= 0 ? 't-pos' : 't-neg'}"><b>${r.k}</b> ${r.v >= 0 ? '+' : ''}${r.v.toFixed(1)}%</span>`).join('')}</div>` : ''}`;

  // Classic pivots from today's range.
  const pivot = (dayHi + dayLo + price) / 3;
  const r1 = 2 * pivot - dayLo, s1 = 2 * pivot - dayHi;
  const r2 = pivot + (dayHi - dayLo), s2 = pivot - (dayHi - dayLo);

  // Relative volume vs 12-month average daily volume (~242 CSE sessions/year).
  const tdyVol = Number(info.tdyShareVolume || 0);
  const avgDaily = Number(info.p12ShareVolume || 0) / 242;
  const rvol = avgDaily > 0 ? tdyVol / avgDaily : null;
  st.textContent = `${info.name || sym} · live`;

  box.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>${esc(info.name || sym)} <span class="h-sub">${esc(sym)}</span></h2><span class="tech-signal ${trend}">${trendLabel}</span></div>
      <div class="section-title">Price chart · ${PERIOD_LABEL[period] || 'Daily'}</div>
      <div class="chart-box" style="height:280px"><canvas id="techPriceChart" role="img" aria-label="Price chart for ${esc(sym)}"></canvas></div>
      <div class="chart-box" style="height:110px;margin-top:6px"><canvas id="techVolChart" role="img" aria-label="Volume chart for ${esc(sym)}"></canvas></div>
      ${ind ? '<div class="ma-legend"><span class="k close">Close</span><span class="k ma20">SMA 20</span><span class="k ma50">SMA 50</span><span class="k ma200">SMA 200</span></div>' : ''}
      ${indHtml}

      <div class="section-title">Price · 52-week</div>
      <div class="metric-grid">
        ${metric('Current', `Rs ${fmt(price)}`, `${chgPct >= 0 ? '+' : ''}${fmtPct(chgPct)} vs prev`, '', 't-gold')}
        ${metric('Day range', `${fmt(dayLo)} – ${fmt(dayHi)}`, '', '', 'sm')}
        ${metric('52w range', `${fmt(lo52)} – ${fmt(hi52)}`, '', '', 'sm')}
        ${metric('52w position', `${pos52.toFixed(0)}%`)}
      </div>
      <div class="range-bar" role="img" aria-label="52-week position ${pos52.toFixed(0)}%"><div class="fill"></div><div class="dot" style="left:${pos52}%"></div></div>
      <div class="range-labels"><span>L ${fmt(lo52)}</span><span>${fmt(price)}</span><span>H ${fmt(hi52)}</span></div>

      <div class="section-title">Risk · volume</div>
      <div class="metric-grid">
        ${metric('Beta (ASPI)', betaV != null ? betaV.toFixed(2) : '—', betaV == null ? '' : betaV < 1 ? 'moves less than the market' : 'moves more than the market', betaV != null && betaV < 1 ? 'good' : '')}
        ${metric('Today volume', tdyVol ? fmtInt(tdyVol) : '—', '', '', 'sm')}
        ${metric('Rel. volume', rvol != null ? rvol.toFixed(2) + '×' : '—', 'vs 12-month daily average', rvol != null && rvol > 1.5 ? 'good' : '')}
      </div>

      <div class="section-title">Day pivots (S/R)</div>
      <div class="metric-grid">
        ${metric('R2', `Rs ${fmt(r2)}`, '', '', 'sm')}
        ${metric('R1', `Rs ${fmt(r1)}`, '', '', 'sm')}
        ${metric('Pivot', `Rs ${fmt(pivot)}`, '', '', 't-gold')}
        ${metric('S1', `Rs ${fmt(s1)}`, '', '', 'sm')}
        ${metric('S2', `Rs ${fmt(s2)}`, '', '', 'sm')}
      </div>
      <div class="legend">Rule-based levels for orientation only — not a buy/sell recommendation.</div>
    </div>`;

  const keep = 180;
  drawCharts(points.slice(-keep), period, ind ? {
    s20: ind.series.s20.slice(-keep), s50: ind.series.s50.slice(-keep), s200: ind.series.s200.slice(-keep),
  } : null);
}

async function drawCharts(pts, period, ma = null) {
  priceChart?.destroy(); volChart?.destroy();
  priceChart = volChart = null;
  if (!pts.length) {
    $('#techPriceChart').parentElement.innerHTML = emptyHtml('No chart data — market may be closed or check the symbol', true);
    $('#techVolChart')?.parentElement.remove();
    return;
  }
  let Chart;
  try { Chart = await ensureChart(); } catch (err) { toast(err.message, { error: true }); return; }
  if (!$('#techPriceChart')) return; // user loaded another symbol meanwhile

  const labels = pts.map((p) => {
    const t = p.t ? new Date(Number(p.t)) : null;
    if (!t || Number.isNaN(t.getTime())) return '';
    return period === '1'
      ? t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Colombo' })
      : t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Colombo' });
  });
  const closes = pts.map((p) => Number(p.p ?? p.c) || null);
  const vols = pts.map((p) => Number(p.q) || 0);
  const pos = cssVar('--pos'), neg = cssVar('--neg'), gold = cssVar('--gold');
  const volColors = closes.map((c, i) => (i === 0 || c == null || closes[i - 1] == null ? cssVar('--muted') : c >= closes[i - 1] ? pos : neg));

  priceChart = new Chart($('#techPriceChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Close', data: closes, borderColor: gold, backgroundColor: cssVar('--gold-wash'), fill: true, tension: 0.15, pointRadius: 0, borderWidth: 2 },
        ...(ma ? [
          { label: 'SMA 20', data: ma.s20, borderColor: cssVar('--blue'), fill: false, tension: 0.1, pointRadius: 0, borderWidth: 1.4, spanGaps: false },
          { label: 'SMA 50', data: ma.s50, borderColor: cssVar('--pos'), fill: false, tension: 0.1, pointRadius: 0, borderWidth: 1.4, borderDash: [5, 3] },
          { label: 'SMA 200', data: ma.s200, borderColor: cssVar('--neg'), fill: false, tension: 0.1, pointRadius: 0, borderWidth: 1.6, borderDash: [2, 3] },
        ] : []),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { filter: (c) => c.raw != null, callbacks: { label: (c) => ` ${c.dataset.label}: Rs ${fmt(c.raw)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } }, y: { ticks: { maxTicksLimit: 6 } } },
    },
  });
  volChart = new Chart($('#techVolChart'), {
    type: 'bar',
    data: { labels, datasets: [{ data: vols, backgroundColor: volColors, borderWidth: 0, maxBarThickness: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` Vol ${fmtInt(c.raw)}` } } },
      scales: { x: { ticks: { display: false }, grid: { display: false } }, y: { ticks: { maxTicksLimit: 3 } } },
    },
  });
}

export function init() {
  $('#techForm').addEventListener('submit', (e) => { e.preventDefault(); loadTechnicals(); });
  $('#techSymbol').addEventListener('change', (e) => { $('#techSearch').value = e.target.value; });
  $('#techPeriod').addEventListener('change', () => { if (selected) loadTechnicals(selected); });
  $('#tvInterval').addEventListener('change', () => { if (selected) mountTradingView(selected); });
  $('#techRefreshSymBtn').addEventListener('click', async () => {
    await ensureMarketSymbols(true);
    populateSymbolSelects();
    toast(`CSE list · ${state.market.length} symbols`);
  });
}

export async function show(params) {
  await ensureMarketSymbols(false);
  populateSymbolSelects();
  const sym = params?.sym || (selected && !$('#techContent .panel') ? selected : '');
  if (sym) loadTechnicals(sym);
}

/** Theme switch: re-mount TradingView and redraw charts in the new colours. */
export function onTheme() {
  if (selected && $('#techContent .panel')) loadTechnicals(selected);
}

export default { init, show, onTheme };
