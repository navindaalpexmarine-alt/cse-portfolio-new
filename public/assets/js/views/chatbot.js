/**
 * CSE Portfolio — Smart help chatbot v2
 * English / සිංහල / Singlish / mix (replies follow the user's style).
 *
 * What it can do:
 *  - App help (FAQ) + open any tab from chat ("open calculator", "news ekata yanna")
 *  - Company lookup by symbol or name (COMB, "Kotagala Plantations"), with typo suggestions
 *  - Follow-ups on the last company ("price?", "eke mila", "more details")
 *  - Compare two companies ("COMB vs SAMP")
 *  - Calculator in chat: "buy 100 COMB @ 120", "sell 50 SAMP at 90 bought 80",
 *    "break even 120", "Rs 100k walin COMB kiyak ganna puluwan?", "dividend 5 price 100"
 *  - Your portfolio: total value, P/L, best/worst, concentration ("mage portfolio kohomada?")
 *  - Market: top gainers / losers / most active, ASPI / S&P SL20, market open/closed (Colombo time)
 *  - Glossary: ASPI, XD, P/E, P/BV, EPS, DPS, B.E.S, CDS, beta, market cap…
 *  - Chat history (saved in browser), input history (↑/↓), voice input, copy, quick-reply chips
 *  - Optional AI fallback (CONFIG.aiEndpoint) for questions the rules can't answer
 *
 * Not investment advice — the bot never says buy/sell.
 */
import { $ } from '../core/utils.js';
import { ensureMarketSymbols } from '../core/symbols.js';
import { state } from '../core/store.js';
import { cse } from '../core/api.js';

/* =====================================================================
 * CONFIG — change these if needed
 * ===================================================================== */
const CONFIG = {
  /** Used only if the app's commission % can't be found. */
  defaultCommissionPct: 1.12,
  /** Set to '/api/chat' after deploying api/chat.mjs. Empty = AI off. */
  aiEndpoint: '',
  aiTimeoutMs: 15000,
  historyKey: 'cseChat.v2.history',
  inputHistoryKey: 'cseChat.v2.inputs',
  maxHistory: 60,
  cacheMs: 60_000,
  /** CSE regular trading session, Asia/Colombo */
  openMin: 9 * 60 + 30,
  closeMin: 14 * 60 + 30,
};

/* =====================================================================
 * DATA ADAPTER — the only place that knows about state shape.
 * If your store uses different field names, fix them here.
 * ===================================================================== */
const PRICE_KEYS = ['price', 'lastTradedPrice', 'ltp', 'last', 'tradePrice'];
const CHG_KEYS = ['changePct', 'changePercentage', 'percentageChange', 'change_pct', 'chgPct'];
const TURN_KEYS = ['turnover', 'tdyTurnover'];
const VOL_KEYS = ['volume', 'shareVolume', 'sharevolume', 'tdyShareVolume'];

function pickKey(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const baseOf = (s) => String(s || '').toUpperCase().split('.')[0];
const shortSym = (s) => String(s || '').toUpperCase().replace(/\.N0000$/, '');

const A = {
  market() {
    return Array.isArray(state.market) ? state.market : [];
  },
  sym(m) {
    return String(pickKey(m, ['symbol', 'sym', 'ticker']) || '').toUpperCase();
  },
  name(m) {
    return pickKey(m, ['name', 'companyName']) || '';
  },
  /** Find a market row by full symbol or base ("COMB" → COMB.N0000). Prefers .N0000. */
  row(sym) {
    const s = String(sym || '').toUpperCase();
    if (!s) return null;
    const rows = A.market();
    const exact = rows.find((m) => A.sym(m) === s);
    if (exact) return exact;
    const b = baseOf(s);
    const same = rows.filter((m) => baseOf(A.sym(m)) === b);
    return same.find((m) => /\.N0000$/.test(A.sym(m))) || same[0] || null;
  },
  pm(sym) {
    const map = state.priceMap || {};
    const s = String(sym || '').toUpperCase();
    if (map[s]) return map[s];
    const b = baseOf(s);
    const k = Object.keys(map).find((x) => baseOf(x) === b && /\.N0000$/i.test(x)) ||
      Object.keys(map).find((x) => baseOf(x) === b);
    return k ? map[k] : {};
  },
  price(sym) {
    const p = A.pm(sym);
    const r = A.row(sym);
    return num(pickKey(p, PRICE_KEYS)) ?? num(pickKey(r, PRICE_KEYS));
  },
  chg(sym) {
    return num(pickKey(A.pm(sym), CHG_KEYS)) ?? num(pickKey(A.row(sym), CHG_KEYS));
  },
  /** Holdings → [{symbol, qty, avg}] — tries common shapes. */
  holdings() {
    const p = state.portfolio;
    const cands = [
      p?.holdings, p?.items, p?.shares, p?.positions,
      Array.isArray(p) ? p : null,
      state.holdings, state.positions,
    ];
    let list = cands.find((c) => Array.isArray(c));
    if (!list) {
      const obj = [p?.holdings, p, state.holdings].find((c) => c && typeof c === 'object' && !Array.isArray(c));
      if (obj) {
        list = Object.entries(obj)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([k, v]) => ({ symbol: k, ...v }));
      }
    }
    if (!list) return [];
    return list.map((h) => ({
      symbol: String(pickKey(h, ['symbol', 'sym', 'ticker']) || '').toUpperCase(),
      qty: num(pickKey(h, ['qty', 'quantity', 'shares', 'units', 'q'])) || 0,
      avg: num(pickKey(h, ['avg', 'avgPrice', 'avg_price', 'averagePrice', 'buyPrice', 'cost', 'price'])) || 0,
    })).filter((h) => h.symbol && h.qty > 0);
  },
  /** Commission % from app state, header input, or default. */
  commissionPct() {
    const cand = [
      state.commission, state.commissionPct, state.commPct,
      state.settings?.commission, state.settings?.commissionPct,
    ].map(num).find((v) => v != null && v > 0 && v < 10);
    if (cand != null) return cand;
    if (typeof document !== 'undefined') {
      const inp = document.querySelector('#commission, #commissionPct, #commPct, input[name="commission"], input[id*="ommission"]');
      const v = num(inp?.value);
      if (v != null && v > 0 && v < 10) return v;
    }
    return CONFIG.defaultCommissionPct;
  },
};

/* =====================================================================
 * Language helpers
 * ===================================================================== */
const SINHALA_RE = /[඀-෿]/;
const SINGLISH_RE = /\b(kohomada|mokakda|mokadda|mokada|monawada|monada|gana|gane|kiyanna|kiyapan|puluwanda|puluwan|mage|mata|oyage|eke|ekata|thiyenne|tiyenne|thiyenawa|thiyanawa|gaththa|gatta|gatte|gaththe|wikuna|wikka|vikka|wikkuwa|mila|keeyada|kiyada|kiiyada|kiyak|keeyak|ada|iye|hondada|hodada|nadda|karanna|balanna|denna|wenne|wenawa|ganna|wikunanna|labaya|padu|parada|walin|yanna|danna|ehema|meka|ewa)\b/i;

const hasSi = (t) => SINHALA_RE.test(t || '');

function style(query) {
  const q = query || '';
  const si = hasSi(q);
  const en = /[a-zA-Z]{3,}/.test(q);
  if (si && en) return 'mix';
  if (si) return 'si';
  if (SINGLISH_RE.test(q)) return 'mix';
  return 'en';
}

function pick(st, en, si, mix) {
  if (st === 'si') return si;
  if (st === 'mix') return mix || si;
  return en;
}

function fmtNum(n, d = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-LK', { maximumFractionDigits: d });
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtRs(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v < 0 ? '-' : ''}Rs ${fmtNum(Math.abs(v))}`;
}

function arrow(n) {
  if (n == null) return '';
  return n > 0 ? '▲' : n < 0 ? '▼' : '•';
}

/** Parse "1,200", "1.5k", "2m", "1 lakh" → number */
function parseAmount(s, unit) {
  let v = num(s);
  if (v == null) return null;
  const u = (unit || '').toLowerCase();
  if (u === 'k') v *= 1e3;
  else if (u === 'm' || u === 'mn') v *= 1e6;
  else if (/^lak/.test(u)) v *= 1e5;
  return v;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* =====================================================================
 * Cached CSE API
 * ===================================================================== */
const _cache = new Map();
function cseCached(endpoint, params) {
  const key = endpoint + JSON.stringify(params || {});
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < CONFIG.cacheMs) return hit.p;
  const p = Promise.resolve().then(() => cse(endpoint, params)).catch((e) => {
    _cache.delete(key);
    throw e;
  });
  _cache.set(key, { t: Date.now(), p });
  return p;
}

/* =====================================================================
 * Conversation memory (per page session)
 * ===================================================================== */
const ctx = {
  lastSymbol: null,
  lastName: null,
  turns: [], // {role:'user'|'assistant', content}
};

/* =====================================================================
 * Symbol detection
 * ===================================================================== */
/** Never treat these as tickers when typed in lowercase / as words. */
const NOT_SYMBOL = new Set([
  'hi', 'ok', 'at', 'vs', 'rs', 'lkr', 'plc', 'ltd', 'the', 'and', 'for', 'buy', 'sell', 'near',
  'what', 'show', 'tell', 'price', 'news', 'help', 'open', 'close', 'with', 'from', 'mage', 'oyage',
  'gana', 'eke', 'today', 'market', 'best', 'worst', 'high', 'low', 'dividend', 'profit', 'loss',
  'chart', 'charts', 'guide', 'guides', 'calc', 'calculator', 'portfolio', 'history', 'share',
  'shares', 'stock', 'about', 'more', 'details', 'compare', 'bank', 'aspi', 'xd', 'pe', 'eps',
  'dps', 'bes', 'cds', 'sec', 'ipo', 'beta', 'yield', 'top', 'gainers', 'losers', 'active', 'and',
  'hello', 'hey', 'thanks', 'thank', 'mila', 'ada', 'kiyak', 'eka', 'ekak', 'meka', 'wala', 'walin',
  'please', 'pls', 'can', 'how', 'why', 'when', 'who', 'which', 'many', 'much', 'lakh', 'per',
]);

let _knownCache = { n: -1, set: new Set() };
function knownBases() {
  const rows = A.market();
  if (rows.length !== _knownCache.n) {
    _knownCache = { n: rows.length, set: new Set(rows.map((m) => baseOf(A.sym(m))).filter(Boolean)) };
  }
  return _knownCache.set;
}

/** Return detected symbols (bases or full) in order, plus typo suggestions. */
function detectSymbols(raw) {
  const known = knownBases();
  const found = [];
  const suggestions = [];
  const re = /\b([A-Za-z]{2,8})(\.[A-Za-z]\d{4})?\b/g;
  let m;
  while ((m = re.exec(raw || ''))) {
    const word = m[1];
    const up = word.toUpperCase();
    const full = (up + (m[2] || '').toUpperCase());
    const lower = word.toLowerCase();
    const typedUpper = word === up;
    if (NOT_SYMBOL.has(lower) && !(typedUpper && known.has(up) && word.length >= 4)) continue;
    if (known.has(up)) {
      if (typedUpper || m[2] || word.length >= 4) {
        if (!found.includes(full)) found.push(full);
      }
      continue;
    }
    // explicit ticker-looking (all caps, ≥3) but unknown → typo suggestion
    if (typedUpper && word.length >= 3 && word.length <= 6 && known.size) {
      let best = null;
      for (const k of known) {
        if (Math.abs(k.length - up.length) > 1) continue;
        if (levenshtein(k, up) === 1) { best = k; break; }
      }
      if (best) suggestions.push({ typed: up, best });
    }
  }
  return { found, suggestions };
}

/* =====================================================================
 * Company resolution by name (kept from v1, works with symbolSearch)
 * ===================================================================== */
const STOP = new Set([
  'plc', 'ltd', 'limited', 'company', 'companies', 'the', 'and', 'of', 'sri', 'lanka',
  'holdings', 'holding', 'group', 'corp', 'corporation', 'inc', 'co', 'public',
  'plantations', 'plantation', 'finance', 'bank', 'hotels', 'hotel', 'investments',
  'investment', 'services', 'service', 'trading', 'industries', 'industry',
  'details', 'detail', 'overview', 'info', 'information', 'about', 'price', 'what', 'tell',
  'ගැන', 'කියන්න', 'share', 'shares', 'stock', 'wala', 'walata', 'ekk', 'eka', 'gana', 'mila',
]);

function scoreName(query, name, sym) {
  const q = query.toLowerCase();
  const n = (name || '').toLowerCase();
  const base = (sym || '').toLowerCase().split('.')[0];
  const tokens = q.replace(/[?.!,]/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));
  let sc = 0;
  if (n && q.includes(n)) sc += 15;
  if (n && n.includes(q) && q.length >= 5) sc += 12;
  for (const t of tokens) {
    if (n.includes(t)) sc += t.length >= 5 ? 8 : 5;
    if (base === t || base.startsWith(t.slice(0, 4))) sc += 6;
  }
  if (tokens.length >= 2 && tokens.filter((t) => n.includes(t)).length >= 2) sc += 6;
  return sc;
}

function cleanSearchRows(data) {
  return (data?.reqCompanySymbol || []).filter(
    (r) => r.symbol && !String(r.symbol).includes('"') && r.name && r.name !== 'NOT DEFINED'
  );
}

async function resolveBySymbol(base) {
  const hit = A.row(base);
  if (hit) return { symbol: A.sym(hit), name: A.name(hit) };
  try {
    const rows = cleanSearchRows(await cseCached('symbolSearch', { symbol: baseOf(base) }));
    const r = rows.find((x) => /\.N0000$/i.test(x.symbol)) || rows[0];
    if (r) return { symbol: r.symbol, name: r.name, id: r.id };
  } catch { /* offline */ }
  return null;
}

async function resolveByName(query) {
  const q = (query || '').trim();
  if (!q) return null;
  let best = null;
  let bestScore = 0;
  for (const m of A.market()) {
    const sc = scoreName(q, A.name(m), A.sym(m));
    if (sc > bestScore) { bestScore = sc; best = m; }
  }
  if (best && bestScore >= 12) return { symbol: A.sym(best), name: A.name(best) };

  const tokens = q.toLowerCase().replace(/[?.!,]/g, ' ').split(/\s+/).filter((t) => t.length >= 4 && !STOP.has(t) && !NOT_SYMBOL.has(t));
  for (const t0 of tokens.slice(0, 3)) {
    try {
      const rows = cleanSearchRows(await cseCached('symbolSearch', { symbol: t0.slice(0, 4).toUpperCase() }));
      let localBest = null;
      let localSc = 0;
      for (const r of rows) {
        const sc = scoreName(q, r.name, r.symbol) + (/\.N0000$/i.test(r.symbol) ? 2 : 0);
        if (sc > localSc) { localSc = sc; localBest = r; }
      }
      if (localBest && localSc >= 12) return { symbol: localBest.symbol, name: localBest.name, id: localBest.id };
    } catch { /* ignore */ }
  }
  return null;
}

/* =====================================================================
 * Response helpers
 * ===================================================================== */
/** chips: [{label, q}] → sends q; actions: [{label, tab}] or [{label, url}] */
const R = (text, opts = {}) => ({ text, chips: opts.chips || [], actions: opts.actions || [] });
const chip = (label, q) => ({ label, q: q || label });
const tabAct = (label, tab) => ({ label, tab });

const DISCLAIMER = (st) => pick(st, 'Not investment advice.', 'Investment advice නෙවෙයි.', 'Advice නෙවෙයි.');

/* =====================================================================
 * Tabs / navigation
 * ===================================================================== */
const TABS = [
  { id: 'portfolio', key: '1', label: 'Portfolio', re: /portfolio|පෝට්ෆෝලියෝ/ },
  { id: 'calculator', key: '2', label: 'Calculator', re: /calculator|\bcalc\b|කැල්කියුලේටර්/ },
  { id: 'dividends', key: '3', label: 'Dividends', re: /dividends?|ලාභාංශ/ },
  { id: 'charts', key: '4', label: 'Charts', re: /charts?\b|ප්‍රස්ථාර/ },
  { id: 'history', key: '5', label: 'History', re: /history|ඉතිහාස/ },
  { id: 'news', key: '6', label: 'News', re: /news|පුවත්/ },
  { id: 'fundamentals', key: '7', label: 'Fundamentals', re: /fundamentals?/ },
  { id: 'technical', key: '8', label: 'Technical', re: /technicals?/ },
];

function openTab(id) {
  const t = TABS.find((x) => x.id === id);
  if (!t || typeof document === 'undefined') return false;
  const want = t.label.toLowerCase();
  const cands = document.querySelectorAll('[role="tab"], nav button, nav a, .tabs button, .tab, [data-tab]');
  for (const c of cands) {
    if (c.closest('#cseChatRoot')) continue;
    const txt = (c.textContent || '').trim().toLowerCase();
    const dt = (c.dataset?.tab || '').toLowerCase();
    if (txt.startsWith(want) || dt === t.id || dt === want) {
      c.click();
      return true;
    }
  }
  // Fallback: the app's own keyboard shortcut (1–8)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: t.key, bubbles: true }));
  return true;
}

/* =====================================================================
 * Market clock (Asia/Colombo)
 * ===================================================================== */
function colomboClock(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  return { wd: p.weekday, mins: h * 60 + Number(p.minute), hhmm: `${String(h).padStart(2, '0')}:${p.minute}` };
}

function marketStatus(date) {
  const { wd, mins, hhmm } = colomboClock(date);
  const weekend = wd === 'Sat' || wd === 'Sun';
  if (!weekend && mins >= CONFIG.openMin && mins < CONFIG.closeMin) {
    return { open: true, hhmm, left: CONFIG.closeMin - mins };
  }
  return { open: false, hhmm, weekend, until: !weekend && mins < CONFIG.openMin ? CONFIG.openMin - mins : null };
}

const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

function marketHoursReply(st) {
  const s = marketStatus();
  let en, si;
  if (s.open) {
    en = `🟢 CSE is OPEN now (Colombo ${s.hhmm}). Closes at 14:30 — ${hm(s.left)} left.`;
    si = `🟢 CSE දැන් OPEN (කොළඹ ${s.hhmm}). 14:30 ට වහනවා — තව ${hm(s.left)}.`;
  } else if (s.until != null) {
    en = `🔴 CSE is closed now (Colombo ${s.hhmm}). Opens at 09:30 — in ${hm(s.until)}.`;
    si = `🔴 CSE දැන් වහලා (කොළඹ ${s.hhmm}). 09:30 ට open — තව ${hm(s.until)}.`;
  } else {
    en = `🔴 CSE is closed now (Colombo ${s.hhmm}${s.weekend ? ', weekend' : ''}). Trading: Mon–Fri 09:30–14:30.`;
    si = `🔴 CSE දැන් වහලා (කොළඹ ${s.hhmm}${s.weekend ? ', සති අන්තය' : ''}). Trading: සඳුදා–සිකුරාදා 09:30–14:30.`;
  }
  const note = pick(st, 'Public holidays are not checked — confirm on cse.lk.', 'Public holidays check කරන්නේ නැහැ — cse.lk බලන්න.', 'Holidays check වෙන්නේ නැහැ — cse.lk එකෙන් confirm කරන්න.');
  return R(`${pick(st, en, si, si)}\n${note}`, { chips: [chip('Top gainers'), chip('ASPI today')] });
}

/* =====================================================================
 * Market movers / index
 * ===================================================================== */
function marketRows() {
  return A.market().map((m) => {
    const s = A.sym(m);
    const p = A.pm(s);
    return {
      symbol: s,
      name: A.name(m),
      price: num(pickKey(m, PRICE_KEYS)) ?? num(pickKey(p, PRICE_KEYS)),
      chg: num(pickKey(m, CHG_KEYS)) ?? num(pickKey(p, CHG_KEYS)),
      turnover: num(pickKey(m, TURN_KEYS)) ?? num(pickKey(p, TURN_KEYS)),
      volume: num(pickKey(m, VOL_KEYS)) ?? num(pickKey(p, VOL_KEYS)),
    };
  }).filter((r) => r.symbol && r.price);
}

async function moversReply(kind, st) {
  try { await ensureMarketSymbols(); } catch { /* offline */ }
  const rows = marketRows();
  if (!rows.length) {
    return R(pick(st,
      'Live market data is not loaded yet. Press R to refresh prices, then ask again.',
      'Live market data තවම load වෙලා නැහැ. R ඔබලා prices refresh කරලා ආයෙ අහන්න.',
      'Market data තවම load වෙලා නැහැ — R ඔබලා refresh කරලා ආයෙ අහන්න.'));
  }
  let list, title;
  if (kind === 'losers') {
    list = rows.filter((r) => r.chg != null && r.chg < 0).sort((a, b) => a.chg - b.chg).slice(0, 5);
    title = pick(st, '— Top losers today —', '— අද වැඩිපුරම බැස්ස —', '— Top losers (අද) —');
  } else if (kind === 'active') {
    list = rows.filter((r) => r.turnover != null || r.volume != null)
      .sort((a, b) => (b.turnover ?? b.volume ?? 0) - (a.turnover ?? a.volume ?? 0)).slice(0, 5);
    title = pick(st, '— Most active (turnover) —', '— වැඩිපුරම trade වුණ —', '— Most active (turnover) —');
  } else {
    list = rows.filter((r) => r.chg != null && r.chg > 0).sort((a, b) => b.chg - a.chg).slice(0, 5);
    title = pick(st, '— Top gainers today —', '— අද වැඩිපුරම නැග්ග —', '— Top gainers (අද) —');
  }
  if (!list.length) {
    return R(pick(st, 'No change data in the current feed.', 'Change data feed එකේ නැහැ.', 'Change data feed එකේ නැහැ.'));
  }
  const lines = [title];
  list.forEach((r, i) => {
    const extra = kind === 'active' && r.turnover != null ? ` · T/O ${fmtRs(r.turnover)}` : '';
    lines.push(`${i + 1}. **${shortSym(r.symbol)}** Rs ${fmtNum(r.price)} ${arrow(r.chg)} ${fmtPct(r.chg)}${extra}`);
  });
  const up = rows.filter((r) => r.chg > 0).length;
  const dn = rows.filter((r) => r.chg < 0).length;
  lines.push('');
  lines.push(pick(st, `Breadth: ${up} up · ${dn} down · ${rows.length - up - dn} flat`, `ඉහළ ${up} · පහළ ${dn} · වෙනසක් නැති ${rows.length - up - dn}`, `Breadth: ${up} up · ${dn} down`));
  lines.push(DISCLAIMER(st));
  const others = [['gainers', 'Top gainers'], ['losers', 'Top losers'], ['active', 'Most active']]
    .filter(([k]) => k !== kind).map(([, l]) => chip(l));
  return R(lines.join('\n'), { chips: [...list.slice(0, 3).map((r) => chip(shortSym(r.symbol))), ...others] });
}

async function indexReply(st) {
  const out = [];
  for (const [ep, label] of [['aspiData', 'ASPI'], ['snpData', 'S&P SL20']]) {
    try {
      const d = await cseCached(ep, {});
      const v = num(pickKey(d, ['value', 'indexValue', 'price']));
      const ch = num(pickKey(d, ['change', 'indexChange']));
      const pc = num(pickKey(d, ['percentage', 'changePercentage', 'percentageChange']));
      if (v != null) out.push(`**${label}**: ${fmtNum(v)} ${arrow(ch ?? pc)} ${ch != null ? fmtNum(ch) : ''} ${pc != null ? '(' + fmtPct(pc) + ')' : ''}`.trim());
    } catch { /* endpoint may not be whitelisted */ }
  }
  if (!out.length) {
    return R(pick(st,
      'Index values are not available in this feed right now. Check the Charts tab or cse.lk.',
      'Index අගයන් දැන් feed එකේ නැහැ. Charts tab හෝ cse.lk බලන්න.',
      'Index data දැන් නැහැ — Charts tab / cse.lk බලන්න.'), { actions: [tabAct('Open Charts', 'charts')] });
  }
  out.push(pick(st, 'ASPI = all shares; S&P SL20 = top 20 large, liquid companies.', 'ASPI = සියලු කොටස්; S&P SL20 = ලොකුම, liquid companies 20.', 'ASPI = all shares, S&P SL20 = top 20 companies.'));
  return R(out.join('\n'), { chips: [chip('Top gainers'), chip('Is market open?')], actions: [tabAct('Open Charts', 'charts')] });
}

/* =====================================================================
 * Calculator in chat
 * ===================================================================== */
const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(k|mn|m|lakhs?|laksha|lakshe)?(?![a-z\d])/gi;

function extractNumbers(raw) {
  // drop full symbols like COMB.N0000 so their digits aren't read as numbers
  const text = String(raw || '').replace(/\b[A-Za-z]{2,8}\.[A-Za-z]\d{4}\b/g, ' ');
  const out = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(text))) {
    const v = parseAmount(m[1], m[2]);
    if (v == null) continue;
    const before = text.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12).toLowerCase();
    out.push({ v, before, after, idx: m.index });
  }
  return out;
}

const PRICE_BEFORE = /(@|\bat\b|\brs\.?|\bprice\b|\bmila\b|\bමිල|\bfor\b|\bcost\b)\s*$/;
const PRICE_AFTER = /^\s*(ta\b|kata\b|ට|\/=|rs\b|rupees?)/;
const QTY_AFTER = /^\s*(shares?|qty|units?|x\b|kotas|කොටස්|ක්)/;
const QTY_BEFORE = /(\bqty\b|\bquantity\b|\bx)\s*$/;
const BOUGHT_BEFORE = /(bought|buy cost|cost|gaththe|gatte|gaththa|gatta|ගත්තේ|ගත්ත)\s*(@|at|rs\.?)?\s*$/;

function parseTrade(raw, sym) {
  const nums = extractNumbers(raw);
  let qty = null, price = null, buyCost = null;
  const used = new Set();
  // bought-at (for sell P/L)
  nums.forEach((n, i) => { if (buyCost == null && BOUGHT_BEFORE.test(n.before)) { buyCost = n.v; used.add(i); } });
  nums.forEach((n, i) => { if (!used.has(i) && price == null && (PRICE_BEFORE.test(n.before) || PRICE_AFTER.test(n.after))) { price = n.v; used.add(i); } });
  nums.forEach((n, i) => { if (!used.has(i) && qty == null && (QTY_AFTER.test(n.after) || QTY_BEFORE.test(n.before))) { qty = n.v; used.add(i); } });
  const rest = nums.filter((_, i) => !used.has(i)).map((n) => n.v);
  if (qty == null && rest.length) qty = rest.shift();
  if (price == null && rest.length) price = rest.shift();
  if (buyCost == null && rest.length) buyCost = rest.shift();
  if (price == null && sym) price = A.price(sym);
  return { qty, price, buyCost };
}

function calcTradeReply(side, raw, sym, st) {
  const { qty, price, buyCost } = parseTrade(raw, sym);
  const cPct = A.commissionPct();
  const c = cPct / 100;
  if (!qty || !price) {
    return R(pick(st,
      'Give me quantity and price, e.g. “buy 100 COMB @ 120” or “sell 50 SAMP at 90 bought 80”.',
      'Qty සහ price දෙන්න. උදා: “buy 100 COMB @ 120” හෝ “sell 50 SAMP at 90 bought 80”.',
      'Qty + price දෙන්න — උදා: “COMB 100 120ට ගත්තා” / “sell 50 SAMP at 90 bought 80”.'),
    { chips: [chip('buy 100 COMB @ 120'), chip('sell 50 SAMP at 90 bought 80')] });
  }
  const label = sym ? `${shortSym(sym)} · ` : '';
  const gross = qty * price;
  const fee = gross * c;
  const lines = [];
  if (side === 'sell') {
    const net = gross - fee;
    lines.push(`— SELL ${label}${fmtNum(qty, 0)} @ Rs ${fmtNum(price)} —`);
    lines.push(`Gross: ${fmtRs(gross)}`);
    lines.push(pick(st, `Commission (${cPct}%): -${fmtRs(fee)}`, `Commission (${cPct}%): -${fmtRs(fee)}`, `Commission (${cPct}%): -${fmtRs(fee)}`));
    lines.push(pick(st, `**You receive: ${fmtRs(net)}**`, `**ඔයාට ලැබෙන්නේ: ${fmtRs(net)}**`, `**Net ලැබෙන්නේ: ${fmtRs(net)}**`));
    if (buyCost) {
      const cost = qty * buyCost * (1 + c);
      const pl = net - cost;
      lines.push('');
      lines.push(pick(st, `Bought @ Rs ${fmtNum(buyCost)} → cost with commission ${fmtRs(cost)}`, `ගත්තේ Rs ${fmtNum(buyCost)} → commission එක්ක cost ${fmtRs(cost)}`, `Buy @ Rs ${fmtNum(buyCost)} → cost ${fmtRs(cost)}`));
      lines.push(`${pl >= 0 ? '✅' : '🔻'} **P/L: ${fmtRs(pl)} (${fmtPct((pl / cost) * 100)})**`);
      const bes = (buyCost * (1 + c)) / (1 - c);
      lines.push(`B.E.S: Rs ${fmtNum(bes)}`);
    }
  } else {
    const total = gross + fee;
    const bes = (price * (1 + c)) / (1 - c);
    lines.push(`— BUY ${label}${fmtNum(qty, 0)} @ Rs ${fmtNum(price)} —`);
    lines.push(`Gross: ${fmtRs(gross)}`);
    lines.push(`Commission (${cPct}%): +${fmtRs(fee)}`);
    lines.push(pick(st, `**Total to pay: ${fmtRs(total)}**`, `**ගෙවන්න ඕන මුළු මුදල: ${fmtRs(total)}**`, `**Total pay: ${fmtRs(total)}**`));
    lines.push(pick(st,
      `Break-even sell (B.E.S): **Rs ${fmtNum(bes)}** (+${fmtNum(((bes / price) - 1) * 100)}%)`,
      `Break-even විකුණුම් මිල (B.E.S): **Rs ${fmtNum(bes)}** (+${fmtNum(((bes / price) - 1) * 100)}%)`,
      `B.E.S (loss නැතුව විකුණන්න අවම මිල): **Rs ${fmtNum(bes)}**`));
  }
  lines.push('');
  lines.push(pick(st, 'Commission % comes from your app setting.', 'Commission % app setting එකෙන්.', 'Commission % app setting එකෙන් ගන්නේ.'));
  return R(lines.join('\n'), { actions: [tabAct('Open Calculator', 'calculator')] });
}

function breakEvenReply(raw, sym, st) {
  const nums = extractNumbers(raw);
  const price = nums[0]?.v ?? (sym ? A.price(sym) : null);
  const cPct = A.commissionPct();
  const c = cPct / 100;
  if (!price) {
    return R(pick(st, 'Tell me the buy price, e.g. “break even 120”.', 'Buy price එක දෙන්න, උදා: “break even 120”.', 'Buy price එක දෙන්න — “BES 120” වගේ.'));
  }
  const bes = (price * (1 + c)) / (1 - c);
  return R(pick(st,
    `Bought @ Rs ${fmtNum(price)} → break-even sell **Rs ${fmtNum(bes)}** (commission ${cPct}% both ways). Sell above this to make a profit.`,
    `Rs ${fmtNum(price)} ට ගත්තොත් → break-even **Rs ${fmtNum(bes)}** (commission ${cPct}% දෙපැත්තටම). මීට වැඩියෙන් විකුණුවොත් ලාභ.`,
    `Rs ${fmtNum(price)} ට ගත්තා නම් B.E.S = **Rs ${fmtNum(bes)}** (${cPct}% commission දෙපැත්තටම). ඊට උඩින් sell කළොත් profit.`));
}

function budgetReply(raw, sym, st) {
  const nums = extractNumbers(raw);
  let budget = null, price = null;
  for (const n of nums) {
    if (budget == null && (/(rs\.?|budget|with|walin|වලින්)\s*$/.test(n.before) || /^\s*(walin|වලින්|budget)/.test(n.after))) budget = n.v;
    else if (price == null && (PRICE_BEFORE.test(n.before) || PRICE_AFTER.test(n.after))) price = n.v;
  }
  const rest = nums.map((n) => n.v).filter((v) => v !== budget && v !== price);
  if (budget == null) budget = rest.length ? Math.max(...rest) : null;
  if (price == null) price = (sym ? A.price(sym) : null) ?? (rest.filter((v) => v !== budget)[0] ?? null);
  const cPct = A.commissionPct();
  if (!budget || !price) {
    return R(pick(st, 'Example: “Rs 100000 with COMB — how many shares?” or “100k at 120 how many”.', 'උදා: “Rs 100000 walin COMB kiyak ganna puluwan?”', 'උදා: “100k walin 120ට කීයක් ගන්න පුළුවන්?”'));
  }
  const qty = Math.floor(budget / (price * (1 + cPct / 100)));
  const spend = qty * price * (1 + cPct / 100);
  return R(pick(st,
    `With ${fmtRs(budget)} at Rs ${fmtNum(price)}${sym ? ' (' + shortSym(sym) + ')' : ''}: **${fmtNum(qty, 0)} shares** (total ${fmtRs(spend)} incl. ${cPct}% commission). Left over: ${fmtRs(budget - spend)}.`,
    `${fmtRs(budget)} වලින් Rs ${fmtNum(price)} ට${sym ? ' (' + shortSym(sym) + ')' : ''}: **කොටස් ${fmtNum(qty, 0)}** (commission ${cPct}% එක්ක ${fmtRs(spend)}). ඉතුරු: ${fmtRs(budget - spend)}.`,
    `${fmtRs(budget)} walin Rs ${fmtNum(price)} ට${sym ? ' (' + shortSym(sym) + ')' : ''} → **shares ${fmtNum(qty, 0)}** (commission එක්ක ${fmtRs(spend)}). ඉතුරු ${fmtRs(budget - spend)}.`),
  { chips: qty > 0 ? [chip(`buy ${qty} ${sym ? shortSym(sym) + ' ' : ''}@ ${price}`)] : [] });
}

function yieldReply(raw, sym, st) {
  const nums = extractNumbers(raw);
  let dps = null, price = null, qty = null;
  for (const n of nums) {
    if (dps == null && /(dividend|dps|ලාභාංශ)\D{0,6}$/.test(n.before)) dps = n.v;
    else if (price == null && (PRICE_BEFORE.test(n.before) || PRICE_AFTER.test(n.after))) price = n.v;
    else if (qty == null && QTY_AFTER.test(n.after)) qty = n.v;
  }
  const rest = nums.map((n) => n.v).filter((v) => v !== dps && v !== price && v !== qty);
  if (dps == null && rest.length) dps = rest.shift();
  if (price == null) price = (sym ? A.price(sym) : null) ?? (rest.length ? rest.shift() : null);
  if (!dps || !price) {
    return R(pick(st, 'Example: “dividend 5 price 100” or “COMB dividend 7.5 yield”.', 'උදා: “dividend 5 price 100”.', 'උදා: “dividend 5 price 100 yield කීයද?”'));
  }
  const y = (dps / price) * 100;
  const lines = [pick(st,
    `Dividend Rs ${fmtNum(dps)} ÷ price Rs ${fmtNum(price)} = **${fmtNum(y)}% yield**`,
    `Dividend Rs ${fmtNum(dps)} ÷ මිල Rs ${fmtNum(price)} = **${fmtNum(y)}% yield**`,
    `Rs ${fmtNum(dps)} dividend / Rs ${fmtNum(price)} = **${fmtNum(y)}% yield**`)];
  if (qty) lines.push(pick(st, `On ${fmtNum(qty, 0)} shares: ${fmtRs(dps * qty)} (before withholding tax).`, `කොටස් ${fmtNum(qty, 0)} කට: ${fmtRs(dps * qty)} (tax කපන්න කලින්).`, `Shares ${fmtNum(qty, 0)}: ${fmtRs(dps * qty)} (tax කලින්).`));
  lines.push(pick(st, 'Past dividends don’t guarantee future ones.', 'කලින් dividend ආව කියලා ඉස්සරහට එනවා කියලා නැහැ.', 'Past dividends = guarantee නෙවෙයි.'));
  return R(lines.join('\n'), { actions: [tabAct('Open Dividends', 'dividends')] });
}

/* =====================================================================
 * Portfolio
 * ===================================================================== */
function portfolioStats() {
  const c = A.commissionPct() / 100;
  const rows = A.holdings().map((h) => {
    const price = A.price(h.symbol);
    const cost = h.qty * h.avg;
    const value = price != null ? h.qty * price : null;
    const pl = value != null ? value - cost : null;
    return { ...h, price, cost, value, pl, plPct: pl != null && cost ? (pl / cost) * 100 : null, chg: A.chg(h.symbol) };
  });
  const priced = rows.filter((r) => r.value != null);
  const totalCost = priced.reduce((s, r) => s + r.cost, 0);
  const totalValue = priced.reduce((s, r) => s + r.value, 0);
  const dayPl = priced.reduce((s, r) => (r.chg != null ? s + r.value - r.value / (1 + r.chg / 100) : s), 0);
  return { rows, priced, totalCost, totalValue, pl: totalValue - totalCost, netIfSold: totalValue * (1 - c) - totalCost, dayPl, c };
}

function portfolioReply(st, focus) {
  const s = portfolioStats();
  if (!s.rows.length) {
    return R(pick(st,
      'Your portfolio is empty (or not loaded). Add shares in the Portfolio tab → + Add share.',
      'Portfolio එක හිස් (හෝ load වෙලා නැහැ). Portfolio tab → + Add share.',
      'Portfolio එකේ shares නැහැ — Portfolio tab එකේ + Add share කරන්න.'),
    { actions: [tabAct('Open Portfolio', 'portfolio')] });
  }
  if (!s.priced.length) {
    return R(pick(st,
      `You have ${s.rows.length} holdings, but live prices aren’t loaded. Press R to refresh.`,
      `Holdings ${s.rows.length}ක් තියෙනවා, live prices load වෙලා නැහැ. R ඔබන්න.`,
      `Holdings ${s.rows.length}ක් තියෙනවා — prices නැහැ, R ඔබලා refresh කරන්න.`));
  }
  const byPct = [...s.priced].filter((r) => r.plPct != null).sort((a, b) => b.plPct - a.plPct);
  const best = byPct[0];
  const worst = byPct[byPct.length - 1];
  const lines = [];

  if (focus === 'best' || focus === 'worst') {
    const r = focus === 'best' ? best : worst;
    lines.push(pick(st,
      `${focus === 'best' ? '🏆 Best' : '🔻 Weakest'} holding: **${shortSym(r.symbol)}** ${fmtPct(r.plPct)} (${fmtRs(r.pl)})`,
      `${focus === 'best' ? '🏆 හොඳම' : '🔻 දුර්වලම'}: **${shortSym(r.symbol)}** ${fmtPct(r.plPct)} (${fmtRs(r.pl)})`,
      `${focus === 'best' ? '🏆 Best' : '🔻 Worst'}: **${shortSym(r.symbol)}** ${fmtPct(r.plPct)} (${fmtRs(r.pl)})`));
    lines.push(`${fmtNum(r.qty, 0)} @ avg Rs ${fmtNum(r.avg)} → now Rs ${fmtNum(r.price)}`);
    return R(lines.join('\n'), { chips: [chip(shortSym(r.symbol)), chip(pick(st, 'My portfolio', 'මගේ portfolio', 'mage portfolio'))] });
  }

  lines.push(pick(st, '— Your portfolio —', '— ඔයාගේ portfolio එක —', '— ඔයාගේ portfolio —'));
  lines.push(pick(st, `Value: ${fmtRs(s.totalValue)} · Cost: ${fmtRs(s.totalCost)}`, `වටිනාකම: ${fmtRs(s.totalValue)} · Cost: ${fmtRs(s.totalCost)}`, `Value ${fmtRs(s.totalValue)} · Cost ${fmtRs(s.totalCost)}`));
  lines.push(`${s.pl >= 0 ? '✅' : '🔻'} **P/L: ${fmtRs(s.pl)} (${fmtPct(s.totalCost ? (s.pl / s.totalCost) * 100 : 0)})**`);
  if (s.dayPl) lines.push(pick(st, `Today: ${fmtRs(s.dayPl)}`, `අද: ${fmtRs(s.dayPl)}`, `අද වෙනස: ${fmtRs(s.dayPl)}`));
  lines.push(pick(st,
    `Net P/L if you sold everything now (after ${fmtNum(s.c * 100)}% sell commission): ${fmtRs(s.netIfSold)}`,
    `දැන් ඔක්කොම විකුණුවොත් ශුද්ධ ලාභය/පාඩුව (commission ${fmtNum(s.c * 100)}% කපලා): ${fmtRs(s.netIfSold)}`,
    `දැන් sell කළොත් net P/L (commission කපලා): ${fmtRs(s.netIfSold)}`));
  lines.push('');
  for (const r of [...s.priced].sort((a, b) => b.value - a.value).slice(0, 8)) {
    lines.push(`**${shortSym(r.symbol)}** ${fmtNum(r.qty, 0)} · Rs ${fmtNum(r.price)} · ${fmtPct(r.plPct)} (${fmtRs(r.pl)})`);
  }
  if (s.priced.length > 8) lines.push(`… +${s.priced.length - 8}`);
  if (best && worst && best !== worst) {
    lines.push('');
    lines.push(`🏆 ${shortSym(best.symbol)} ${fmtPct(best.plPct)} · 🔻 ${shortSym(worst.symbol)} ${fmtPct(worst.plPct)}`);
  }
  const top = [...s.priced].sort((a, b) => b.value - a.value)[0];
  const w = s.totalValue ? (top.value / s.totalValue) * 100 : 0;
  if (w >= 40 && s.priced.length > 1) {
    lines.push(pick(st,
      `ℹ️ ${shortSym(top.symbol)} is ${fmtNum(w, 0)}% of your portfolio — a big share in one stock.`,
      `ℹ️ ${shortSym(top.symbol)} ඔයාගේ portfolio එකෙන් ${fmtNum(w, 0)}% — එක කොටසක ලොකු කොටසක්.`,
      `ℹ️ ${shortSym(top.symbol)} = portfolio එකෙන් ${fmtNum(w, 0)}% — concentration වැඩියි.`));
  }
  if (s.rows.length > s.priced.length) {
    lines.push(pick(st, `(${s.rows.length - s.priced.length} without live price)`, `(live price නැති ${s.rows.length - s.priced.length})`, `(price නැති ${s.rows.length - s.priced.length})`));
  }
  lines.push(DISCLAIMER(st));
  return R(lines.join('\n'), {
    chips: [chip(pick(st, 'Best performer', 'හොඳම share එක', 'best share eka')), chip(pick(st, 'Worst performer', 'දුර්වලම share එක', 'worst share eka'))],
    actions: [tabAct('Open Portfolio', 'portfolio')],
  });
}

function holdingLine(sym, st) {
  const h = A.holdings().find((x) => baseOf(x.symbol) === baseOf(sym));
  if (!h) return null;
  const price = A.price(h.symbol) ?? A.price(sym);
  if (price == null) return pick(st, `In your portfolio: ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)}`, `ඔයාගේ portfolio එකේ: ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)}`, `Portfolio එකේ: ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)}`);
  const pl = h.qty * (price - h.avg);
  const pct = h.avg ? ((price - h.avg) / h.avg) * 100 : 0;
  const c = A.commissionPct() / 100;
  const bes = (h.avg * (1 + c)) / (1 - c);
  return pick(st,
    `📁 You hold ${fmtNum(h.qty, 0)} @ avg Rs ${fmtNum(h.avg)} → P/L ${fmtRs(pl)} (${fmtPct(pct)}) · B.E.S Rs ${fmtNum(bes)}`,
    `📁 ඔයා ළඟ ${fmtNum(h.qty, 0)} @ avg Rs ${fmtNum(h.avg)} → P/L ${fmtRs(pl)} (${fmtPct(pct)}) · B.E.S Rs ${fmtNum(bes)}`,
    `📁 ඔයා ළඟ ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)} → P/L ${fmtRs(pl)} (${fmtPct(pct)}) · B.E.S Rs ${fmtNum(bes)}`);
}

/* =====================================================================
 * Company replies
 * ===================================================================== */
async function fetchCompany(sym) {
  let info = {}, beta = {}, profile = null;
  try {
    const raw = await cseCached('companyInfoSummery', { symbol: sym });
    info = raw?.reqSymbolInfo || {};
    beta = raw?.reqSymbolBetaInfo || {};
  } catch { /* ignore */ }
  try { profile = await cseCached('companyProfile', { symbol: sym }); } catch { /* not whitelisted */ }
  const pm = A.pm(sym);
  return {
    sym: info.symbol || sym,
    info, beta, profile,
    price: num(info.lastTradedPrice ?? info.price) ?? num(pickKey(pm, PRICE_KEYS)) ?? A.price(sym),
    chg: num(info.changePercentage ?? info.percentageChange) ?? num(pickKey(pm, CHG_KEYS)),
    lo52: num(info.p12LowPrice ?? info.ytdLowPrice),
    hi52: num(info.p12HiPrice ?? info.ytdHiPrice),
    mcap: num(info.marketCap),
    betaVal: num(beta.triASIBetaValue ?? beta.betaValueSPSL),
    foreignPct: num(info.foreignPercentage),
    turnover: num(info.tdyTurnover ?? info.turnover),
  };
}

function range52(d, st) {
  if (d.lo52 == null || d.hi52 == null || d.price == null || d.hi52 <= d.lo52) return null;
  const pos = ((d.price - d.lo52) / (d.hi52 - d.lo52)) * 100;
  const filled = Math.max(0, Math.min(10, Math.round(pos / 10)));
  const meter = '■'.repeat(filled) + '□'.repeat(10 - filled);
  return pick(st,
    `52w position: ${meter} ${fmtNum(pos, 0)}% (0 = 52w low, 100 = 52w high)`,
    `52w ස්ථානය: ${meter} ${fmtNum(pos, 0)}% (0 = අවුරුද්දේ අඩුම, 100 = වැඩිම)`,
    `52w position: ${meter} ${fmtNum(pos, 0)}% (0 = low, 100 = high)`);
}

async function quickPriceReply(sym, st) {
  const d = await fetchCompany(sym);
  const lines = [`**${shortSym(d.sym)}** Rs ${fmtNum(d.price)} ${arrow(d.chg)} ${fmtPct(d.chg)}`];
  const r = range52(d, st);
  if (r) lines.push(r);
  const h = holdingLine(sym, st);
  if (h) lines.push(h);
  return R(lines.join('\n'), { chips: [chip(pick(st, 'More details', 'තව විස්තර', 'more details')), chip(`buy 100 ${shortSym(d.sym)}`)] });
}

async function companyReply(hit, st) {
  const sym = hit.symbol;
  const d = await fetchCompany(sym);
  const { info, profile } = d;
  const sum = (profile?.reqComSumInfo && profile.reqComSumInfo[0]) || {};
  const biz = (profile?.infoCompanyBusinessSummary || []).map((b) => (b.body || b.title || '').trim()).filter(Boolean).join('; ');
  const posts = profile?.topPosts || [];

  const name = sum.name || info.name || hit.name || sym;
  const sector = sum.sector || info.sectorName || info.sector || '';
  const board = sum.boardType || '';
  const web = sum.web || '';

  ctx.lastSymbol = d.sym;
  ctx.lastName = name;

  const lines = [];
  lines.push(`**${name}** (${d.sym})`);
  if (sector || board) lines.push(pick(st, `Type: ${[sector, board].filter(Boolean).join(' · ')}`, `වර්ගය: ${[sector, board].filter(Boolean).join(' · ')}`, `Type: ${[sector, board].filter(Boolean).join(' · ')}`));
  if (biz) lines.push(pick(st, `Business: ${biz.slice(0, 400)}${biz.length > 400 ? '…' : ''}`, `ව්‍යාපාරය: ${biz.slice(0, 400)}${biz.length > 400 ? '…' : ''}`, `Business: ${biz.slice(0, 400)}${biz.length > 400 ? '…' : ''}`));
  if (sum.established) lines.push(pick(st, `Established: ${sum.established}`, `ආරම්භය: ${sum.established}`, `Established: ${sum.established}`));
  if (web) lines.push(`Web: ${web.startsWith('http') ? web : 'https://' + web.replace(/^\/\//, '')}`);

  lines.push('');
  lines.push(pick(st, '— Market snapshot —', '— වෙළඳපොළ —', '— Market snapshot —'));
  lines.push(`${pick(st, 'Last', 'අවසාන මිල', 'Last')}: **Rs ${fmtNum(d.price)}** ${arrow(d.chg)} ${fmtPct(d.chg)}`);
  if (info.previousClose != null) lines.push(`Prev close: Rs ${fmtNum(info.previousClose)}`);
  const hi = info.hiTrade ?? info.high;
  const lo = info.lowTrade ?? info.low;
  if (hi != null || lo != null) lines.push(`Today H/L: ${fmtNum(hi)} / ${fmtNum(lo)}`);
  if (d.lo52 != null || d.hi52 != null) lines.push(`52w: ${fmtNum(d.lo52)} – ${fmtNum(d.hi52)}`);
  const r52 = range52(d, st);
  if (r52) lines.push(r52);
  if (info.tdyShareVolume != null) lines.push(`Volume: ${fmtNum(info.tdyShareVolume, 0)}`);
  if (info.tdyTradeVolume != null) lines.push(`Trades: ${fmtNum(info.tdyTradeVolume, 0)}`);
  if (d.turnover != null) lines.push(`Turnover: ${fmtRs(d.turnover)}`);
  if (d.mcap != null) lines.push(`Market cap: ${fmtRs(d.mcap)}${info.marketCapPercentage != null ? ` (${fmtNum(info.marketCapPercentage)}% of market)` : ''}`);
  if (info.quantityIssued != null) lines.push(`Shares issued: ${fmtNum(info.quantityIssued, 0)}`);
  if (d.foreignPct != null) lines.push(pick(st, `Foreign holding: ${fmtNum(d.foreignPct)}%`, `විදේශීය holding: ${fmtNum(d.foreignPct)}%`, `Foreign holding: ${fmtNum(d.foreignPct)}%`));
  if (d.betaVal != null) {
    const bTxt = d.betaVal > 1.1
      ? pick(st, 'moves more than the market', 'market එකට වඩා වැඩියෙන් වෙනස් වෙනවා', 'market එකට වඩා volatile')
      : d.betaVal < 0.9
        ? pick(st, 'moves less than the market', 'market එකට වඩා අඩුවෙන් වෙනස් වෙනවා', 'market එකට වඩා stable')
        : pick(st, 'moves about like the market', 'market එක වගේම', 'market එක වගේම');
    lines.push(`Beta: ${fmtNum(d.betaVal)} (${bTxt})`);
  }

  const h = holdingLine(d.sym, st);
  if (h) { lines.push(''); lines.push(h); }

  if (posts.length) {
    lines.push('');
    lines.push(pick(st, '— Key people —', '— ප්‍රධාන නිලධාරීන් —', '— Key people —'));
    for (const p of posts.slice(0, 5)) {
      const nm = `${(p.firstName || '').trim()} ${(p.lastName || '').trim()}`.trim();
      const role = p.designationOther || '';
      lines.push(role ? `${role}: ${nm}` : nm);
    }
  }
  if (sum.email1) lines.push(`Email: ${sum.email1}`);

  lines.push('');
  lines.push(pick(st,
    'Top shareholders: see the latest annual report or the CSE company page. ' + DISCLAIMER(st),
    'Top shareholders: annual report / CSE company page බලන්න. ' + DISCLAIMER(st),
    'Top shareholders: annual report / CSE page එකේ. ' + DISCLAIMER(st)));

  const s = shortSym(d.sym);
  return R(lines.join('\n'), {
    chips: [
      chip(pick(st, `${s} vs …`, `${s} vs …`, `${s} vs …`), `${s} vs `),
      chip(`buy 100 ${s}`),
      chip(pick(st, 'Dividend yield', 'Dividend yield', 'dividend yield'), `${s} dividend yield`),
    ],
    actions: [tabAct('Fundamentals', 'fundamentals'), tabAct('Technical', 'technical'), { label: 'cse.lk', url: 'https://www.cse.lk/' }],
  });
}

async function compareReply(symA, symB, st) {
  const [ra, rb] = await Promise.all([resolveBySymbol(symA), resolveBySymbol(symB)]);
  if (!ra || !rb) return R(pick(st, 'Could not find both companies. Use symbols, e.g. “COMB vs SAMP”.', 'Companies දෙකම හොයාගන්න බැරි වුණා. “COMB vs SAMP” වගේ symbols දෙන්න.', 'දෙකම match වුණේ නැහැ — “COMB vs SAMP” වගේ දාන්න.'));
  const [a, b] = await Promise.all([fetchCompany(ra.symbol), fetchCompany(rb.symbol)]);
  const pos = (d) => (d.lo52 != null && d.hi52 != null && d.price != null && d.hi52 > d.lo52 ? `${fmtNum(((d.price - d.lo52) / (d.hi52 - d.lo52)) * 100, 0)}%` : '—');
  const row = (label, fa, fb) => `${label}: **${fa}** | **${fb}**`;
  const A1 = shortSym(a.sym), B1 = shortSym(b.sym);
  const lines = [
    `— ${A1}  vs  ${B1} —`,
    row(pick(st, 'Price', 'මිල', 'Price'), `Rs ${fmtNum(a.price)}`, `Rs ${fmtNum(b.price)}`),
    row(pick(st, 'Today', 'අද', 'Today'), fmtPct(a.chg), fmtPct(b.chg)),
    row('52w pos', pos(a), pos(b)),
    row('Mkt cap', a.mcap != null ? fmtRs(a.mcap) : '—', b.mcap != null ? fmtRs(b.mcap) : '—'),
    row('Beta', fmtNum(a.betaVal), fmtNum(b.betaVal)),
    row(pick(st, 'Foreign %', 'විදේශීය %', 'Foreign %'), a.foreignPct != null ? fmtNum(a.foreignPct) + '%' : '—', b.foreignPct != null ? fmtNum(b.foreignPct) + '%' : '—'),
    row('Turnover', a.turnover != null ? fmtRs(a.turnover) : '—', b.turnover != null ? fmtRs(b.turnover) : '—'),
    '',
    pick(st, 'For P/E, P/BV and EPS use the Fundamentals tab. ' + DISCLAIMER(st), 'P/E, P/BV, EPS සඳහා Fundamentals tab. ' + DISCLAIMER(st), 'P/E, P/BV → Fundamentals tab. ' + DISCLAIMER(st)),
  ];
  ctx.lastSymbol = a.sym;
  return R(lines.join('\n'), { chips: [chip(A1), chip(B1)], actions: [tabAct('Fundamentals', 'fundamentals')] });
}

/* =====================================================================
 * Glossary
 * ===================================================================== */
const GLOSSARY = [
  { re: /\baspi\b/, en: 'ASPI (All Share Price Index): tracks the price movement of all listed shares on the CSE — the main “market up/down” number.', si: 'ASPI (All Share Price Index): CSE එකේ list වෙලා තියෙන සියලු කොටස් වල මිල වෙනස පෙන්නන index එක — market එක නැග්ගද බැස්සද කියන ප්‍රධාන අගය.' },
  { re: /s&?p\s*sl\s*20|\bsl20\b|\bsnp\b/, en: 'S&P SL20: index of 20 large, liquid CSE companies — like a “blue-chip” gauge.', si: 'S&P SL20: ලොකු, වැඩිපුර trade වෙන CSE companies 20ක index එක — “blue-chip” මිනුමක් වගේ.' },
  { re: /\bxd\b|ex.?dividend/, en: 'XD (ex-dividend): from this date, buyers do NOT get the announced dividend. You must own the share before the XD date. Price often drops by about the dividend on XD.', si: 'XD (ex-dividend): මේ දින සිට ගන්න අයට announce කරපු dividend එක ලැබෙන්නේ නැහැ. XD දිනයට කලින් කොටස තියෙන්න ඕන. XD දවසේ මිල dividend එක තරමින් බහින එක සාමාන්‍යයි.' },
  { re: /p\s*\/\s*e\b|\bpe ratio|\bper\b|price.?to.?earnings/, en: 'P/E = Price ÷ EPS. How many rupees you pay for Rs 1 of yearly profit. Lower can mean cheaper, but compare within the same sector.', si: 'P/E = මිල ÷ EPS. අවුරුද්දක ලාභයෙන් Rs 1කට ඔයා ගෙවන ගාණ. අඩු නම් ලාභයි වගේ පේනවා — ඒත් එකම sector එකේ companies එක්ක compare කරන්න.' },
  { re: /p\s*\/\s*bv|\bpbv\b|price.?to.?book|\bp\/b\b/, en: 'P/BV = Price ÷ Net assets per share (book value). Below 1 means the market values the company below its book value.', si: 'P/BV = මිල ÷ කොටසකට net assets (book value). 1ට අඩු නම් market එක company එක book value එකට වඩා අඩුවෙන් අගයනවා.' },
  { re: /\beps\b|earnings per share/, en: 'EPS (Earnings per share) = Net profit ÷ number of shares.', si: 'EPS = ශුද්ධ ලාභය ÷ කොටස් ගණන. කොටසකට ලාභය.' },
  { re: /\bdps\b|dividend per share/, en: 'DPS (Dividend per share): cash paid per share. Yield = DPS ÷ price × 100.', si: 'DPS: කොටසකට ගෙවන dividend මුදල. Yield = DPS ÷ මිල × 100.' },
  { re: /dividend yield|\byield\b/, en: 'Dividend yield = DPS ÷ current price × 100. Try: “dividend 5 price 100”.', si: 'Dividend yield = DPS ÷ දැන් මිල × 100. උදා: “dividend 5 price 100”.' },
  { re: /\bb\.?e\.?s\b|break.?even/, en: 'B.E.S (break-even sell): the sell price where you make zero profit after paying commission on both buy and sell. Try: “break even 120”.', si: 'B.E.S: ගන්නකොටයි විකුණනකොටයි commission ගෙව්වට පස්සේ ලාභයක්/පාඩුවක් නැති විකුණුම් මිල. උදා: “break even 120”.' },
  { re: /\bcds\b|central depository/, en: 'CDS (Central Depository System): your electronic share account. Brokers open it for you; shares you buy are held there.', si: 'CDS: ඔයාගේ electronic කොටස් ගිණුම. Broker කෙනෙක් open කරලා දෙනවා; ගන්න කොටස් තියෙන්නේ එතන.' },
  { re: /market cap/, en: 'Market cap = price × total shares issued — the market value of the whole company.', si: 'Market cap = මිල × නිකුත් කරපු කොටස් ගණන — company එකේම market වටිනාකම.' },
  { re: /\bbeta\b/, en: 'Beta: how much a share moves vs the market. 1 = same as market, >1 = swings more, <1 = steadier.', si: 'Beta: market එකට සාපේක්ෂව කොටස කොච්චර වෙනස් වෙනවද. 1 = market එක වගේ, >1 = වැඩියෙන් පනිනවා, <1 = ස්ථාවරයි.' },
  { re: /\bturnover\b/, en: 'Turnover: total rupee value traded (price × shares) in a period.', si: 'Turnover: කාලයක් ඇතුළත trade වුණ මුළු රුපියල් අගය (මිල × කොටස්).' },
  { re: /52.?w|52.?week/, en: '52-week range: lowest and highest price in the last year. Position shows where today’s price sits in that range.', si: '52-week range: පහුගිය අවුරුද්දේ අඩුම සහ වැඩිම මිල. Position එකෙන් අද මිල ඒ range එකේ කොහෙද කියලා පේනවා.' },
  { re: /rights? issue/, en: 'Rights issue: existing shareholders get the right to buy new shares, usually at a discount, in proportion to what they own.', si: 'Rights issue: දැනට ඉන්න shareholders ලට තියෙන කොටස් අනුපාතයට අලුත් කොටස් (සාමාන්‍යයෙන් අඩු මිලට) ගන්න අයිතිය.' },
  { re: /\bipo\b/, en: 'IPO: a company selling shares to the public for the first time.', si: 'IPO: company එකක් මුල්ම වතාවට public එකට කොටස් විකුණන එක.' },
  { re: /(sell|near)\s*signal|signals?\b/, en: 'SELL / NEAR are the app’s rule-based hints on your holdings (see Guides for the exact rule). They are reminders to check — not advice.', si: 'SELL / NEAR කියන්නේ ඔයාගේ holdings වලට app එක දෙන rule-based hints (නිවැරදි rule එක Guides වල). Check කරන්න මතක් කිරීමක් විතරයි — advice නෙවෙයි.' },
];

function glossaryMatch(q) {
  return GLOSSARY.find((g) => g.re.test(q)) || null;
}

/* =====================================================================
 * FAQ (app help)
 * ===================================================================== */
const FAQ = [
  {
    re: /(about|what is|mokakda|මොකද).*(this )?(app|site|website|cse portfolio)|cse portfolio|මේක මොකද|app එක මොකද|website එක මොකද|meka mokakda/,
    reply: (st) => R(pick(st,
      'CSE Portfolio is a free CSE tool: track shares, buy/sell calculator with commission, dividends, news, fundamentals & charts. Not investment advice.',
      'CSE Portfolio = CSE investors ලට free tool එකක්. Shares track, calculator, dividends, news, charts. Investment advice නෙවෙයි.',
      'CSE Portfolio කියන්නේ free CSE tool එකක් — portfolio track, calculator (commission එක්ක), dividends, news. Advice නෙවෙයි, numbers organise කරන්න.'),
    { chips: [chip('What can you do?'), chip('Is market open?')] }),
  },
  {
    re: /how (to )?use|how (does|do) (it|this|the app) work|කොහොමද (පාවිච්චි|භාවිතා|use)|use karanne kohomada/,
    reply: (st) => R(pick(st,
      'Use the top tabs: Portfolio, Calculator, Dividends, Charts, History, News, Fundamentals, Technical. Shortcuts: 1–8 switch tabs, R refresh, / search, T theme, ? help. Guides are in the footer.',
      'උඩ tabs: Portfolio, Calculator, Dividends, News… Shortcuts: 1–8 tabs, R refresh, / search, T theme. Footer එකේ Guides.',
      'Tabs උඩින් switch කරන්න (1–8 keys). R = refresh, / = search, T = theme. Guides footer එකේ.'),
    { chips: [chip('Open calculator'), chip('Open portfolio')] }),
  },
  {
    re: /calculator|commission|කැල්කියුලේටර්|කොමිස්/,
    reply: (st) => R(pick(st,
      'Calculator: BUY or SELL → qty + price. Uses commission % in the header. Shows total/net and break-even sell. Or just ask me: “buy 100 COMB @ 120”.',
      'Calculator: BUY/SELL තෝරලා qty + price දාන්න. Header commission use වෙනවා. නැත්නම් මට කියන්න: “buy 100 COMB @ 120”.',
      'Calculator tab → BUY/SELL → qty + price. නැත්නම් මෙතනම type කරන්න: “COMB 100 120ට ගත්තා”.'),
    { chips: [chip('buy 100 COMB @ 120'), chip('break even 120')], actions: [tabAct('Open Calculator', 'calculator')] }),
  },
  {
    re: /how.*(add|track).*(share|portfolio)|portfolio.*(how|kohomada|කොහොමද)|add share/,
    reply: (st) => R(pick(st,
      'Portfolio: + Add share with symbol, qty, avg price. Live prices when available. B.E.S = break-even after commission. Sign in to sync devices.',
      'Portfolio: + Add share → symbol, qty, avg price. B.E.S = commission එක්ක break-even. Sync = Sign in.',
      'Portfolio tab එකේ + Add share. Qty + avg price දාන්න. Sync ඕන නම් Sign in.'),
    { actions: [tabAct('Open Portfolio', 'portfolio')] }),
  },
  {
    re: /dividend|ලාභාංශ|ඩිවිඩන්/,
    reply: (st) => R(pick(st,
      'Dividends tab: seasonality hints, log events, estimates. Confirm official XD dates on the CSE — patterns are history only.',
      'Dividends tab එකේ patterns + log. Official XD CSE එකෙන් confirm කරන්න.',
      'Dividends tab බලන්න. Official announcement CSE එකෙන් check කරන්න.'),
    { chips: [chip('What is XD?'), chip('dividend 5 price 100')], actions: [tabAct('Open Dividends', 'dividends')] }),
  },
  {
    re: /\bnews\b|පුවත්/,
    reply: (st) => R(pick(st,
      'News tab: CSE-related + local media headlines, with filters. Verify important news officially before trading.',
      'News tab එකේ headlines + filters. Trade කරන්න කලින් official source බලන්න.',
      'News tab → filters තියෙනවා. වැදගත් එකක් official source එකෙන් confirm.'),
    { actions: [tabAct('Open News', 'news')] }),
  },
  {
    re: /sign ?in|log ?in|account|register|recovery|password|sync|ගිණුම|ලොගින්|සයින්/,
    reply: (st) => R(pick(st,
      'Without an account you can use calculator, news, guides. Sign in to save your portfolio across devices. Save your recovery code when you register.',
      'Account නැතුව calculator, news, guides OK. Portfolio save ඕන නම් Sign in. Recovery code save කරන්න.',
      'Guest = tools OK. Save/sync ඕන නම් Sign in. Recovery code එක miss කරන්න එපා.')),
  },
  {
    re: /backup|export|import/,
    reply: (st) => R(pick(st,
      'Settings → Export backup saves your portfolio as a file; Import restores it. Good to do before clearing browser data.',
      'Settings → Export backup එකෙන් file එකක් save වෙනවා; Import එකෙන් ආපහු දාන්න පුළුවන්.',
      'Settings → Export/Import backup. Browser clear කරන්න කලින් export කරන්න.')),
  },
  {
    re: /notif|alert/,
    reply: (st) => R(pick(st,
      'Settings → enable browser notifications to get SELL/NEAR signal alerts. Auto-refresh can run every 1, 2 or 5 min, optionally only in trading hours.',
      'Settings → browser notifications on කළොත් SELL/NEAR alerts එනවා. Auto-refresh 1/2/5 min.',
      'Settings එකේ notifications on කරන්න — SELL/NEAR alerts. Auto-refresh 1/2/5 min.')),
  },
  {
    re: /guide|tutorial|ගයිඩ්|උගන්ව|learn/,
    reply: (st) => R(pick(st,
      'Footer → Guides (/guides/) — short articles on tracking, commission, break-even, dividends, ASPI, CDS, common mistakes, market hours.',
      'Footer එකේ Guides හෝ /guides/ — CSE basics articles.',
      'Guides footer එකේ — tracking, commission, break-even වගේ.'),
    { actions: [{ label: 'Open Guides', url: '/guides/' }] }),
  },
  {
    re: /contact|support|feedback|සම්බන්ධ/,
    reply: (st) => R(pick(st, 'Footer → Contact page for site questions or feedback.', 'Footer එකේ Contact page බලන්න.', 'Contact = footer link.')),
  },
  {
    re: /shortcut|keyboard/,
    reply: (st) => R(pick(st,
      'Shortcuts: 1–8 tabs · ←/→ move tabs · R refresh prices · / search · T theme · ? help · Esc close.',
      'Shortcuts: 1–8 tabs · R refresh · / search · T theme · ? help · Esc close.',
      'Shortcuts: 1–8 tabs, R refresh, / search, T theme, ? help.')),
  },
];

/* =====================================================================
 * Small talk
 * ===================================================================== */
function isGreeting(q) {
  const t = (q || '').trim().toLowerCase();
  if (!t) return false;
  if (/how\s*are\s*you|how\s*r\s*u|howre\s*you|how\s*do\s*you\s*do/.test(t)) return true;
  if (/ඔබට\s*කොහොමද|ඔයාට\s*කොහොමද|ඔබ\s*කොහොමද|^කොහොමද\s*[.?!]*$/.test(q)) return true;
  if (/obata\s*kohomada|oyata\s*kohomada|^kohomada\??$|oba\s*kohomada/.test(t)) return true;
  if (/^(hi|hello|hey|ayubowan|ayu|good (morning|afternoon|evening)|හායි|ආයුබෝවන්)[!.?\s]*$/i.test(t)) return true;
  if (/^(hi|hello|hey)\b/.test(t) && t.length < 20) return true;
  return false;
}

function greetingReply(st) {
  const s = marketStatus();
  const mk = s.open
    ? pick(st, ' Market is open now 🟢.', ' Market එක දැන් open 🟢.', ' Market open 🟢.')
    : pick(st, ' Market is closed now.', ' Market එක දැන් වහලා.', ' Market closed.');
  return R(pick(st,
    `Hi! 😊${mk} Ask me about your portfolio, any CSE company (COMB, SAMP…), or the calculator.`,
    `ආයුබෝවන්! 😊${mk} Portfolio එක, company එකක් (COMB, SAMP…) හෝ calculator ගැන අහන්න.`,
    `Hi! 😊${mk} Portfolio, company එකක් (COMB) හෝ calculator ගැන අහන්න.`), { chips: starterChips(st) });
}

function starterChips(st) {
  return [
    chip(pick(st, 'My portfolio', 'මගේ portfolio', 'mage portfolio')),
    chip('Top gainers'),
    chip('COMB'),
    chip('buy 100 COMB @ 120'),
    chip(pick(st, 'Is market open?', 'Market open ද?', 'market open da?')),
  ];
}

function capabilitiesReply(st) {
  return R(pick(st,
    'I can:\n• Show any CSE company — type COMB or a name\n• Compare: “COMB vs SAMP”\n• Your portfolio P/L, best & worst\n• Calculate: “buy 100 COMB @ 120”, “break even 120”, “100k with COMB how many”\n• Market: top gainers/losers, ASPI, open/closed\n• Explain terms: XD, P/E, B.E.S, beta…\n• Open tabs: “open news”\nI don’t give buy/sell advice.',
    'මට පුළුවන්:\n• CSE company එකක් — COMB හෝ නම type කරන්න\n• Compare: “COMB vs SAMP”\n• ඔයාගේ portfolio P/L, හොඳම/දුර්වලම\n• Calculate: “buy 100 COMB @ 120”, “break even 120”\n• Market: gainers/losers, ASPI, open ද\n• වචන තේරුම්: XD, P/E, B.E.S…\n• Tabs open: “news open කරන්න”\nBuy/sell advice දෙන්නේ නැහැ.',
    'මට කරන්න පුළුවන්:\n• Company info — COMB / නම type කරන්න\n• “COMB vs SAMP” compare\n• mage portfolio P/L, best/worst\n• “COMB 100 120ට ගත්තා” → calculate\n• Gainers/losers, ASPI, market open da\n• XD, P/E, B.E.S තේරුම\n• “news ekata yanna” → tab open\nAdvice නම් නැහැ.'),
  { chips: starterChips(st) });
}

/* =====================================================================
 * AI fallback (optional)
 * ===================================================================== */
async function askAI(query, st) {
  if (!CONFIG.aiEndpoint) return null;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), CONFIG.aiTimeoutMs) : null;
  try {
    const s = marketStatus();
    const context = [
      `Market: ${s.open ? 'open' : 'closed'} (Colombo ${s.hhmm}).`,
      ctx.lastSymbol ? `Last company discussed: ${ctx.lastName || ''} ${ctx.lastSymbol}, price Rs ${fmtNum(A.price(ctx.lastSymbol))}.` : '',
      `Reply language style: ${st === 'si' ? 'Sinhala' : st === 'mix' ? 'Sinhala-English mix' : 'English'}.`,
    ].filter(Boolean).join('\n');
    const res = await fetch(CONFIG.aiEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [...ctx.turns.slice(-8), { role: 'user', content: query }], context }),
      signal: ctl?.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';
    return reply ? R(reply) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* =====================================================================
 * Intent router
 * ===================================================================== */
const RX = {
  sell: /\b(sell|sold|selling|wikk|vikk|wikun|vikun|wikka|vikka|wikkuwa)\w*|විකුණ|වික්ක/i,
  buy: /\b(buy|bought|buying|gaththa|gatta|gatte|gaththe|ganna|ganne)\b|ගත්ත|ගන්න/i,
  breakeven: /break.?even|\bb\.?e\.?s\b/i,
  budget: /how many shares|how many can|\bkiyak\b|\bkeeyak\b|කීයක්|කොච්චර ගන්න|walin|වලින්|\bbudget\b/i,
  yield: /\byield\b|dividend\s*\d|\bdps\s*\d/i,
  portfolio: /\b(my|mage|mge)\s*(portfolio|holdings?|shares?)|portfolio\s*(summary|eka|kohomada|status|value|p\/?l)|මගේ\s*(portfolio|පෝට්ෆෝලියෝ|කොටස්)|\b(profit|loss|p\/l|pnl|labaya|padu|parada)\b|ලාභ|පාඩු|how am i doing/i,
  best: /\b(best|top|hodama|honda)\b.*\b(share|holding|performer|stock|eka)|හොඳම/i,
  worst: /\b(worst|weakest|bad|narakama|weakest)\b.*\b(share|holding|performer|stock|eka)|දුර්වලම|නරකම/i,
  gainers: /gainers?|top up|wadiyenma nagga|නැග්ග|ඉහළ ගිය/i,
  losers: /losers?|losing|bassa|බැස්ස|පහළ ගිය/i,
  active: /most active|most traded|active shares|turnover top|වැඩිපුරම trade/i,
  marketToday: /market (today|ada|summary|update)|ada market|අද market|how is (the )?market/i,
  index: /\b(aspi|s&?p\s*sl\s*20|sl20|index)\b.*\b(today|now|ada|value|kiyada|keeyada|how)\b|\b(today|ada|now)\b.*\b(aspi|sl20|index)\b|^(aspi|sl20|s&p sl20)\s*\??$/i,
  hours: /market (open|close|hours|time)|is (the )?market open|trading hours|open da|open ද|වහලද|open wela|when.*(open|close)/i,
  compare: /\bvs\.?\b|\bversus\b|compare|සසඳ|saha.*compare/i,
  advice: /should i (buy|sell)|recommend|which (share|stock) (to|should)|good (share|stock) to buy|hoda share|ganna hodada|මිලදී ගන්නද|ගන්න හොඳද|tip eka|tip එක|predict|will .* (go up|rise|fall)/i,
  open: /\b(open|go to|goto|show|yanna|open karanna|ekata)\b|යන්න|open කරන්න/i,
  caps: /what can you do|help me|what do you do|features|මොනවද කරන්න පුළුවන්|monawada karanna puluwan|^help$/i,
  thanks: /^(thanks|thank you|thx|ty|sthuthi|isthuthi|ස්තූතියි|ස්තුතියි)[!.\s]*$/i,
  clear: /^(clear|reset|clear chat|new chat)$/i,
  followup: /\b(price|mila|eke|it|its|that|details|more|wisthara|52w|beta|market cap|mcap)\b|මිල|විස්තර|ඒකේ/i,
  companyWord: /company|share|stock|plc|ltd|overview|details|symbol|ticker|ගැන|කොටස|මිල|විස්තර|plantations?|bank|finance|holdings?|hotels?|tobacco|leasing|insurance|about\s+|gana\b/i,
};

async function respond(query) {
  const raw = (query || '').trim();
  const st = style(raw);
  if (!raw) return capabilitiesReply(st);
  const q = raw.toLowerCase();

  if (RX.clear.test(q)) return { clear: true, ...R(pick(st, 'Chat cleared.', 'Chat එක clear කළා.', 'Chat clear කළා.')) };
  if (isGreeting(raw)) return greetingReply(st);
  if (RX.thanks.test(q)) return R(pick(st, 'You’re welcome! 😊', 'සතුටුයි! 😊', 'Welcome! 😊'));
  if (RX.caps.test(q)) return capabilitiesReply(st);

  // Load symbols only if the text might contain one (cheap check)
  if (/[A-Za-z]{2,}/.test(raw)) {
    try { await ensureMarketSymbols(); } catch { /* offline */ }
  }
  const { found: syms, suggestions } = detectSymbols(raw);
  const sym = syms[0] || null;
  const hasNum = /\d/.test(raw.replace(/\b[A-Za-z]{2,8}\.[A-Za-z]\d{4}\b/g, ''));

  // 1) Advice requests → no advice, but offer data
  if (RX.advice.test(q)) {
    return R(pick(st,
      'I can’t say buy or sell — only tools and info. Check with a licensed adviser and your broker.' + (sym ? ` I can show ${shortSym(sym)}’s numbers though:` : ''),
      'Buy/sell advice දෙන්න බැහැ — tools සහ info විතරයි. Licensed adviser / broker එක්ක කතා කරන්න.' + (sym ? ` ${shortSym(sym)} ගැන numbers පෙන්නන්නම්:` : ''),
      'Advice දෙන්න බැහැ — decide කරන්න ඕන ඔයාගේ broker/adviser එක්ක.' + (sym ? ` ${shortSym(sym)} data බලන්න:` : '')),
    { chips: sym ? [chip(shortSym(sym)), chip(`${shortSym(sym)} 52w`)] : [chip('Top gainers'), chip('What is P/E?')] });
  }

  // 2) Calculator-style requests
  if (hasNum && RX.breakeven.test(q)) return breakEvenReply(raw, sym, st);
  if (hasNum && RX.yield.test(q)) return yieldReply(raw, sym, st);
  if (hasNum && RX.budget.test(q)) return budgetReply(raw, sym, st);
  if ((RX.sell.test(raw) || RX.buy.test(raw) || /@/.test(raw)) && (hasNum || sym) && !/how|කොහොමද|kohomada/.test(q)) {
    const nums = extractNumbers(raw);
    if (nums.length >= 2 || (nums.length >= 1 && sym)) {
      return calcTradeReply(RX.sell.test(raw) ? 'sell' : 'buy', raw, sym, st);
    }
  }

  // 3) Compare two companies
  if (syms.length >= 2 && (RX.compare.test(q) || syms.length === 2 && raw.split(/\s+/).length <= 4)) {
    return compareReply(syms[0], syms[1], st);
  }
  if (RX.compare.test(q) && syms.length === 1 && ctx.lastSymbol && baseOf(ctx.lastSymbol) !== baseOf(syms[0])) {
    return compareReply(ctx.lastSymbol, syms[0], st);
  }

  // 4) Portfolio
  if (RX.best.test(q) && /portfolio|holding|mage|my|මගේ|share/.test(q)) return portfolioReply(st, 'best');
  if (RX.worst.test(q) && /portfolio|holding|mage|my|මගේ|share/.test(q)) return portfolioReply(st, 'worst');
  if (RX.portfolio.test(raw) && !sym && !/how to|add share|කොහොමද add/.test(q)) return portfolioReply(st);

  // 5) Market
  if (RX.hours.test(q)) return marketHoursReply(st);
  if (RX.index.test(q)) return indexReply(st);
  if (RX.active.test(q)) return moversReply('active', st);
  if (RX.losers.test(q)) return moversReply('losers', st);
  if (RX.gainers.test(q) || RX.marketToday.test(q)) return moversReply('gainers', st);

  // 6) Open a tab
  if (RX.open.test(q) && raw.split(/\s+/).length <= 6) {
    const t = TABS.find((x) => x.re.test(q));
    if (t) {
      return { navigate: t.id, ...R(pick(st, `Opening ${t.label} ↗`, `${t.label} open කරනවා ↗`, `${t.label} open කළා ↗`)) };
    }
  }

  // 7) Glossary ("what is XD", "P/E kiyanne mokakda")
  const g = glossaryMatch(q);
  if (g && !sym && (raw.split(/\s+/).length <= 7)) {
    return R(pick(st, g.en, g.si, g.si), { chips: [chip('What can you do?')] });
  }

  // 8) Company by symbol
  if (sym) {
    const hit = await resolveBySymbol(sym);
    if (hit) {
      ctx.lastSymbol = hit.symbol;
      ctx.lastName = hit.name;
      if (/\b(price|mila)\b|මිල|\b52w\b/.test(q) && raw.split(/\s+/).length <= 4) return quickPriceReply(hit.symbol, st);
      return companyReply(hit, st);
    }
  }

  // 9) App FAQ
  for (const f of FAQ) if (f.re.test(q) || f.re.test(raw)) return f.reply(st);

  // 10) Follow-up on last company
  if (ctx.lastSymbol && RX.followup.test(raw) && raw.split(/\s+/).length <= 6) {
    if (/details|more|wisthara|විස්තර/.test(q)) return companyReply({ symbol: ctx.lastSymbol, name: ctx.lastName }, st);
    return quickPriceReply(ctx.lastSymbol, st);
  }

  // 11) Company by name
  if (RX.companyWord.test(raw) || raw.split(/\s+/).length <= 3) {
    const hit = await resolveByName(raw);
    if (hit) return companyReply(hit, st);
  }

  // 12) Typo suggestions
  if (suggestions.length) {
    const s = suggestions[0];
    return R(pick(st, `I couldn’t find ${s.typed}. Did you mean **${s.best}**?`, `${s.typed} හම්බුණේ නැහැ. **${s.best}** ද?`, `${s.typed} නැහැ — **${s.best}** ද කිව්වේ?`), { chips: [chip(s.best)] });
  }

  // 13) Glossary (looser) → AI → fallback
  if (g) return R(pick(st, g.en, g.si, g.si));
  const ai = await askAI(raw, st);
  if (ai) return ai;

  return R(pick(st,
    'Sorry, I didn’t get that. Try one of these:',
    'සමාවෙන්න, තේරුණේ නැහැ. මේවා try කරන්න:',
    'Sorry, තේරුණේ නැහැ. මේ වගේ අහන්න:'), { chips: starterChips(st) });
}

/* =====================================================================
 * UI
 * ===================================================================== */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function translateUrl(text, toLang) {
  return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(toLang || 'si')}&text=${encodeURIComponent(text)}&op=translate`;
}

/** Safe mini-markdown: **bold**, URLs, “— header —” lines. No innerHTML. */
function renderRich(node, text) {
  String(text).split('\n').forEach((line, i) => {
    if (i) node.appendChild(document.createElement('br'));
    const isHdr = /^—.*—$/.test(line.trim());
    const target = isHdr ? node.appendChild(el('strong', 'cse-chat-h')) : node;
    const re = /(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) target.appendChild(document.createTextNode(line.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('**')) {
        target.appendChild(el('strong', null, tok.slice(2, -2)));
      } else {
        const a = document.createElement('a');
        a.href = tok;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = tok;
        target.appendChild(a);
      }
      last = m.index + tok.length;
    }
    if (last < line.length) target.appendChild(document.createTextNode(line.slice(last)));
  });
}

const plain = (t) => String(t).replace(/\*\*/g, '');

function store(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ }
}
function load(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? def; } catch { return def; }
}

export function initChatbot() {
  if ($('#cseChatRoot')) return;

  const root = el('div', 'cse-chat');
  root.id = 'cseChatRoot';

  const panel = el('div', 'cse-chat-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Help chat');

  const head = el('div', 'cse-chat-head');
  const title = el('div', 'cse-chat-title');
  title.appendChild(el('strong', null, 'CSE Assistant'));
  const sub = el('span', 'cse-chat-sub', 'EN · සිංහල · Singlish');
  title.appendChild(sub);
  const status = el('span', 'cse-chat-status');
  title.appendChild(status);
  head.appendChild(title);

  const headBtns = el('div', 'cse-chat-headbtns');
  const clearBtn = el('button', 'cse-chat-iconbtn', '🗑');
  clearBtn.type = 'button';
  clearBtn.title = 'Clear chat';
  clearBtn.setAttribute('aria-label', 'Clear chat');
  const closeBtn = el('button', 'cse-chat-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  headBtns.append(clearBtn, closeBtn);
  head.appendChild(headBtns);

  const msgs = el('div', 'cse-chat-msgs');
  msgs.id = 'cseChatMsgs';
  msgs.setAttribute('aria-live', 'polite');

  const chips = el('div', 'cse-chat-chips');

  const form = document.createElement('form');
  form.className = 'cse-chat-form';
  const input = el('input', 'cse-chat-input');
  input.type = 'text';
  input.id = 'cseChatInput';
  input.placeholder = 'Ask… e.g. COMB, mage portfolio, buy 100 COMB @ 120';
  input.autocomplete = 'off';
  input.maxLength = 300;
  form.appendChild(input);

  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  let micBtn = null;
  if (SR) {
    micBtn = el('button', 'cse-chat-mic', '🎤');
    micBtn.type = 'button';
    micBtn.title = 'Voice input (EN / සිං)';
    micBtn.setAttribute('aria-label', 'Voice input');
    form.appendChild(micBtn);
  }
  const sendBtn = el('button', 'cse-chat-send', '➤');
  sendBtn.type = 'submit';
  sendBtn.setAttribute('aria-label', 'Send');
  form.appendChild(sendBtn);

  panel.append(head, msgs, chips, form);

  const fab = el('button', 'cse-chat-fab', '💬');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Open help chat');
  fab.setAttribute('aria-expanded', 'false');
  fab.title = 'Help';

  root.append(panel, fab);
  document.body.appendChild(root);

  /* ---------- state ---------- */
  let history = load(CONFIG.historyKey, []);
  if (!Array.isArray(history)) history = [];
  let inputs = load(CONFIG.inputHistoryKey, []);
  if (!Array.isArray(inputs)) inputs = [];
  let inputIdx = -1;
  let lastStyle = 'en';
  let busy = false;

  const persist = () => store(CONFIG.historyKey, history.slice(-CONFIG.maxHistory));

  function updateStatus() {
    const s = marketStatus();
    status.textContent = s.open ? '● Market open' : '● Market closed';
    status.classList.toggle('open', s.open);
  }

  function setChips(list) {
    chips.replaceChildren();
    for (const c of list || []) {
      const b = el('button', 'cse-chat-chip', c.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (/ $/.test(c.q)) { input.value = c.q; input.focus(); return; } // e.g. "COMB vs "
        send(c.q);
      });
      chips.appendChild(b);
    }
  }

  function addMsg(msg, who, { save = true } = {}) {
    const text = typeof msg === 'string' ? msg : msg.text;
    const wrap = el('div', `cse-chat-msg ${who}`);
    const bubble = el('div', `cse-chat-bubble ${who}`);
    if (who === 'bot') renderRich(bubble, text);
    else bubble.textContent = text;
    wrap.appendChild(bubble);

    if (who === 'bot') {
      const acts = (typeof msg === 'object' && msg.actions) || [];
      if (acts.length) {
        const row = el('div', 'cse-chat-actions');
        for (const a of acts) {
          if (a.url) {
            const link = el('a', 'cse-chat-act', a.label + ' ↗');
            link.href = a.url;
            if (/^https?:/.test(a.url)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
            row.appendChild(link);
          } else if (a.tab) {
            const b = el('button', 'cse-chat-act', a.label + ' →');
            b.type = 'button';
            b.addEventListener('click', () => {
              openTab(a.tab);
              if (window.innerWidth < 640) close();
            });
            row.appendChild(b);
          }
        }
        wrap.appendChild(row);
      }
      const tools = el('div', 'cse-chat-tools');
      const copy = el('button', 'cse-chat-tool', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(plain(text)); copy.textContent = 'Copied ✓'; } catch { copy.textContent = '—'; }
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      });
      const aSi = el('a', 'cse-chat-tr', '→ සිංහල');
      aSi.href = translateUrl(plain(text).slice(0, 1800), 'si');
      aSi.target = '_blank';
      aSi.rel = 'noopener noreferrer';
      const aEn = el('a', 'cse-chat-tr', '→ English');
      aEn.href = translateUrl(plain(text).slice(0, 1800), 'en');
      aEn.target = '_blank';
      aEn.rel = 'noopener noreferrer';
      tools.append(copy, aSi, aEn);
      wrap.appendChild(tools);
    }
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;

    if (save) {
      history.push({
        who,
        text,
        actions: typeof msg === 'object' ? (msg.actions || []).filter((a) => a.tab || a.url) : [],
        t: Date.now(),
      });
      persist();
    }
  }

  function welcome() {
    const st = lastStyle;
    const r = R(pick(st,
      'Hi! I’m your CSE assistant 👋\nAsk about any company (COMB, SAMP…), your portfolio, the calculator, or market movers. English, සිංහල or Singlish is fine.',
      'ආයුබෝවන්! මම ඔයාගේ CSE assistant 👋\nCompany එකක් (COMB, SAMP…), portfolio එක, calculator හෝ market ගැන අහන්න.',
      'Hi! / ආයුබෝවන්! 👋\nCompany එකක් (COMB), mage portfolio, calculator, market gainers — ඕන දෙයක් අහන්න. English / සිංහල / Singlish OK.'),
    { chips: starterChips(st) });
    addMsg(r, 'bot');
    setChips(r.chips);
  }

  function restore() {
    msgs.replaceChildren();
    for (const h of history.slice(-CONFIG.maxHistory)) {
      addMsg({ text: h.text, actions: h.actions || [] }, h.who, { save: false });
      if (h.who === 'user') ctx.turns.push({ role: 'user', content: h.text });
      else ctx.turns.push({ role: 'assistant', content: plain(h.text) });
    }
    ctx.turns = ctx.turns.slice(-10);
  }

  function clearChat() {
    history = [];
    persist();
    ctx.turns = [];
    ctx.lastSymbol = null;
    msgs.replaceChildren();
    welcome();
  }

  function open() {
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    fab.classList.remove('has-dot');
    updateStatus();
    if (!msgs.childElementCount) {
      if (history.length) { restore(); setChips(starterChips(lastStyle)); } else welcome();
    }
    input.focus();
  }

  function close() {
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  async function send(text) {
    const q = String(text || '').trim();
    if (!q || busy) return;
    busy = true;
    lastStyle = style(q);
    addMsg(q, 'user');
    inputs = [q, ...inputs.filter((x) => x !== q)].slice(0, 30);
    store(CONFIG.inputHistoryKey, inputs);
    inputIdx = -1;
    input.value = '';
    setChips([]);

    const typing = el('div', 'cse-chat-msg bot');
    const dots = el('div', 'cse-chat-bubble bot cse-chat-thinking');
    dots.setAttribute('aria-label', 'Typing');
    dots.append(el('span'), el('span'), el('span'));
    typing.appendChild(dots);
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      const res = await respond(q);
      typing.remove();
      if (res.clear) { clearChat(); return; }
      addMsg(res, 'bot');
      setChips(res.chips && res.chips.length ? res.chips : starterChips(lastStyle));
      ctx.turns.push({ role: 'user', content: q }, { role: 'assistant', content: plain(res.text) });
      ctx.turns = ctx.turns.slice(-10);
      if (res.navigate) {
        openTab(res.navigate);
        if (window.innerWidth < 640) close();
      }
    } catch (err) {
      typing.remove();
      addMsg(pick(lastStyle, 'Something went wrong — try again.', 'අවුලක් — ආයෙ try කරන්න.', 'Error එකක් — ආයෙ try කරන්න.'), 'bot');
      console.warn('[chatbot]', err);
    } finally {
      busy = false;
    }
  }

  /* ---------- events ---------- */
  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener('click', close);
  clearBtn.addEventListener('click', clearChat);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send(input.value);
  });

  // Keep app shortcuts (1–8, R, T, /) from firing while typing in the chat
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { close(); fab.focus(); return; }
    if (e.key === 'ArrowUp' && inputs.length) {
      e.preventDefault();
      inputIdx = Math.min(inputIdx + 1, inputs.length - 1);
      input.value = inputs[inputIdx];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      inputIdx = Math.max(inputIdx - 1, -1);
      input.value = inputIdx >= 0 ? inputs[inputIdx] : '';
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); fab.focus(); }
  });

  if (micBtn && SR) {
    let rec = null;
    micBtn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = lastStyle === 'si' ? 'si-LK' : 'en-US';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      micBtn.classList.add('rec');
      rec.onresult = (ev) => {
        input.value = Array.from(ev.results).map((r) => r[0].transcript).join(' ');
        if (ev.results[ev.results.length - 1].isFinal) send(input.value);
      };
      rec.onerror = () => {};
      rec.onend = () => { micBtn.classList.remove('rec'); rec = null; };
      try { rec.start(); } catch { micBtn.classList.remove('rec'); rec = null; }
    });
  }

  updateStatus();
  setInterval(updateStatus, 60_000);
}

/** Exposed for tests / other modules (e.g. open the chat with a question). */
export { respond as chatRespond, marketStatus as chatMarketStatus };

export default { init: initChatbot };
/* ==========================================================
 * Chatbot v2 — ADD this below your existing .cse-chat styles.
 * Only new classes + a few upgrades. Uses currentColor /
 * transparent mixes so it follows your light & dark themes.
 * ========================================================== */

.cse-chat-panel {
  width: min(400px, calc(100vw - 24px));
  max-height: min(640px, calc(100vh - 110px));
  display: flex;
  flex-direction: column;
}

.cse-chat-msgs { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }

/* header */
.cse-chat-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cse-chat-title { display: flex; flex-direction: column; line-height: 1.2; }
.cse-chat-status { font-size: 11px; opacity: .7; }
.cse-chat-status.open { color: #16a34a; opacity: 1; }
.cse-chat-headbtns { display: flex; align-items: center; gap: 4px; }
.cse-chat-iconbtn {
  background: none; border: 0; cursor: pointer; font-size: 14px; opacity: .65;
  padding: 4px 6px; border-radius: 6px; color: inherit;
}
.cse-chat-iconbtn:hover { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }

/* bubbles */
.cse-chat-bubble { white-space: normal; word-break: break-word; line-height: 1.45; }
.cse-chat-bubble strong { font-weight: 650; }
.cse-chat-bubble .cse-chat-h { display: inline-block; margin: 2px 0; opacity: .85; }
.cse-chat-bubble a { color: inherit; text-decoration: underline; }

/* typing indicator */
.cse-chat-thinking { display: inline-flex; gap: 4px; align-items: center; padding: 10px 12px; }
.cse-chat-thinking span {
  width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .35;
  animation: cseChatDot 1s infinite ease-in-out;
}
.cse-chat-thinking span:nth-child(2) { animation-delay: .15s; }
.cse-chat-thinking span:nth-child(3) { animation-delay: .3s; }
@keyframes cseChatDot { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: .9; transform: translateY(-3px); } }

/* action buttons under a bot message (open tab, links) */
.cse-chat-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
.cse-chat-act {
  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  background: transparent; color: inherit; text-decoration: none;
}
.cse-chat-act:hover { background: color-mix(in srgb, currentColor 10%, transparent); }

/* copy / translate row */
.cse-chat-tools { display: flex; gap: 10px; margin-top: 3px; font-size: 11px; opacity: .6; }
.cse-chat-tools:hover { opacity: 1; }
.cse-chat-tool { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: inherit; text-decoration: underline; }

/* chips: scroll sideways on small screens */
.cse-chat-chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 6px 10px 8px; flex: 0 0 auto; }
.cse-chat-chips::-webkit-scrollbar { display: none; }
.cse-chat-chip { white-space: nowrap; flex: 0 0 auto; }

/* mic */
.cse-chat-form { display: flex; align-items: center; gap: 6px; }
.cse-chat-input { flex: 1 1 auto; min-width: 0; }
.cse-chat-mic {
  background: none; border: 0; cursor: pointer; font-size: 16px; padding: 4px 6px; border-radius: 8px;
}
.cse-chat-mic.rec { background: #ef444422; animation: cseChatPulse 1.2s infinite; }
@keyframes cseChatPulse { 50% { background: #ef444455; } }

@media (max-width: 640px) {
  .cse-chat-panel { max-height: calc(100vh - 90px); }
}

@media (prefers-reduced-motion: reduce) {
  .cse-chat-thinking span, .cse-chat-mic.rec { animation: none; }
}
