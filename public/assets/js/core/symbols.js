/**
 * Full-market CSE symbol list, shared by Fundamentals / Technical / History pickers.
 */
import { cse } from './api.js';
import { state } from './store.js';
import { $, esc } from './utils.js';
import { normalizeSymbol } from './finance.js';

/** Stores the trade summary list as the market universe + price map. */
export function setMarketList(list) {
  const market = [];
  for (const item of list || []) {
    if (!item?.symbol) continue;
    const sym = String(item.symbol).toUpperCase();
    const price = item.price ?? item.lastTradedPrice;
    state.priceMap[sym] = {
      price,
      change: item.change,
      changePct: item.percentageChange ?? item.changePercentage,
      name: item.name,
      id: item.id,
    };
    market.push({ symbol: sym, name: item.name || sym, id: item.id, price });
  }
  if (market.length) state.market = market.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Loads the market list if missing (or forced). Falls back to holdings. */
export async function ensureMarketSymbols(force = false) {
  if (state.market.length && !force) return state.market;
  try {
    const data = await cse('tradeSummary');
    setMarketList(data.reqTradeSummery || data || []);
  } catch (err) {
    console.warn('market symbols', err);
  }
  return state.market;
}

/** Ordered list: your holdings first (★), then the rest of the market. */
function orderedList() {
  const port = new Set(state.holdings.map((h) => h.name).filter(Boolean));
  const list = state.market.length
    ? state.market
    : state.holdings.filter((h) => h.name).map((h) => ({ symbol: h.name, name: h.name }));
  return [
    ...list.filter((x) => port.has(x.symbol)),
    ...list.filter((x) => !port.has(x.symbol)),
  ].map((x) => ({ ...x, mine: port.has(x.symbol) }));
}

const label = (x) => (x.name && x.name.toUpperCase() !== x.symbol ? `${x.symbol} — ${x.name}` : x.symbol);

/** Fills the <select>/<datalist> pickers (keeps the current selection). */
export function populateSymbolSelects() {
  const ordered = orderedList();
  const opts = ordered.map((x) => `<option value="${esc(x.symbol)}">${esc(label(x))}${x.mine ? ' ★' : ''}</option>`).join('');
  const dataOpts = ordered.map((x) => `<option value="${esc(x.symbol)}">${esc(label(x))}</option>`).join('');
  ['#fundSymbol', '#techSymbol'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    const cur = el.value;
    el.innerHTML = opts || '<option value="">— load list —</option>';
    if (cur) el.value = cur;
  });
  ['#fundDatalist', '#techDatalist', '#txDatalist'].forEach((sel) => {
    const el = $(sel);
    if (el) el.innerHTML = dataOpts;
  });
}

/** Resolves typed text ("samp", "sampath") to a symbol; free-typed symbols are allowed. */
export function resolveSymbol(searchEl, selectEl) {
  const q = String(searchEl?.value || '').trim().toUpperCase();
  if (!q) return selectEl?.value || '';
  const hit = state.market.find((x) => x.symbol === q)
    || state.market.find((x) => x.symbol.startsWith(q))
    || state.market.find((x) => (x.name || '').toUpperCase().includes(q));
  if (hit) {
    if (selectEl) selectEl.value = hit.symbol;
    return hit.symbol;
  }
  return normalizeSymbol(q);
}
