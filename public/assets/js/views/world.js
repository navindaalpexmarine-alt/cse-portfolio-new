/**
 * World markets panel (Fundamentals tab): TradingView "Market Overview" widget with a chart
 * and three tabs — world indices, commodities (oil, gold) and LKR exchange rates.
 *
 * The widget only loads when the panel scrolls into view, so the tab stays fast, and it is
 * re-mounted when the app theme changes. Information only — no recommendations.
 */
import { $, fmt } from '../core/utils.js';
import { state } from '../core/store.js';

const SCRIPT = 'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js';

const TABS = [
  {
    title: 'CSE vs World',
    symbols: [
      { s: 'CSELK:ASI', d: 'ASPI (Sri Lanka)' },
      { s: 'CSELK:S&PSL20', d: 'S&P SL20 (Sri Lanka)' },
      { s: 'BSE:SENSEX', d: 'Sensex (India)' },
      { s: 'FOREXCOM:SPXUSD', d: 'S&P 500 (US)' },
      { s: 'FOREXCOM:NSXUSD', d: 'Nasdaq 100 (US)' },
      { s: 'FOREXCOM:DJI', d: 'Dow Jones (US)' },
      { s: 'FOREXCOM:UKXGBP', d: 'FTSE 100 (UK)' },
      { s: 'INDEX:NKY', d: 'Nikkei 225 (Japan)' },
    ],
  },
  {
    title: 'Commodities',
    symbols: [
      { s: 'TVC:UKOIL', d: 'Brent crude oil' },
      { s: 'TVC:USOIL', d: 'WTI crude oil' },
      { s: 'TVC:GOLD', d: 'Gold' },
      { s: 'TVC:SILVER', d: 'Silver' },
    ],
  },
  {
    title: 'LKR rates',
    symbols: [
      { s: 'FX_IDC:USDLKR', d: 'USD / LKR' },
      { s: 'FX_IDC:EURLKR', d: 'EUR / LKR' },
      { s: 'FX_IDC:GBPLKR', d: 'GBP / LKR' },
      { s: 'FX_IDC:INRLKR', d: 'INR / LKR' },
      { s: 'FX_IDC:JPYLKR', d: 'JPY / LKR' },
      { s: 'TVC:DXY', d: 'US dollar index' },
    ],
  },
];

let mountedTheme = '';
let observer = null;

const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

function mount() {
  const box = $('#worldBox');
  if (!box) return;
  mountedTheme = theme();
  box.innerHTML = `
    <div class="tradingview-widget-container world-widget">
      <div class="tradingview-widget-container__widget"></div>
    </div>`;
  const s = document.createElement('script');
  s.src = SCRIPT;
  s.async = true;
  s.type = 'text/javascript';
  s.textContent = JSON.stringify({
    colorTheme: mountedTheme,
    dateRange: '1M',
    showChart: true,
    locale: 'en',
    width: '100%',
    height: '100%',
    largeChartUrl: '',
    isTransparent: true,
    showSymbolLogo: true,
    showFloatingTooltip: true,
    tabs: TABS,
  });
  s.onerror = () => {
    box.innerHTML = '<div class="empty">World markets could not load right now. Check your connection and open this tab again.</div>';
    mountedTheme = '';
  };
  box.firstElementChild.appendChild(s);
}

/* Today's CSE move, from our own live data, so it can be compared with the rows below
   even if the chart provider has no Sri Lankan data. */
const chip = (label, d) => (d && d.value > 0
  ? `<span class="world-chip"><b>${label}</b> ${fmt(d.value)} <span class="${d.pct >= 0 ? 't-pos' : 't-neg'}">${d.pct >= 0 ? '▲ +' : '▼ −'}${Math.abs(d.pct).toFixed(2)}%</span></span>`
  : '');

export function renderWorldStrip() {
  const el = $('#worldCse');
  if (!el) return;
  const html = chip('🇱🇰 ASPI', state.aspi) + chip('S&amp;P SL20', state.snp);
  el.innerHTML = html ? `<span class="world-chip-k">Today on the CSE</span>${html}` : '';
  el.hidden = !html;
}

/** Called when the Fundamentals tab opens: load the widget once the panel is on screen. */
export function showWorld() {
  renderWorldStrip();
  const panel = $('#worldPanel');
  if (!panel || mountedTheme === theme()) return;
  if (!('IntersectionObserver' in window)) { mount(); return; }
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer.disconnect();
      observer = null;
      mount();
    }
  }, { rootMargin: '200px' });
  observer.observe(panel);
}

/** Theme switch: re-mount in the new colours (only if it was already loaded). */
export function worldOnTheme() {
  if (mountedTheme && mountedTheme !== theme()) mount();
}
