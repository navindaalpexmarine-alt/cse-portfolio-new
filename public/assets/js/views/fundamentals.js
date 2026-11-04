/**
 * Fundamentals view: watchlist, market movers + full company snapshot for any CSE symbol
 * (price, market cap, beta, ranges, volumes, turnover, dividends & yield, related news).
 */
import { cse, news } from '../core/api.js';
import { commit, state } from '../core/store.js';
import { baseSym, normalizeSymbol, sectorOf } from '../core/finance.js';
import { ensureMarketSymbols, populateSymbolSelects, resolveSymbol } from '../core/symbols.js';
import { go } from '../core/router.js';
import { $, esc, fmt, fmtDate, fmtInt, fmtOr, fmtPct, safeUrl } from '../core/utils.js';
import { emptyHtml, setBusy, toast } from '../core/ui.js';
import { parseDate } from '../core/dates.js';

let selected = '';
let moversLoadedAt = 0;

const metric = (label, value, hint = '', cls = '', valCls = '') =>
  `<div class="metric ${cls}"><div class="m-label">${label}</div><div class="m-val ${valCls}">${value}</div>${hint ? `<div class="m-hint">${hint}</div>` : ''}</div>`;

/* ---------- watchlist (synced with the account like the portfolio) ---------- */

const inWatch = (sym) => state.watchlist.includes(sym);

function toggleWatch(sym, on = !inWatch(sym)) {
  if (!sym) return;
  if (on && !inWatch(sym)) {
    if (state.watchlist.length >= 100) { toast('Watchlist is full (100)', { error: true }); return; }
    state.watchlist = [...state.watchlist, sym];
    toast(`★ ${baseSym(sym)} added to watchlist`);
  } else if (!on) {
    state.watchlist = state.watchlist.filter((x) => x !== sym);
    toast(`${baseSym(sym)} removed from watchlist`);
  }
  commit('watchlist');
  renderWatchlist();
  const b = $('#fundWatchBtn');
  if (b && b.dataset.sym === sym) setWatchBtn(b, inWatch(sym));
}

function setWatchBtn(b, on) {
  b.textContent = on ? '★ Watching' : '☆ Watch';
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('on', on);
}

export function renderWatchlist() {
  const box = $('#watchBox');
  if (!box) return;
  const list = state.watchlist;
  if (!list.length) {
    box.innerHTML = emptyHtml('Follow shares you don’t own yet: type a symbol above and press <b>+ Add</b>, or click <b>☆ Watch</b> on any company.', true);
    return;
  }
  const own = new Set(state.holdings.map((h) => h.name));
  box.innerHTML = `<div class="watch-grid">${list.map((sym) => {
    const p = state.priceMap[sym] || {};
    const m = state.market.find((x) => x.symbol === sym);
    const price = p.price ?? m?.price;
    const pct = Number(p.changePct);
    const has = Number.isFinite(pct);
    return `<div class="watch-card${has ? (pct >= 0 ? ' up' : ' down') : ''}">
      <button type="button" class="watch-open" data-sym="${esc(sym)}" title="Load ${esc(sym)}">
        <span class="w-sym">${esc(baseSym(sym))}${own.has(sym) ? ' <span class="badge port">OWN</span>' : ''}</span>
        <span class="w-name">${esc(p.name || m?.name || sym)}</span>
        <span class="w-price">${price != null ? 'Rs ' + fmt(price) : '—'}</span>
        <span class="w-chg ${has ? (pct >= 0 ? 't-pos' : 't-neg') : 't-muted'}">${has ? (pct >= 0 ? '▲ +' : '▼ ') + pct.toFixed(2) + '%' : 'no trade today'}</span>
      </button>
      <button type="button" class="w-del" data-unwatch="${esc(sym)}" aria-label="Remove ${esc(baseSym(sym))} from watchlist">×</button>
    </div>`;
  }).join('')}</div>`;
}

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
  if (!sym) { box.innerHTML = emptyHtml('Select or type a symbol'); return; }
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
          <button class="btn ghost watch-toggle" type="button" id="fundWatchBtn" data-sym="${esc(sym)}" aria-pressed="false">☆ Watch</button>
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

      <div class="section-title">Dividends · yield <span class="t-muted" style="font-weight:400">(CSE cash-dividend announcements)</span></div>
      <div id="fundDivBox">${emptyHtml('Loading dividends…', true)}</div>

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
  const wb = $('#fundWatchBtn');
  setWatchBtn(wb, inWatch(sym));
  wb.addEventListener('click', () => toggleWatch(sym));
  loadCompanyDividends(sym, Number(price), info.name);
  loadCompanyNews(sym, info.name);
}

/* ---------- dividends & yield ---------- */

let divCache = { at: 0, rows: null, p: null };
/** CSE cash-dividend list (shared, cached 10 min). */
function cashDividendList() {
  if (divCache.rows && Date.now() - divCache.at < 600000) return Promise.resolve(divCache.rows);
  if (!divCache.p) {
    divCache.p = cse('cashDividends').then((d) => {
      const rows = Array.isArray(d?.cashDividends) ? d.cashDividends : [];
      divCache = { at: Date.now(), rows, p: null };
      return rows;
    }).catch((err) => { divCache.p = null; throw err; });
  }
  return divCache.p;
}

const posNum = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
/** Any CSE / news date format → Date (see core/dates.js). */
function toDate(v) {
  return parseDate(v);
}
const dShort = (d) => (d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

async function loadCompanyDividends(sym, price, name) {
  const box = $('#fundDivBox');
  let all;
  try { all = await cashDividendList(); } catch {
    if (box?.isConnected) box.innerHTML = emptyHtml('CSE dividend list is unavailable right now — try again later or open the Dividends tab.', true);
    return;
  }
  if (selected !== sym || !box?.isConnected) return;

  const base = baseSym(sym);
  const nonVoting = /\.X\d{4}$/i.test(sym);
  const nm = String(name || '').toLowerCase().replace(/\b(plc|limited|ltd)\b/g, '').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const rows = all.filter((r) => {
    const b = baseSym(r.symbol || '');
    if (b) return b === base;
    const c = String(r.company || '').toLowerCase().replace(/\b(plc|limited|ltd)\b/g, '').trim();
    return nm.length > 3 && c && (c.includes(nm) || nm.includes(c));
  }).map((r) => ({
    dps: posNum(nonVoting ? (r.nonVotingDivPerShare || r.votingDivPerShare) : r.votingDivPerShare),
    xd: toDate(r.xd),
    pay: toDate(r.payment || r.paymentDate),
    ann: toDate(r.dateOfAnnouncement),
    kind: r.finalDividend ? 'Final' : r.firstAndFinal ? 'First & final' : r.typeFirstInt ? '1st interim' : r.typeSecondInt ? '2nd interim'
      : r.typeThirdInt ? '3rd interim' : r.typeFourthInt ? '4th interim' : 'Dividend',
  })).filter((r) => {
    const k = `${(r.xd || r.ann)?.toISOString().slice(0, 10)}|${r.dps}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return r.dps || r.xd;
  }).sort((a, b) => (b.xd || b.ann || 0) - (a.xd || a.ann || 0));

  const hold = state.holdings.find((h) => h.name === sym);
  const avgDps = Number(hold?.avgDps) || 0;
  const yearly = avgDps > 0 && price > 0
    ? metric('Yearly yield (your Avg DPS)', `${((avgDps / price) * 100).toFixed(2)}%`, `Rs ${fmt(avgDps)} a year ÷ Rs ${fmt(price)} · before tax`, (avgDps / price) * 100 >= 5 ? 'good' : '', 't-gold')
    : metric('Yearly yield', '—', 'Set “Avg DPS” for this share in the Dividends tab to see it', '', 'sm');
  const feedNote = 'The CSE feed lists recent announcements only (roughly the last few weeks). Full history: “Dividends ↗” above.';

  if (!rows.length) {
    box.innerHTML = `<div class="metric-grid">${metric('Recent CSE announcements', 'None', `No cash dividend from ${esc(base)} in the current feed`, '', 'sm')}${yearly}</div>
      <div class="legend">${feedNote} <button type="button" class="btn ghost sm" id="fundToDivBtn">Dividends tab →</button></div>`;
    $('#fundToDivBtn')?.addEventListener('click', () => go('div'));
    return;
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const latest = rows[0];
  const upcoming = rows.filter((r) => r.xd && r.xd >= today).sort((a, b) => a.xd - b.xd);
  const next = upcoming[0];
  const nextIncome = next?.dps && hold?.balance ? next.dps * hold.balance : null;
  const pctOf = (dps) => (dps && price > 0 ? ((dps / price) * 100).toFixed(2) + '%' : '—');

  box.innerHTML = `
    <div class="metric-grid">
      ${metric('Latest dividend', latest.dps ? `Rs ${fmt(latest.dps)}` : '—', `${esc(latest.kind)} · XD ${dShort(latest.xd)}${latest.pay ? ' · pay ' + dShort(latest.pay) : ''}`)}
      ${metric('Latest as % of price', pctOf(latest.dps), 'one payment · before tax', '', 'sm')}
      ${metric('Next XD', next ? dShort(next.xd) : '—', next ? `Rs ${fmt(next.dps)} / share${next.pay ? ' · pay ' + dShort(next.pay) : ''}` : 'none upcoming in the feed', next ? 'good' : '', 'sm')}
      ${nextIncome != null ? metric('Your next dividend', `Rs ${fmt(nextIncome)}`, `${fmtInt(hold.balance)} shares × Rs ${fmt(next.dps)} · own before XD`, 'good', 'sm') : ''}
      ${yearly}
    </div>
    <div class="table-wrap"><table class="data-table div-mini">
      <thead><tr><th class="left">XD date</th><th class="left">Type</th><th>DPS (Rs)</th><th>% of price</th><th class="left">Payment</th></tr></thead>
      <tbody>${rows.slice(0, 6).map((r) => `<tr class="${r.xd && r.xd >= today ? 'upcoming' : ''}">
        <td class="left">${dShort(r.xd || r.ann)}${r.xd && r.xd >= today ? ' <span class="badge soon">UPCOMING</span>' : ''}</td>
        <td class="left">${esc(r.kind)}</td>
        <td>${r.dps ? fmt(r.dps) : '—'}</td>
        <td>${pctOf(r.dps)}</td>
        <td class="left">${dShort(r.pay)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="legend">${feedNote} Past dividends don’t guarantee future ones; confirm XD dates on cse.lk.
      <button type="button" class="btn ghost sm" id="fundToDivBtn">Dividends tab →</button></div>`;
  $('#fundToDivBtn')?.addEventListener('click', () => go('div'));
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
      : emptyHtml('No recent media news for this symbol — check the News tab.', true);
  } catch (err) {
    if (box.isConnected) box.innerHTML = emptyHtml(`Company news load fail — ${esc(err.message)}`, true);
  }
}

/* ---------- lifecycle ---------- */

export function init() {
  $('#fundForm').addEventListener('submit', (e) => { e.preventDefault(); loadFundamentals(); });
  $('#watchAddForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#watchAddInput');
    const raw = inp.value.trim();
    if (!raw) return;
    let sym = resolveSymbol(inp, null);
    if (sym && !sym.includes('.')) sym = normalizeSymbol(sym);
    if (state.market.length && !state.market.some((x) => x.symbol === sym)) {
      toast(`${sym} is not in today’s CSE list — added anyway`, { ms: 3500 });
    }
    toggleWatch(sym, true);
    inp.value = '';
  });
  $('#watchBox')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-unwatch]');
    if (del) { toggleWatch(del.dataset.unwatch, false); return; }
    const open = e.target.closest('.watch-open[data-sym]');
    if (open) {
      loadFundamentals(open.dataset.sym);
      $('#fundForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
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
  renderWatchlist();
  loadMovers();
  await ensureMarketSymbols(false);
  populateSymbolSelects();
  renderWatchlist();
  const sym = params?.sym || (selected && !$('#fundContent .panel') ? selected : '');
  if (sym) loadFundamentals(sym);
}

/** Called by the router when data changes while this tab is open (live prices, sync…). */
export function onData(topic) {
  if (['prices', 'all', 'watchlist', 'holdings'].includes(topic)) renderWatchlist();
}

export default { init, show, onData };
