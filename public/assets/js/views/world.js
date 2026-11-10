/**
 * World markets panel (Fundamentals tab): TradingView "Market Overview" widget with a chart
 * and three tabs — world indices, commodities (oil, gold) and LKR exchange rates.
 *
 * The widget only loads when the panel scrolls into view, so the tab stays fast, and it is
 * re-mounted when the app theme changes. Information only — no recommendations.
 */
import { $ } from '../core/utils.js';

const SCRIPT = 'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js';

const TABS = [
  {
    title: 'Indices',
    symbols: [
      { s: 'FOREXCOM:SPXUSD', d: 'S&P 500 (US)' },
      { s: 'FOREXCOM:NSXUSD', d: 'Nasdaq 100 (US)' },
      { s: 'FOREXCOM:DJI', d: 'Dow Jones (US)' },
      { s: 'BSE:SENSEX', d: 'Sensex (India)' },
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

/** Called when the Fundamentals tab opens: load the widget once the panel is on screen. */
export function showWorld() {
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
