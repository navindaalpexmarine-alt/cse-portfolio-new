/**
 * Fundamentals view: market movers + full company snapshot for any CSE symbol
 * (price, market cap, beta, ranges, volumes, turnover, related news).
 */
import { cse, news } from '../core/api.js';
import { state } from '../core/store.js';
import { baseSym, sectorOf } from '../core/finance.js';
import { ensureMarketSymbols, populateSymbolSelects, resolveSymbol } from '../core/symbols.js';
import { go } from '../core/router.js';
import { $, esc, fmt, fmtDate, fmtInt, fmtOr, fmtPct, safeUrl } from '../core/utils.js';
import { emptyHtml, setBusy, toast } from '../core/ui.js';

let selected = '';
let moversLoadedAt = 0;

const metric = (label, value, hint = '', cls = '', valCls = '') =>
  `<div class="metric ${cls}"><div class="m-label">${label}</div><div class="m-val ${valCls}">${value}</div>${hint ? `<div class="m-hint">${hint}</div>` : ''}</div>`;

/* ---------- market movers ---------- */

function moverList(title, rows, valueFn) {
  if (!rows?.length) return `<div><h3>${title}</h3>${emptyHtml('No data', true)}</div>`;
  return `<div><h3>${title}</h3><ul class="mover-list">${rows.slice(0, 6).map((r) => {
    const pct = Number(r.changePercentage ?? r.percentageChange ?? 0);
    return `<li><button type="button" class="mover" data-sym="${esc(r.symbol)}" title="Load ${esc(r.symbol)}">
      <span class="s">${esc(baseSym(r.symbol))}</span>${valueFn(r, pct)}</button></li>`;
  }).join('')}</ul></div>`;
}

async function loadMovers(force = false) {
  if (!force && Date.now() - moversLoadedAt < 60000) return;
  const box = $('#moversBox');
  const [g, l, a] = await Promise.allSettled([cse('topGainers'), cse('topLooses'), cse('mostActiveTrades')]);
  if ([g, l, a].every((r) => r.status === 'rejected')) {
    box.innerHTML = emptyHtml('Market movers unavailable — live API not reachable.', true);
    return;
  }
  moversLoadedAt = Date.now();
  const pctSpan = (r, pct) => `<span class="p ${pct >= 0 ? 't-pos' : 't-neg'}">${fmt(r.price)} · ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
  const turnover = (r) => `<span class="p">${r.turnover != null ? 'Rs ' + fmtInt(r.turnover) : fmtInt(r.tradeVolume ?? r.shareVolume ?? r.quantity)}</span>`;
  box.innerHTML =
    moverList('Top gainers', g.value, pctSpan) +
    moverList('Top losers', l.value, pctSpan) +
    moverList('Most active', a.value, turnover);
}

/* ---------- company snapshot ---------- */

export async function loadFundamentals(symOverride) {
  const box = $('#fundContent'), st = $('#fundStatus');
  const sym = symOverride || resolveSymbol($('#fundSearch'), $('#fundSymbol'));
  if (!sym) { box.innerHTML = emptyHtml('Symbol තෝරන්න හෝ type කරන්න'); return; }
  selected = sym;
  $('#fundSearch').value = sym;
  if ($('#fundSymbol').querySelector(`option[value="${CSS.escape(sym)}"]`)) $('#fundSymbol').value = sym;
  st.textContent = 'Loading…';
  const btn = $('#fundLoadBtn');
  setBusy(btn, true);

  let info, beta;
  try {
    const raw = await cse('companyInfoSummery', { symbol: sym });
    info = raw.reqSymbolInfo || {};
    beta = raw.reqSymbolBetaInfo || {};
    if (!info.symbol && !info.name) throw new Error(`No data for ${sym} — check the symbol`);
  } catch (err) {
    st.textContent = 'Failed';
    box.innerHTML = emptyHtml(esc(err.message));
    setBusy(btn, false);
    return;
  }
  setBusy(btn, false);

  const price = info.lastTradedPrice ?? info.price ?? info.closingPrice;
  const chg = info.change, chgPct = info.changePercentage ?? info.percentageChange;
  const lo52 = Number(info.p12LowPrice || info.ytdLowPrice || 0);
  const hi52 = Number(info.p12HiPrice || info.ytdHiPrice || 0);
  const pos52 = price != null && hi52 > lo52 ? ((Number(price) - lo52) / (hi52 - lo52)) * 100 : null;
  const tdyVol = Number(info.tdyShareVolume || 0);
  const trades = Number(info.tdyTradeVolume || info.tdyShareTrade || info.noOfTrades || 0);
  const issued = info.quantityIssued ?? info.issuedQuantity;
  const sector = sectorOf(sym);
  const inPort = state.holdings.some((h) => h.name === sym);
  const betaV = Number(beta.triASIBetaValue) ? Number(beta.triASIBetaValue) : null; // 0 = not calculated
  st.textContent = `${info.name || sym} · live`;

  const hl = (h, l) => `${fmtOr(h)} / ${fmtOr(l)}`;
  box.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>${esc(info.name || sym)} <span class="h-sub">${esc(sym)}</span>
          <span class="h-badges">${inPort ? '<span class="badge port">YOUR PORTFOLIO</span>' : ''}</span></h2>
        <div class="panel-actions">
          <a class="btn ghost" target="_blank" rel="noopener" href="https://www.cse.lk/pages/company-profile/company-profile.component.html?symbol=${encodeURIComponent(sym)}">CSE profile ↗</a>
          <a class="btn ghost" target="_blank" rel="noopener" href="https://stockdividends.iamsupun.com/stocks/${encodeURIComponent(baseSym(sym))}/">Dividends ↗</a>
          <button class="btn ghost" type="button" id="fundToTechBtn">Technical →</button>
        </div>
      </div>
      <div class="metric-grid">
        ${metric('Last traded', `Rs ${fmt(price)}`, `${chg != null ? (chg >= 0 ? '+' : '') + fmt(chg) + ' (' + fmtPct(chgPct || 0) + ')' : ''} · prev ${fmtOr(info.previousClose)}`, '', 't-gold')}
        ${metric('Market cap', info.marketCap != null ? `Rs ${fmt(info.marketCap / 1e6)} Mn` : '—', `${info.marketCapPercentage != null ? fmt(info.marketCapPercentage) + '% of market · ' : ''}${esc(sector)}`)}
        ${metric('Beta (ASPI)', betaV != null ? betaV.toFixed(2) : '—', `SPSL ${Number(beta.betaValueSPSL) ? Number(beta.betaValueSPSL).toFixed(2) : '—'} · ${betaV == null ? '' : betaV < 1 ? 'defensive-ish' : 'higher beta'}`, betaV != null && betaV < 1 ? 'good' : '')}
        ${metric('Shares issued', issued != null ? fmtInt(issued) : '—', `Par ${fmtOr(info.parValue)} · ISIN ${esc(info.isin || '—')}`, '', 'sm')}
        ${metric('52w position', pos52 != null ? pos52.toFixed(0) + '%' : '—', `${fmtOr(lo52)} – ${fmtOr(hi52)}`)}
        ${metric('Day range', `${fmtOr(info.lowTrade)} – ${fmtOr(info.hiTrade)}`, `Prev close ${fmtOr(info.previousClose)}`, '', 'sm')}
      </div>
      ${pos52 != null ? `<div class="range-bar" role="img" aria-label="52-week position ${pos52.toFixed(0)}%"><div class="fill"></div><div class="dot" style="left:${Math.max(0, Math.min(100, pos52))}%"></div></div>
      <div class="range-labels"><span>52w L ${fmt(lo52)}</span><span>${fmt(price)}</span><span>52w H ${fmt(hi52)}</span></div>` : ''}

      <div class="section-title">Price ranges</div>
      <div class="metric-grid">
        ${metric('Day H / L', hl(info.hiTrade, info.lowTrade), '', '', 'sm')}
        ${metric('Week H / L', hl(info.wtdHiPrice, info.wtdLowPrice), '', '', 'sm')}
        ${metric('Month H / L', hl(info.mtdHiPrice, info.mtdLowPrice), '', '', 'sm')}
        ${metric('YTD H / L', hl(info.ytdHiPrice, info.ytdLowPrice), '', '', 'sm')}
        ${metric('52w H / L', hl(info.p12HiPrice, info.p12LowPrice), '', '', 'sm')}
        ${metric('All-time H / L', hl(info.allHiPrice, info.allLowPrice), '', '', 'sm')}
      </div>

      <div class="section-title">Volume · turnover · activity</div>
      <div class="metric-grid">
        ${metric('Today volume', tdyVol ? fmtInt(tdyVol) : '—', '', '', 'sm')}
        ${metric('Today turnover', info.tdyTurnover ? 'Rs ' + fmt(info.tdyTurnover) : '—', '', '', 'sm')}
        ${metric('Month volume', info.mtdShareVolume ? fmtInt(info.mtdShareVolume) : '—', '', '', 'sm')}
        ${metric('YTD volume', fmtInt(info.ytdShareVolume), '', '', 'sm')}
        ${metric('Month turnover', info.mtdTurnover != null ? 'Rs ' + fmt(info.mtdTurnover) : '—', '', '', 'sm')}
        ${metric('YTD turnover', info.ytdTurnover != null ? 'Rs ' + fmt(info.ytdTurnover) : '—', '', '', 'sm')}
        ${metric('Trades today', trades ? fmtInt(trades) : '—', '', '', 'sm')}
        ${metric('Avg trade size', tdyVol && trades ? fmtInt(Math.round(tdyVol / trades)) : '—', '', '', 'sm')}
      </div>

      <div class="section-title">Identity · listing</div>
      <div class="metric-grid">
        ${metric('Symbol', esc(sym), '', '', 'sm')}
        ${metric('ISIN', esc(info.isin || '—'), '', '', 'sm')}
        ${metric('Sector (mapped)', esc(sector), '', '', 'sm')}
        ${metric('Listed since', esc(info.issueDate || '—'), '', '', 'sm')}
      </div>

      <div class="section-title">Related news (this symbol)</div>
      <div id="fundNewsBox">${emptyHtml('Loading company news…', true)}</div>
    </div>`;

  $('#fundToTechBtn').addEventListener('click', () => go('tech', { sym }));
  loadCompanyNews(sym, info.name);
}

async function loadCompanyNews(sym, name) {
  const box = $('#fundNewsBox');
  try {
    const data = await news('company', { symbol: baseSym(sym), name: name || '', limit: 12 });
    if (selected !== sym || !box.isConnected) return; // user moved on
    const rows = data.items || [];
    box.innerHTML = rows.length
      ? `<div class="news-list">${rows.slice(0, 8).map((it) => `<article class="news-item compact">
          <div class="ni-body"><a class="title" href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener">${esc(it.title)}</a>
            <div class="news-source-row"><span class="src-dot"></span><span>${esc(it.source || 'Media')}</span></div></div>
          <div class="ni-side"><span class="ni-time">${esc(fmtDate(it.pubDate))}</span></div>
        </article>`).join('')}</div>`
      : emptyHtml('Recent media news නෑ මේ symbol එකට — News tab බලන්න.', true);
  } catch (err) {
    if (box.isConnected) box.innerHTML = emptyHtml(`Company news load fail — ${esc(err.message)}`, true);
  }
}

/* ---------- lifecycle ---------- */

export function init() {
  $('#fundForm').addEventListener('submit', (e) => { e.preventDefault(); loadFundamentals(); });
  $('#fundSymbol').addEventListener('change', (e) => { $('#fundSearch').value = e.target.value; });
  $('#fundRefreshSymBtn').addEventListener('click', async () => {
    await ensureMarketSymbols(true);
    populateSymbolSelects();
    toast(`CSE list · ${state.market.length} symbols`);
  });
  $('#moversRefreshBtn').addEventListener('click', () => loadMovers(true));
  $('#moversBox').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sym]');
    if (b) {
      loadFundamentals(b.dataset.sym);
      $('#fundForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

export async function show(params) {
  loadMovers();
  await ensureMarketSymbols(false);
  populateSymbolSelects();
  const sym = params?.sym || (selected && !$('#fundContent .panel') ? selected : '');
  if (sym) loadFundamentals(sym);
}

export default { init, show };
