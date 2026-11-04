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
import { state, onChange } from '../core/store.js';
import { cse, news, apiUrl } from '../core/api.js';
import { go } from '../core/router.js';
import { computeRow, calcBes, sectorOf, normalizeSymbol } from '../core/finance.js';
import { toast } from '../core/ui.js';
import { recordTransaction } from './history.js';

/* =====================================================================
 * CONFIG — change these if needed
 * ===================================================================== */
const CONFIG = {
  /** Used only if the app's commission % can't be found. */
  defaultCommissionPct: 1.12,
  /** AI answers (free Gemini / Groq via api/chat). Empty string = AI off. */
  aiEndpoint: 'api/chat',
  aiTimeoutMs: 25000,
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
    const own = (state.holdings || []).find((h) => baseOf(h.name) === baseOf(sym) && Number(h.tradedPrice) > 0);
    return num(pickKey(p, PRICE_KEYS)) ?? num(pickKey(r, PRICE_KEYS)) ?? (own ? Number(own.tradedPrice) : null);
  },
  chg(sym) {
    return num(pickKey(A.pm(sym), CHG_KEYS)) ?? num(pickKey(A.row(sym), CHG_KEYS));
  },
  /** Holdings from the app: {name: 'COMB.N0000', balance, avgPrice, besPrice, totalCost, tradedPrice} */
  holdings() {
    return (Array.isArray(state.holdings) ? state.holdings : [])
      .filter((h) => h && h.name && Number(h.balance) > 0)
      .map((h) => ({ ...h, symbol: String(h.name).toUpperCase(), qty: Number(h.balance) || 0, avg: Number(h.avgPrice) || 0 }));
  },
  /** Commission % from app state, header input, or default. */
  commissionPct() {
    const cand = [
      state.commissionRate, state.commission, state.commissionPct,
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
const TAMIL_RE = /[\u0B80-\u0BFF]/;

function style(query) {
  const q = query || '';
  if (TAMIL_RE.test(q)) return 'ta';
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
 * Company resolution (market list + companyInfoSummery)
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

/** Market list first; otherwise ask the CSE directly (works for shares not traded today). */
async function resolveBySymbol(base) {
  const hit = A.row(base);
  if (hit) return { symbol: A.sym(hit), name: A.name(hit) };
  const up = String(base || '').toUpperCase();
  const full = up.includes('.') ? up : `${up}.N0000`;
  try {
    const raw = await cseCached('companyInfoSummery', { symbol: full });
    const info = raw?.reqSymbolInfo || {};
    if (info.symbol || info.name) return { symbol: info.symbol || full, name: info.name || full };
  } catch { /* unknown symbol / offline */ }
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

  return null;
}

/* =====================================================================
 * Response helpers
 * ===================================================================== */
/** chips: [{label, q}] → sends q; actions: [{label, tab}] or [{label, url}] */
const R = (text, opts = {}) => ({
  text,
  chips: opts.chips || [],
  actions: (opts.actions || []).filter(Boolean),
  spark: opts.spark || null,
  ai: !!opts.ai,
});
const chip = (label, q) => ({ label, q: q || label });
const tabAct = (label, tab, sym) => (sym ? { label, tab, sym } : { label, tab });

const DISCLAIMER = (st) => pick(st, 'Not investment advice.', 'Investment advice නෙවෙයි.', 'Advice නෙවෙයි.');

/* =====================================================================
 * Tabs / navigation
 * ===================================================================== */
const TABS = [
  { id: 'portfolio', label: 'Portfolio', re: /portfolio|පෝට්ෆෝලියෝ/ },
  { id: 'calc', label: 'Calculator', re: /calculator|\bcalc\b|කැල්කියුලේටර්/ },
  { id: 'div', label: 'Dividends', re: /dividends?|ලාභාංශ/ },
  { id: 'charts', label: 'Charts', re: /charts?\b|ප්‍රස්ථාර/ },
  { id: 'history', label: 'History', re: /history|ඉතිහාස/ },
  { id: 'news', label: 'News', re: /news|පුවත්/ },
  { id: 'fund', label: 'Fundamentals', re: /fundamentals?/ },
  { id: 'tech', label: 'Technical', re: /technicals?/ },
];

/** Opens a tab through the app router. Fundamentals/Technical accept { sym }. */
function openTab(id, sym) {
  if (!TABS.some((t) => t.id === id)) return false;
  try {
    go(id, sym ? { sym } : null);
  } catch {
    location.hash = id;
  }
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

async function marketHoursReply(st) {
  const s = marketStatus();
  // The CSE's own status also knows about public holidays.
  let official = '';
  try {
    const d = await cseCached('marketStatus', {});
    official = String(d?.status || '').trim();
  } catch { /* offline */ }
  if (/open/i.test(official) && !s.open) { s.open = true; s.left = Math.max(0, CONFIG.closeMin - colomboClock().mins); }
  if (/clos/i.test(official) && s.open) { s.open = false; s.until = null; }
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
  const note = official
    ? pick(st, `CSE status: ${official}`, `CSE status: ${official}`, `CSE status: ${official}`)
    : pick(st, 'Couldn’t reach the CSE status — public holidays not checked.', 'CSE status එක ගන්න බැරි වුණා — holidays check වුණේ නැහැ.', 'CSE status නැහැ — holidays check වුණේ නැහැ.');
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

/** Full trade summary (has turnover & volume); falls back to the cached market list. */
async function liveMarketRows() {
  try {
    const raw = await cseCached('tradeSummary', {});
    const list = Array.isArray(raw?.reqTradeSummery) ? raw.reqTradeSummery : Array.isArray(raw) ? raw : [];
    const rows = list.map((r) => ({
      symbol: String(r.symbol || '').toUpperCase(),
      name: r.name || '',
      price: num(r.price ?? r.lastTradedPrice),
      chg: num(r.percentageChange ?? r.changePercentage),
      turnover: num(r.turnover),
      volume: num(r.sharevolume ?? r.shareVolume ?? r.qty),
    })).filter((r) => r.symbol && r.price);
    if (rows.length) return rows;
  } catch { /* offline */ }
  try { await ensureMarketSymbols(); } catch { /* offline */ }
  return marketRows();
}

async function moversReply(kind, st) {
  const rows = await liveMarketRows();
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
    return R(kind === 'active'
      ? pick(st, 'No turnover data in the current feed.', 'Turnover data feed එකේ නැහැ.', 'Turnover data දැන් නැහැ.')
      : pick(st, `No shares ${kind === 'losers' ? 'down' : 'up'} today in the current feed.`, `අද ${kind === 'losers' ? 'බැස්ස' : 'නැග්ග'} shares feed එකේ නැහැ.`, `අද ${kind === 'losers' ? 'losers' : 'gainers'} නැහැ.`));
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
// Number + optional unit. Singlish suffixes like “120ta” / “120kata” are allowed.
const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(k|mn|m|lakhs?|laksha|lakshe)?(?!\d)(?!(?!ta\b|kata\b|ta[^a-z]|kata[^a-z])[a-z])/gi;

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
  return R(lines.join('\n'), { actions: [tradeConfirmAction(side, sym, qty, price, st), tabAct('Open Calculator', 'calc')] });
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
  return R(lines.join('\n'), { actions: [tabAct('Open Dividends', 'div')] });
}

/* =====================================================================
 * Portfolio
 * ===================================================================== */
function portfolioStats() {
  const rate = A.commissionPct();
  const rows = A.holdings().map((h) => {
    const price = A.price(h.symbol);
    // Same maths as the Portfolio tab (finance.js): P/L is after sell commission.
    const r = computeRow({ ...h, tradedPrice: price ?? h.tradedPrice }, rate);
    const has = (price ?? h.tradedPrice) > 0;
    const chg = A.chg(h.symbol);
    return {
      ...h,
      price: has ? (price ?? h.tradedPrice) : null,
      cost: h.totalCost || h.qty * h.avg,
      value: has ? r.marketValue : null,
      pl: has ? r.gainLoss : null,
      plPct: has ? r.gainLossPct : null,
      status: has ? r.status : 'hold',
      bes: h.besPrice || calcBes(h.avg, rate),
      chg,
    };
  });
  const priced = rows.filter((r) => r.value != null);
  const totalCost = priced.reduce((s, r) => s + r.cost, 0);
  const totalValue = priced.reduce((s, r) => s + r.value, 0);
  const pl = priced.reduce((s, r) => s + r.pl, 0);
  const dayPl = priced.reduce((s, r) => (r.chg != null && r.chg > -100 ? s + r.value - r.value / (1 + r.chg / 100) : s), 0);
  return { rows, priced, totalCost, totalValue, pl, dayPl, rate };
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
  lines.push(pick(st, `(after ${fmtNum(s.rate)}% sell commission — same as the Portfolio tab)`, `(විකුණුම් commission ${fmtNum(s.rate)}% කපලා — Portfolio tab එකේ වගේම)`, `(sell commission ${fmtNum(s.rate)}% කපලා — Portfolio tab එක වගේම)`));
  if (s.dayPl) lines.push(pick(st, `Today’s move: ${fmtRs(s.dayPl)}`, `අද වෙනස: ${fmtRs(s.dayPl)}`, `අද වෙනස: ${fmtRs(s.dayPl)}`));
  const sells = s.priced.filter((r) => r.status === 'sell');
  const nears = s.priced.filter((r) => r.status === 'near');
  if (sells.length || nears.length) {
    lines.push(`🔔 SELL: ${sells.map((r) => shortSym(r.symbol)).join(', ') || '—'} · NEAR: ${nears.map((r) => shortSym(r.symbol)).join(', ') || '—'}`);
  }
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
  const rate = A.commissionPct();
  const bes = h.besPrice || calcBes(h.avg, rate);
  const price = A.price(h.symbol) ?? A.price(sym) ?? (h.tradedPrice || null);
  if (price == null) return pick(st, `📁 In your portfolio: ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)} · B.E.S Rs ${fmtNum(bes)}`, `📁 ඔයාගේ portfolio එකේ: ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)} · B.E.S Rs ${fmtNum(bes)}`, `📁 Portfolio එකේ: ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)} · B.E.S Rs ${fmtNum(bes)}`);
  const r = computeRow({ ...h, tradedPrice: price }, rate);
  const sig = r.status === 'sell' ? ' · 🔔 SELL' : r.status === 'near' ? ' · 🔔 NEAR' : '';
  return pick(st,
    `📁 You hold ${fmtNum(h.qty, 0)} @ avg Rs ${fmtNum(h.avg)} → P/L ${fmtRs(r.gainLoss)} (${fmtPct(r.gainLossPct)}) · B.E.S Rs ${fmtNum(bes)}${sig}`,
    `📁 ඔයා ළඟ ${fmtNum(h.qty, 0)} @ avg Rs ${fmtNum(h.avg)} → P/L ${fmtRs(r.gainLoss)} (${fmtPct(r.gainLossPct)}) · B.E.S Rs ${fmtNum(bes)}${sig}`,
    `📁 ඔයා ළඟ ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)} → P/L ${fmtRs(r.gainLoss)} (${fmtPct(r.gainLossPct)}) · B.E.S Rs ${fmtNum(bes)}${sig}`);
}

/** "Which of my shares are SELL / NEAR?" */
function signalsReply(st) {
  const s = portfolioStats();
  if (!s.priced.length) return portfolioReply(st);
  const pickRows = (k) => s.priced.filter((r) => r.status === k);
  const fmtRow = (r) => `**${shortSym(r.symbol)}** Rs ${fmtNum(r.price)} vs B.E.S ${fmtNum(r.bes)} (${fmtPct(r.plPct)})`;
  const sells = pickRows('sell');
  const nears = pickRows('near');
  const lines = [];
  lines.push(pick(st, '— SELL (price ≥ B.E.S) —', '— SELL (මිල ≥ B.E.S) —', '— SELL (price ≥ B.E.S) —'));
  lines.push(...(sells.length ? sells.map(fmtRow) : [pick(st, 'None', 'නැහැ', 'නැහැ')]));
  lines.push(pick(st, '— NEAR (within 1% of B.E.S) —', '— NEAR (B.E.S එකට 1% ඇතුළත) —', '— NEAR (B.E.S ට 1% ඇතුළත) —'));
  lines.push(...(nears.length ? nears.map(fmtRow) : [pick(st, 'None', 'නැහැ', 'නැහැ')]));
  const wait = s.priced.filter((r) => r.status === 'hold').sort((a, b) => (b.price / b.bes) - (a.price / a.bes))[0];
  if (wait) lines.push('', pick(st, `Closest of the rest: ${fmtRow(wait)}`, `ඉතුරු ඒවායින් ළඟම: ${fmtRow(wait)}`, `ඉතුරු වලින් ළඟම: ${fmtRow(wait)}`));
  lines.push(pick(st, 'Signals = reminders to check, not advice.', 'Signals කියන්නේ check කරන්න මතක් කිරීම් — advice නෙවෙයි.', 'Signals = reminders, advice නෙවෙයි.'));
  return R(lines.join('\n'), { chips: [...sells, ...nears].slice(0, 4).map((r) => chip(shortSym(r.symbol))), actions: [tabAct('Open Portfolio', 'portfolio')] });
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
  const spark = await fetchSpark(d.sym, info.id);
  return R(lines.join('\n'), {
    spark,
    chips: [
      chip(`${s} news`),
      chip(`${s} announcements`),
      chip(pick(st, `${s} vs …`, `${s} vs …`, `${s} vs …`), `${s} vs `),
      chip(`buy 100 ${s}`),
      chip(pick(st, 'Dividend yield', 'Dividend yield', 'dividend yield'), `${s} dividend yield`),
    ],
    actions: [tabAct('Fundamentals', 'fund', d.sym), tabAct('Technical', 'tech', d.sym), { label: 'cse.lk', url: 'https://www.cse.lk/' }],
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
  return R(lines.join('\n'), { chips: [chip(A1), chip(B1)], actions: [tabAct(`${A1} Fundamentals`, 'fund', a.sym), tabAct(`${B1} Fundamentals`, 'fund', b.sym)] });
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
  { re: /(sell|near|wait)\s*signal|signals?\b|\bwait\b.*(mean|status)/, en: 'Portfolio signals: SELL = current price is at or above your B.E.S (selling now = no loss after commission). NEAR = within 1% below B.E.S. WAIT = below that. They are reminders to check — not advice. Ask “my SELL signals” to see yours.', si: 'Portfolio signals: SELL = දැන් මිල ඔයාගේ B.E.S එකට සමාන හෝ වැඩි (දැන් විකුණුවොත් commission එක්කත් පාඩු නැහැ). NEAR = B.E.S එකට 1%ක් ඇතුළත. WAIT = ඊට අඩු. මේවා check කරන්න මතක් කිරීම් — advice නෙවෙයි. “mage SELL signals” කියලා අහන්න.' },
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
    { chips: [chip('buy 100 COMB @ 120'), chip('break even 120')], actions: [tabAct('Open Calculator', 'calc')] }),
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
    { chips: [chip('What is XD?'), chip('dividend 5 price 100')], actions: [tabAct('Open Dividends', 'div')] }),
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
    chip(pick(st, 'Daily brief', 'අද සාරාංශය', 'daily brief')),
    chip(pick(st, 'My portfolio', 'මගේ portfolio', 'mage portfolio')),
    chip(pick(st, 'Upcoming XD', 'එන XD dates', 'mage XD dates')),
    chip('Top gainers'),
    chip('COMB'),
    chip(pick(st, 'What can you do?', 'මොනවද කරන්න පුළුවන්?', 'monawada karanna puluwan?')),
  ];
}

function capabilitiesReply(st) {
  return R(pick(st,
    'I can:\n• Daily brief — “brief”\n• Your portfolio: P/L, best/worst, SELL/NEAR, sectors, performance (“this month”)\n• Dividends: “upcoming XD”, “dividend income”\n• Companies: “COMB”, “COMB vs SAMP”, “COMB news”, “COMB announcements”\n• Calculate: “buy 100 COMB @ 120”, “break even 120”, “100k with COMB how many”\n• What-if: “COMB 10% up”, “COMB 200 more @ 120 avg”, “COMB 10% profit price”\n• Price alerts: “alert COMB 160”\n• Log trades: “log buy 100 COMB @ 120”\n• History: “realized profit”, “my last trades”\n• Market: gainers/losers, ASPI, open/closed\n• Explain terms: XD, P/E, B.E.S…\n• Anything else → free AI (also Tamil)\nNo buy/sell advice.',
    'මට පුළුවන්:\n• අද සාරාංශය — “brief”\n• Portfolio: P/L, හොඳම/දුර්වලම, SELL/NEAR, sectors, “මේ මාසේ performance”\n• Dividends: “එන XD dates”, “dividend ආදායම”\n• Companies: “COMB”, “COMB vs SAMP”, “COMB news”, “COMB announcements”\n• Calculate: “buy 100 COMB @ 120”, “break even 120”\n• What-if: “COMB 10% වැඩි වුණොත්”, “COMB තව 200ක් 120ට ගත්තොත් avg”\n• Price alerts: “COMB 160 වුණොත් කියන්න”\n• Trades log: “log buy 100 COMB @ 120”\n• History: “realized profit”, “last trades”\n• Market: gainers/losers, ASPI, open ද\n• වචන තේරුම්: XD, P/E, B.E.S…\n• වෙන ඕන දෙයක් → free AI\nBuy/sell advice නැහැ.',
    'මට කරන්න පුළුවන්:\n• “brief” → අද සාරාංශය\n• mage portfolio, SELL signals, sector breakdown, me maase performance\n• mage XD dates, dividend income keeyada\n• COMB / COMB vs SAMP / COMB news / COMB announcements\n• “COMB 100 120ට ගත්තා” → calculate + portfolio ekata danna\n• “COMB 10% wadi unoth”, “COMB thawa 200 120ta gaththoth avg”\n• “COMB 160 unoth kiyanna” → alert\n• realized profit, mage last trades\n• gainers/losers, ASPI, market open da\n• XD, P/E, B.E.S තේරුම\n• වෙන ඕන දෙයක් → free AI\nAdvice නම් නැහැ.'),
  { chips: starterChips(st) });
}

/* =====================================================================
 * EXTRA FEATURES — dividends, daily brief, what-if, price alerts,
 * realized P/L, performance, sectors, company news & announcements,
 * mini price chart, logging trades from chat.
 * ===================================================================== */
const DAY_MS = 86400000;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** Accepts ISO strings, "05 Nov 2026", epoch seconds/ms. */
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  let d;
  if (/^\d{10}$/.test(s)) d = new Date(Number(s) * 1000);
  else if (/^\d{13}$/.test(s)) d = new Date(Number(s));
  else d = new Date(s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}
const showDate = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : String(v || '');
};

/** Holdings keyed by base symbol (lots of the same share are summed). */
function heldMap() {
  const m = new Map();
  for (const h of A.holdings()) {
    const b = baseOf(h.symbol);
    const cur = m.get(b);
    if (cur) { cur.qty += h.qty; cur.totalCost = (cur.totalCost || 0) + (h.totalCost || 0); cur.avgDps = cur.avgDps || h.avgDps; }
    else m.set(b, { ...h });
  }
  return m;
}

/* ---------- Dividends / XD ---------- */
async function cashDividendRows() {
  try {
    const d = await cseCached('cashDividends', {});
    const list = Array.isArray(d?.cashDividends) ? d.cashDividends : [];
    return list.map((r) => ({
      symbol: baseOf(r.symbol),
      company: r.company || '',
      dps: num(r.votingDivPerShare),
      xd: toDate(r.xd),
      pay: toDate(r.payment),
    })).filter((r) => r.symbol || r.company);
  } catch {
    return null;
  }
}

async function dividendsReply(st, mode) {
  const held = heldMap();
  const today = startOfToday();
  const rows = await cashDividendRows();
  const lines = [];
  const you = pick(st, 'you get', 'ඔයාට', 'ඔයාට');

  // Estimated yearly income from the Avg DPS you set in the Dividends tab
  const est = [...held.values()].reduce((s, h) => s + (Number(h.avgDps) || 0) * h.qty, 0);
  const cost = [...held.values()].reduce((s, h) => s + (h.totalCost || 0), 0);
  const estLine = est > 0
    ? pick(st,
      `Estimated yearly dividends (from your Avg DPS): **${fmtRs(est)}**${cost ? ` · ${fmtNum((est / cost) * 100)}% on cost` : ''}`,
      `ඔයාගේ Avg DPS අනුව අවුරුද්දකට dividends: **${fmtRs(est)}**${cost ? ` · cost එකෙන් ${fmtNum((est / cost) * 100)}%` : ''}`,
      `Avg DPS අනුව අවුරුද්දට dividends: **${fmtRs(est)}**${cost ? ` · cost එකෙන් ${fmtNum((est / cost) * 100)}%` : ''}`)
    : null;
  if (mode === 'income') {
    lines.push(estLine || pick(st,
      'Set “Avg DPS” for your holdings in the Dividends tab to see yearly income.',
      'අවුරුදු ආදායම බලන්න Dividends tab එකේ holdings වලට “Avg DPS” දාන්න.',
      'Yearly income බලන්න Dividends tab එකේ Avg DPS දාන්න.'));
    const y = String(new Date().getFullYear());
    const paid = (state.divEvents || []).filter((e) => e.status === 'Paid' && String(e.pay || e.xd).includes(y));
    if (paid.length) {
      const sum = paid.reduce((s, e) => s + (Number(e.dps) || 0) * (held.get(baseOf(e.symbol))?.qty || 0), 0);
      lines.push(pick(st, `Logged as paid this year: ~${fmtRs(sum)} (${paid.length} events)`, `මේ අවුරුද්දේ ලැබුණා කියලා log කරපු: ~${fmtRs(sum)} (${paid.length})`, `මේ අවුරුද්දේ paid log: ~${fmtRs(sum)}`));
    }
    lines.push('');
  }

  if (rows) {
    const upcoming = rows.filter((r) => r.xd && r.xd >= today).sort((a, b) => a.xd - b.xd);
    const mine = upcoming.filter((r) => held.has(r.symbol));
    lines.push(pick(st, '— Upcoming dividends on your shares —', '— ඔයාගේ shares වලට එන dividends —', '— ඔයාගේ shares වලට එන dividends —'));
    if (mine.length) {
      for (const r of mine.slice(0, 8)) {
        const h = held.get(r.symbol);
        const inc = r.dps && h ? r.dps * h.qty : null;
        lines.push(`**${r.symbol}** Rs ${fmtNum(r.dps)}/share · XD ${showDate(r.xd)}${r.pay ? ` · pay ${showDate(r.pay)}` : ''}${inc != null ? ` → ${you} ~${fmtRs(inc)}` : ''}`);
      }
      lines.push(pick(st, 'Own the share BEFORE the XD date to get it.', 'Dividend එක ගන්න XD දිනයට කලින් share එක තියෙන්න ඕන.', 'XD date එකට කලින් share එක තියෙන්න ඕන.'));
    } else {
      lines.push(held.size
        ? pick(st, 'None announced yet for your holdings.', 'ඔයාගේ holdings වලට තවම announce කරලා නැහැ.', 'ඔයාගේ shares වලට තවම නැහැ.')
        : pick(st, 'You have no holdings yet.', 'තවම holdings නැහැ.', 'තවම holdings නැහැ.'));
    }
    if (mode !== 'income') {
      const others = upcoming.filter((r) => !held.has(r.symbol)).slice(0, 5);
      if (others.length) {
        lines.push('', pick(st, '— Other upcoming XD —', '— වෙනත් ළඟ එන XD —', '— Other upcoming XD —'));
        for (const r of others) lines.push(`${r.symbol || r.company} Rs ${fmtNum(r.dps)} · XD ${showDate(r.xd)}`);
      }
    }
  } else {
    const ev = (state.divEvents || []).filter((e) => toDate(e.xd) >= today);
    lines.push(pick(st, 'Couldn’t load the CSE dividend list right now.', 'CSE dividend list එක දැන් load කරන්න බැරි වුණා.', 'CSE dividend list එක load වුණේ නැහැ.'));
    if (ev.length) {
      lines.push(pick(st, 'From your event log:', 'ඔයාගේ event log එකෙන්:', 'Event log එකෙන්:'));
      for (const e of ev.slice(0, 6)) lines.push(`**${baseOf(e.symbol)}** Rs ${fmtNum(e.dps)} · XD ${showDate(e.xd)}`);
    }
  }
  if (mode !== 'income' && estLine) lines.push('', estLine);
  lines.push(pick(st, 'Confirm on cse.lk. Amounts are before tax.', 'cse.lk එකෙන් confirm කරන්න. Tax කපන්න කලින් අගයන්.', 'cse.lk එකෙන් confirm කරන්න. Tax කලින්.'));
  return R(lines.join('\n'), {
    chips: [chip(pick(st, 'Dividend income', 'Dividend ආදායම', 'dividend income keeyada')), chip(pick(st, 'Upcoming XD', 'එන XD dates', 'mage XD dates'))],
    actions: [tabAct('Open Dividends', 'div'), { label: 'CSE dividends', url: 'https://www.cse.lk/announcements/?category=CASH+DIVIDEND' }],
  });
}

/* ---------- Company news & CSE announcements ---------- */
async function announcementRows(test, days = 30) {
  const out = [];
  const [fin, appr] = await Promise.allSettled([cseCached('getFinancialAnnouncement', {}), cseCached('approvedAnnouncement', {})]);
  if (fin.status === 'fulfilled') {
    for (const a of fin.value?.reqFinancialAnnouncemnets || []) {
      const b = baseOf(a.symbol);
      if (!test(b)) continue;
      out.push({
        sym: b,
        title: a.fileText || 'Financial disclosure',
        date: toDate(a.uploadedDate || a.manualDate),
        link: a.path ? 'https://cdn.cse.lk/' + String(a.path).replace(/^\/+/, '') : 'https://www.cse.lk/',
      });
    }
  }
  if (appr.status === 'fulfilled') {
    for (const a of appr.value?.approvedAnnouncements || []) {
      const b = baseOf(a.symbol);
      if (!test(b)) continue;
      out.push({
        sym: b,
        title: [a.type, a.announcementCategory].filter(Boolean).join(' · ') || 'Announcement',
        date: toDate(a.dateOfAnnouncement || a.createdDate),
        link: 'https://www.cse.lk/pages/announcements/announcements.component.html',
      });
    }
  }
  const since = Date.now() - days * DAY_MS;
  return out.filter((x) => !x.date || x.date.getTime() >= since).sort((a, b) => (b.date || 0) - (a.date || 0));
}

const linkLine = (title, url, extra) => `• [${String(title).replace(/[[\]]/g, '').slice(0, 110)}](${url})${extra ? ` — ${extra}` : ''}`;

async function announcementsReply(st, sym) {
  const held = heldMap();
  const test = sym ? (b) => b === baseOf(sym) : (b) => held.has(b);
  if (!sym && !held.size) return R(pick(st, 'Add holdings first, or ask for a company, e.g. “COMB announcements”.', 'මුලින් holdings දාන්න, නැත්නම් “COMB announcements” වගේ අහන්න.', 'Holdings නැහැ — “COMB announcements” වගේ අහන්න.'));
  const rows = await announcementRows(test, 45);
  const title = sym
    ? pick(st, `— ${shortSym(sym)}: CSE announcements (45 days) —`, `— ${shortSym(sym)}: CSE නිවේදන (දින 45) —`, `— ${shortSym(sym)} announcements (45 days) —`)
    : pick(st, '— Announcements for your shares (45 days) —', '— ඔයාගේ shares වල නිවේදන (දින 45) —', '— ඔයාගේ shares announcements —');
  const lines = [title];
  if (!rows.length) lines.push(pick(st, 'Nothing found in the CSE feed.', 'CSE feed එකේ මොකුත් නැහැ.', 'මොකුත් නැහැ.'));
  for (const r of rows.slice(0, 7)) lines.push(linkLine(`${sym ? '' : r.sym + ': '}${r.title}`, r.link, r.date ? showDate(r.date) : ''));
  return R(lines.join('\n'), { chips: sym ? [chip(`${shortSym(sym)} news`)] : [], actions: [tabAct('Open News', 'news')] });
}

async function companyNewsReply(sym, st) {
  const row = A.row(sym);
  const name = String(A.name(row) || '').replace(/\bPLC\b|\bLIMITED\b|\bLTD\b/gi, '').trim();
  let items = [];
  try {
    const d = await news('company', { symbol: sym, name, limit: 6 });
    items = Array.isArray(d?.items) ? d.items : [];
  } catch { /* offline */ }
  const lines = [pick(st, `— ${shortSym(sym)} in the news —`, `— ${shortSym(sym)} පුවත් —`, `— ${shortSym(sym)} news —`)];
  if (!items.length) lines.push(pick(st, 'No recent news found.', 'අලුත් පුවත් හම්බුණේ නැහැ.', 'Recent news නැහැ.'));
  for (const it of items.slice(0, 5)) {
    if (!/^https?:\/\//.test(it.link || '')) continue;
    lines.push(linkLine(it.title || 'News', it.link, [it.source, it.pubDate ? showDate(it.pubDate) : ''].filter(Boolean).join(' · ')));
  }
  lines.push(pick(st, 'Verify important news from official sources.', 'වැදගත් පුවත් official source එකෙන් confirm කරන්න.', 'Official source එකෙන් confirm කරන්න.'));
  return R(lines.join('\n'), { chips: [chip(`${shortSym(sym)} announcements`), chip(shortSym(sym))], actions: [tabAct('Open News', 'news')] });
}

/* ---------- Mini price chart (sparkline) ---------- */
async function fetchSpark(sym, infoId) {
  const id = A.pm(sym)?.id ?? A.row(sym)?.id ?? infoId;
  if (id == null) return null;
  try {
    const ch = await cseCached('companyChartDataByStock', { stockId: id, period: '5' });
    const raw = ch?.chartData || ch?.reqTradeSummery?.chartData || [];
    const pts = (Array.isArray(raw) ? raw : []).map((p) => Number(p.p ?? p.c)).filter((n) => Number.isFinite(n) && n > 0).slice(-90);
    return pts.length >= 5 ? pts : null;
  } catch {
    return null;
  }
}

/* ---------- Daily brief ---------- */
async function briefReply(st) {
  const hour = Number(colomboClock().hhmm.slice(0, 2));
  const hello = hour < 12
    ? pick(st, 'Good morning! ☀️', 'සුබ උදෑසනක්! ☀️', 'Good morning! ☀️')
    : hour < 17 ? pick(st, 'Good afternoon!', 'සුබ දවාලක්!', 'Good afternoon!') : pick(st, 'Good evening!', 'සුබ සන්ධ්‍යාවක්!', 'Good evening!');
  const held = heldMap();
  const today = startOfToday();
  const [statusR, aspiR, divR, annR] = await Promise.allSettled([
    cseCached('marketStatus', {}),
    cseCached('aspiData', {}),
    held.size ? cashDividendRows() : Promise.resolve(null),
    held.size ? announcementRows((b) => held.has(b), 3) : Promise.resolve([]),
  ]);
  const lines = [`**${hello}** ${pick(st, 'Here’s your brief:', 'අද සාරාංශය:', 'අද brief එක:')}`];

  const ms = marketStatus();
  const official = statusR.status === 'fulfilled' ? String(statusR.value?.status || '') : '';
  const open = official ? /open/i.test(official) : ms.open;
  let mk = open ? pick(st, '🟢 Market open', '🟢 Market open', '🟢 Market open') : pick(st, '🔴 Market closed', '🔴 Market වහලා', '🔴 Market closed');
  const a = aspiR.status === 'fulfilled' ? aspiR.value : null;
  const av = num(a?.value);
  if (av != null) mk += ` · ASPI ${fmtNum(av)} ${arrow(num(a?.percentage))} ${fmtPct(num(a?.percentage))}`;
  lines.push(mk);

  if (held.size) {
    const s = portfolioStats();
    if (s.priced.length) {
      lines.push(pick(st,
        `📁 Portfolio ${fmtRs(s.totalValue)} · P/L ${fmtRs(s.pl)} (${fmtPct(s.totalCost ? (s.pl / s.totalCost) * 100 : 0)})${s.dayPl ? ` · today ${fmtRs(s.dayPl)}` : ''}`,
        `📁 Portfolio ${fmtRs(s.totalValue)} · P/L ${fmtRs(s.pl)} (${fmtPct(s.totalCost ? (s.pl / s.totalCost) * 100 : 0)})${s.dayPl ? ` · අද ${fmtRs(s.dayPl)}` : ''}`,
        `📁 Portfolio ${fmtRs(s.totalValue)} · P/L ${fmtRs(s.pl)}${s.dayPl ? ` · අද ${fmtRs(s.dayPl)}` : ''}`));
      const movers = [...s.priced].filter((r) => r.chg != null).sort((x, y) => Math.abs(y.chg) - Math.abs(x.chg)).slice(0, 3);
      if (movers.length) lines.push(`↕ ${movers.map((r) => `${shortSym(r.symbol)} ${fmtPct(r.chg)}`).join(' · ')}`);
      const sells = s.priced.filter((r) => r.status === 'sell').map((r) => shortSym(r.symbol));
      const nears = s.priced.filter((r) => r.status === 'near').map((r) => shortSym(r.symbol));
      if (sells.length || nears.length) lines.push(`🔔 SELL: ${sells.join(', ') || '—'} · NEAR: ${nears.join(', ') || '—'}`);
    }
    const div = divR.status === 'fulfilled' ? divR.value : null;
    const soon = (div || []).filter((r) => held.has(r.symbol) && r.xd && r.xd >= today && r.xd - today <= 14 * DAY_MS);
    if (soon.length) lines.push(`💰 ${pick(st, 'XD soon', 'ළඟදී XD', 'XD soon')}: ${soon.map((r) => `${r.symbol} ${showDate(r.xd)} (Rs ${fmtNum(r.dps)})`).join(' · ')}`);
    const ann = annR.status === 'fulfilled' ? annR.value : [];
    if (ann.length) {
      lines.push(`📣 ${pick(st, 'New announcements', 'අලුත් නිවේදන', 'New announcements')}:`);
      for (const r of ann.slice(0, 3)) lines.push(linkLine(`${r.sym}: ${r.title}`, r.link));
    }
  } else {
    lines.push(pick(st, 'Add your shares in the Portfolio tab to get a personal brief.', 'Personal brief එකක් ගන්න Portfolio tab එකේ shares දාන්න.', 'Portfolio එකට shares දැම්මොත් personal brief එකක් එනවා.'));
  }
  const alerts = loadAlerts();
  if (alerts.length) lines.push(`⏰ ${pick(st, 'Active price alerts', 'Active price alerts', 'Active alerts')}: ${alerts.map((x) => `${shortSym(x.sym)} ${x.dir === 'above' ? '≥' : '≤'} ${fmtNum(x.price)}`).join(' · ')}`);
  lines.push(DISCLAIMER(st));
  return R(lines.join('\n'), { chips: starterChips(st) });
}

/* ---------- What-if / average down / target ---------- */
const UP_WORDS = /\b(up|rise|rises|gain|increase|wadi|wedi|nagi|nagga|naginawa)\w*|වැඩි|නැග/i;
const DOWN_WORDS = /\b(down|fall|falls|drop|drops|decline|bass|baswunoth|basoth|adu|aduwunoth|watuna|watunoth)\w*|අඩු|බැස/i;
const IF_WORDS = /\b(if|what if|unoth|wunoth|unot|unath|giyoth|gyoth|goes|went|reach(es)?|reached|hit(s)?|nam)\b|\b[a-z]+oth\b|ොත්/i;

function whatIfReply(raw, q, sym, st) {
  const held = sym ? heldMap().get(baseOf(sym)) : null;
  const rate = A.commissionPct();
  const c = rate / 100;
  const pctM = raw.match(/(\d+(?:\.\d+)?)\s*%/);

  // 1) Average down / add more: "COMB thawa 200 120ta gaththoth avg keeyada"
  if (held && /\b(thawa|tawa|more|again|another|add|average|avg|aduwata|ekathu)\b|තව/i.test(q) && !pctM) {
    const { qty, price } = parseTrade(raw.replace(/\b(avg|average)\b/gi, ' '), null);
    if (qty && price) {
      const net = qty * price * (1 + c);
      const newBal = held.qty + qty;
      const newCost = (held.totalCost || held.qty * held.avg) + net;
      const newAvg = newCost / newBal;
      const newBes = calcBes(newAvg, rate);
      const oldBes = held.besPrice || calcBes(held.avg, rate);
      return R([
        pick(st, `— If you buy ${fmtNum(qty, 0)} more ${shortSym(sym)} @ Rs ${fmtNum(price)} —`, `— තව ${shortSym(sym)} ${fmtNum(qty, 0)}ක් Rs ${fmtNum(price)} ට ගත්තොත් —`, `— තව ${fmtNum(qty, 0)} ${shortSym(sym)} @ Rs ${fmtNum(price)} —`),
        pick(st, `Extra cost (incl. ${fmtNum(rate)}%): ${fmtRs(net)}`, `අමතර cost (commission එක්ක): ${fmtRs(net)}`, `Extra cost: ${fmtRs(net)}`),
        pick(st, `Shares: ${fmtNum(held.qty, 0)} → **${fmtNum(newBal, 0)}**`, `කොටස්: ${fmtNum(held.qty, 0)} → **${fmtNum(newBal, 0)}**`, `Shares: ${fmtNum(held.qty, 0)} → **${fmtNum(newBal, 0)}**`),
        `Avg: Rs ${fmtNum(held.avg)} → **Rs ${fmtNum(newAvg)}**`,
        `B.E.S: Rs ${fmtNum(oldBes)} → **Rs ${fmtNum(newBes)}**`,
        pick(st, `Total cost: ${fmtRs(newCost)}`, `මුළු cost: ${fmtRs(newCost)}`, `Total cost: ${fmtRs(newCost)}`),
        DISCLAIMER(st),
      ].join('\n'), { chips: [chip(`buy ${qty} ${shortSym(sym)} @ ${price}`)] });
    }
  }

  // 2) Target profit: "COMB 10% profit ganna keeyata wikunanna ona"
  const tgtM = q.match(/(\d+(?:\.\d+)?)\s*%\s*(profit|labaya|ලාභ|gain)/) || q.match(/(profit|labaya|ලාභ)\D{0,12}(\d+(?:\.\d+)?)\s*%/);
  if (held && tgtM) {
    const p = Number(tgtM[1] && /\d/.test(tgtM[1]) ? tgtM[1] : tgtM[2]) / 100;
    const cost = held.totalCost || held.qty * held.avg;
    const target = (cost * (1 + p)) / (held.qty * (1 - c));
    const now = A.price(sym);
    return R([
      pick(st, `To make ${fmtNum(p * 100)}% on ${shortSym(sym)} after commission, sell at about **Rs ${fmtNum(target)}**.`,
        `${shortSym(sym)} එකෙන් commission කපලා ${fmtNum(p * 100)}% ලාභයක් ගන්න **Rs ${fmtNum(target)}** පමණ ට විකුණන්න ඕන.`,
        `${shortSym(sym)} ${fmtNum(p * 100)}% profit (commission කපලා) → **Rs ${fmtNum(target)}** ට sell කරන්න ඕන.`),
      now ? pick(st, `Now Rs ${fmtNum(now)} — needs ${fmtPct(((target / now) - 1) * 100)}.`, `දැන් Rs ${fmtNum(now)} — තව ${fmtPct(((target / now) - 1) * 100)} යන්න ඕන.`, `දැන් Rs ${fmtNum(now)} → ${fmtPct(((target / now) - 1) * 100)} ඕන.`) : '',
      pick(st, `Profit would be ~${fmtRs(cost * p)}.`, `ලාභය ~${fmtRs(cost * p)}.`, `Profit ~${fmtRs(cost * p)}.`),
      DISCLAIMER(st),
    ].filter(Boolean).join('\n'), { chips: [chip(`alert ${shortSym(sym)} ${Math.ceil(target * 100) / 100}`)] });
  }

  if (!IF_WORDS.test(raw)) return null;

  // 3) Whole portfolio: "market eka 10% bassoth mage portfolio"
  if (!sym && pctM && /portfolio|mage|my|market|මගේ/i.test(q)) {
    const p = (DOWN_WORDS.test(raw) ? -1 : 1) * Number(pctM[1]) / 100;
    const s = portfolioStats();
    if (!s.priced.length) return portfolioReply(st);
    let mv = 0, pl = 0;
    for (const r of s.priced) {
      const rr = computeRow({ ...r, tradedPrice: r.price * (1 + p) }, rate);
      mv += rr.marketValue;
      pl += rr.gainLoss;
    }
    return R([
      pick(st, `— If all your shares move ${fmtPct(p * 100)} —`, `— ඔයාගේ shares ඔක්කොම ${fmtPct(p * 100)} වෙනස් වුණොත් —`, `— ඔක්කොම ${fmtPct(p * 100)} ගියොත් —`),
      pick(st, `Value: ${fmtRs(s.totalValue)} → **${fmtRs(mv)}** (${fmtRs(mv - s.totalValue)})`, `වටිනාකම: ${fmtRs(s.totalValue)} → **${fmtRs(mv)}** (${fmtRs(mv - s.totalValue)})`, `Value: ${fmtRs(s.totalValue)} → **${fmtRs(mv)}**`),
      `P/L: ${fmtRs(s.pl)} → **${fmtRs(pl)}**`,
      DISCLAIMER(st),
    ].join('\n'));
  }

  // 4) One share at a price or % move
  if (!sym) return null;
  const now = A.price(sym);
  let target = null;
  if (pctM && now) target = now * (1 + ((DOWN_WORDS.test(raw) ? -1 : 1) * Number(pctM[1])) / 100);
  else {
    const n = extractNumbers(raw).map((x) => x.v).find((v) => v > 0);
    if (n) target = n;
  }
  if (!target) return null;
  const lines = [pick(st, `— If ${shortSym(sym)} goes to Rs ${fmtNum(target)} —`, `— ${shortSym(sym)} Rs ${fmtNum(target)} වුණොත් —`, `— ${shortSym(sym)} Rs ${fmtNum(target)} unoth —`)];
  if (now) lines.push(pick(st, `That’s ${fmtPct(((target / now) - 1) * 100)} from now (Rs ${fmtNum(now)}).`, `දැන් මිලේ (Rs ${fmtNum(now)}) සිට ${fmtPct(((target / now) - 1) * 100)}.`, `දැන් Rs ${fmtNum(now)} → ${fmtPct(((target / now) - 1) * 100)}.`));
  if (held) {
    const r = computeRow({ ...held, tradedPrice: target }, rate);
    const sig = r.status === 'sell' ? 'SELL' : r.status === 'near' ? 'NEAR' : 'WAIT';
    lines.push(pick(st,
      `Your ${fmtNum(held.qty, 0)} shares: value ${fmtRs(r.marketValue)} · **P/L ${fmtRs(r.gainLoss)} (${fmtPct(r.gainLossPct)})** · signal ${sig}`,
      `ඔයාගේ කොටස් ${fmtNum(held.qty, 0)}: වටිනාකම ${fmtRs(r.marketValue)} · **P/L ${fmtRs(r.gainLoss)} (${fmtPct(r.gainLossPct)})** · signal ${sig}`,
      `ඔයාගේ ${fmtNum(held.qty, 0)}: value ${fmtRs(r.marketValue)} · **P/L ${fmtRs(r.gainLoss)} (${fmtPct(r.gainLossPct)})** · ${sig}`));
  } else {
    lines.push(pick(st, 'You don’t hold this share.', 'ඔයා ළඟ මේ share එක නැහැ.', 'මේ share එක ඔයා ළඟ නැහැ.'));
  }
  lines.push(DISCLAIMER(st));
  return R(lines.join('\n'), { chips: [chip(`alert ${shortSym(sym)} ${fmtNum(target).replace(/,/g, '')}`)] });
}

/* ---------- Price alerts (saved in this browser) ---------- */
const ALERT_KEY = 'cseChat.alerts.v1';
function loadAlerts() {
  try { const v = JSON.parse(localStorage.getItem(ALERT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveAlerts(list) {
  try { localStorage.setItem(ALERT_KEY, JSON.stringify(list.slice(0, 30))); } catch { /* blocked */ }
}

/** Returns the alerts that fired (and removes them). */
function checkAlerts() {
  const list = loadAlerts();
  if (!list.length) return [];
  const fired = [];
  const keep = [];
  for (const a of list) {
    const p = A.price(a.sym);
    if (p != null && ((a.dir === 'above' && p >= a.price) || (a.dir === 'below' && p <= a.price))) fired.push({ ...a, now: p });
    else keep.push(a);
  }
  if (fired.length) saveAlerts(keep);
  return fired;
}

function alertReply(raw, q, sym, st) {
  const list = loadAlerts();
  if (/(clear|remove|delete|cancel|ain|ayin|අයින්)/i.test(q)) {
    const keep = sym ? list.filter((a) => baseOf(a.sym) !== baseOf(sym)) : [];
    saveAlerts(keep);
    return R(pick(st, `Removed ${list.length - keep.length} alert(s).`, `Alerts ${list.length - keep.length}ක් අයින් කළා.`, `Alerts ${list.length - keep.length}ක් remove කළා.`));
  }
  const nums = extractNumbers(raw).map((x) => x.v);
  if (!sym || !nums.length) {
    if (!list.length) {
      return R(pick(st,
        'No price alerts yet. Example: “alert COMB 160” or “COMB 140ට බැස්සොත් කියන්න”. I’ll notify you when prices refresh.',
        'තවම price alerts නැහැ. උදා: “alert COMB 160”. Prices refresh වෙද්දී මම දන්වනවා.',
        'Alerts නැහැ. උදා: “COMB 160 unoth kiyanna”. Prices refresh වෙද්දී කියනවා.'), { chips: [chip('alert COMB 160')] });
    }
    return R([pick(st, '— Your price alerts —', '— ඔයාගේ price alerts —', '— ඔයාගේ alerts —'),
      ...list.map((a) => `**${shortSym(a.sym)}** ${a.dir === 'above' ? '≥' : '≤'} Rs ${fmtNum(a.price)} (${pick(st, 'now', 'දැන්', 'දැන්')} Rs ${fmtNum(A.price(a.sym))})`),
    ].join('\n'), { chips: [chip(pick(st, 'Clear alerts', 'alerts අයින් කරන්න', 'alerts clear'))] });
  }
  const now = A.price(sym);
  const pctM = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  let price = nums[0];
  if (pctM && now) price = now * (1 + ((DOWN_WORDS.test(raw) ? -1 : 1) * Number(pctM[1])) / 100);
  let dir = DOWN_WORDS.test(raw) || /\b(below|under)\b/i.test(raw) ? 'below' : UP_WORDS.test(raw) || /\b(above|over)\b/i.test(raw) ? 'above' : null;
  if (!dir) dir = now != null && price < now ? 'below' : 'above';
  price = Math.round(price * 100) / 100;
  const full = A.row(sym) ? A.sym(A.row(sym)) : sym;
  saveAlerts([...list.filter((a) => !(baseOf(a.sym) === baseOf(full) && a.dir === dir)), { sym: full, price, dir, created: Date.now() }]);
  return R(pick(st,
    `⏰ Alert set: **${shortSym(full)} ${dir === 'above' ? '≥' : '≤'} Rs ${fmtNum(price)}**${now ? ` (now Rs ${fmtNum(now)})` : ''}. I’ll tell you when prices refresh — keep the app open (auto-refresh in Settings).`,
    `⏰ Alert එක දැම්මා: **${shortSym(full)} ${dir === 'above' ? '≥' : '≤'} Rs ${fmtNum(price)}**${now ? ` (දැන් Rs ${fmtNum(now)})` : ''}. Prices refresh වෙද්දී කියනවා — app එක open කරලා තියන්න.`,
    `⏰ Alert set: **${shortSym(full)} ${dir === 'above' ? '≥' : '≤'} Rs ${fmtNum(price)}**${now ? ` (දැන් Rs ${fmtNum(now)})` : ''}. Prices refresh වෙද්දී කියනවා.`),
  { chips: [chip(pick(st, 'My alerts', 'මගේ alerts', 'mage alerts'))] });
}

/* ---------- Realized P/L & trades ---------- */
function realizedReply(st) {
  const tx = state.transactions || [];
  const sells = tx.filter((t) => t.type === 'sell');
  if (!tx.length) {
    return R(pick(st, 'No trades logged yet. Log buys/sells in History (or tell me: “log buy 100 COMB @ 120”).', 'තවම trades log කරලා නැහැ. History එකේ log කරන්න (නැත්නම් “log buy 100 COMB @ 120”).', 'Trades log කරලා නැහැ — History එකේ, නැත්නම් “log buy 100 COMB @ 120”.'), { actions: [tabAct('Open History', 'history')] });
  }
  const y = String(new Date().getFullYear());
  const sum = (arr) => arr.reduce((s, t) => s + (Number(t.realized) || 0), 0);
  const ytd = sells.filter((t) => String(t.date).startsWith(y));
  const m = new Date().toISOString().slice(0, 7);
  const mtd = sells.filter((t) => String(t.date).startsWith(m));
  const best = [...sells].sort((a, b) => b.realized - a.realized)[0];
  const lines = [
    pick(st, '— Realized profit (sold shares) —', '— විකුණලා ලැබුණු ලාභය —', '— Realized P/L (sold) —'),
    `${pick(st, 'This month', 'මේ මාසේ', 'මේ මාසේ')}: **${fmtRs(sum(mtd))}** (${mtd.length})`,
    `${pick(st, 'This year', 'මේ අවුරුද්දේ', 'මේ අවුරුද්දේ')}: **${fmtRs(sum(ytd))}** (${ytd.length})`,
    `${pick(st, 'All time', 'මුළු', 'All time')}: **${fmtRs(sum(sells))}** (${sells.length})`,
  ];
  if (best && best.realized > 0) lines.push(pick(st, `Best sale: ${shortSym(best.symbol)} ${fmtRs(best.realized)} (${best.date})`, `හොඳම විකුණුම: ${shortSym(best.symbol)} ${fmtRs(best.realized)} (${best.date})`, `Best sale: ${shortSym(best.symbol)} ${fmtRs(best.realized)}`));
  lines.push(pick(st, 'Open positions (not sold) are in your portfolio P/L.', 'නොවිකුණපු shares වල P/L portfolio එකේ.', 'Open positions → portfolio P/L.'));
  return R(lines.join('\n'), { chips: [chip(pick(st, 'My last trades', 'මගේ අන්තිම trades', 'mage last trades'))], actions: [tabAct('Open History', 'history')] });
}

function tradesReply(st) {
  const tx = [...(state.transactions || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 8);
  if (!tx.length) return realizedReply(st);
  const lines = [pick(st, '— Your last trades —', '— ඔයාගේ අන්තිම trades —', '— Last trades —')];
  for (const t of tx) {
    lines.push(`${t.date} ${t.type === 'buy' ? '🟦 BUY' : '🟥 SELL'} **${shortSym(t.symbol)}** ${fmtNum(t.qty, 0)} @ ${fmtNum(t.price)}${t.type === 'sell' ? ` → ${fmtRs(t.realized)}` : ''}`);
  }
  return R(lines.join('\n'), { chips: [chip(pick(st, 'Realized profit', 'Realized ලාභය', 'realized profit'))], actions: [tabAct('Open History', 'history')] });
}

/* ---------- Performance over time ---------- */
function performanceReply(raw, st) {
  const q = raw.toLowerCase();
  let days = 30, label = pick(st, 'last 30 days', 'පහුගිය දින 30', 'last 30 days');
  if (/week|sathi|සති/.test(q)) { days = 7; label = pick(st, 'last 7 days', 'පහුගිය දින 7', 'last 7 days'); }
  else if (/3\s*month|quarter|maasa 3|මාස 3/.test(q)) { days = 90; label = pick(st, 'last 3 months', 'පහුගිය මාස 3', 'last 3 months'); }
  else if (/year|awurud|අවුරුද්/.test(q)) { days = 365; label = pick(st, 'last 12 months', 'පහුගිය මාස 12', 'last 12 months'); }
  const snaps = (state.valueSnaps || []).filter((s) => s.day && s.mv > 0).sort((a, b) => a.day.localeCompare(b.day));
  if (snaps.length < 2) {
    return R(pick(st,
      'Not enough history yet — the app saves one value snapshot per day when prices refresh. Check back in a few days.',
      'තවම history මදි — prices refresh වෙද්දී app එක දවසකට එක snapshot එකක් save කරනවා. දවස් කීපයකින් ආයෙ බලන්න.',
      'History මදි — දවසකට එක snapshot එකක් save වෙනවා. දවස් කීපයකින් බලන්න.'));
  }
  const last = snaps[snaps.length - 1];
  const cutoff = new Date(new Date(last.day).getTime() - days * DAY_MS).toISOString().slice(0, 10);
  const base = [...snaps].reverse().find((s) => s.day <= cutoff) || snaps[0];
  const used = snaps.filter((s) => s.day >= base.day);
  const plNow = last.mv - last.cost;
  const plThen = base.mv - base.cost;
  const gain = plNow - plThen;
  const added = last.cost - base.cost;
  const lines = [
    pick(st, `— Portfolio, ${label} —`, `— Portfolio, ${label} —`, `— Portfolio, ${label} —`),
    `${base.day} → ${last.day}`,
    pick(st, `Value: ${fmtRs(base.mv)} → **${fmtRs(last.mv)}**`, `වටිනාකම: ${fmtRs(base.mv)} → **${fmtRs(last.mv)}**`, `Value: ${fmtRs(base.mv)} → **${fmtRs(last.mv)}**`),
    `${gain >= 0 ? '✅' : '🔻'} ${pick(st, 'Market gain/loss', 'Market එකෙන් ලාභ/පාඩු', 'Market gain/loss')}: **${fmtRs(gain)}**${base.cost ? ` (${fmtPct((gain / base.cost) * 100)})` : ''}`,
  ];
  if (Math.abs(added) > 1) lines.push(pick(st, `Money added/removed: ${fmtRs(added)} (not counted as gain)`, `දාපු/ගත්ත මුදල්: ${fmtRs(added)} (ලාභයට ගණන් නැහැ)`, `Added/removed: ${fmtRs(added)}`));
  const hi = used.reduce((m, s) => (s.mv > m.mv ? s : m), used[0]);
  lines.push(pick(st, `Highest value: ${fmtRs(hi.mv)} on ${hi.day}`, `වැඩිම වටිනාකම: ${fmtRs(hi.mv)} (${hi.day})`, `Peak: ${fmtRs(hi.mv)} (${hi.day})`));
  return R(lines.join('\n'), {
    spark: used.map((s) => s.mv).slice(-120),
    chips: [chip(pick(st, 'This week', 'මේ සතියේ', 'me sathiye performance')), chip(pick(st, 'This year', 'මේ අවුරුද්දේ', 'me awurudde performance')), chip(pick(st, 'Sector breakdown', 'Sector බෙදීම', 'sector breakdown'))],
    actions: [tabAct('Open Charts', 'charts')],
  });
}

/* ---------- Sector breakdown ---------- */
function sectorReply(st) {
  const s = portfolioStats();
  if (!s.priced.length) return portfolioReply(st);
  const by = new Map();
  for (const r of s.priced) by.set(sectorOf(r.symbol), (by.get(sectorOf(r.symbol)) || 0) + r.value);
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [pick(st, '— Your portfolio by sector —', '— Sector අනුව ඔයාගේ portfolio —', '— Sector breakdown —')];
  for (const [sec, v] of rows) {
    const pct = (v / s.totalValue) * 100;
    lines.push(`${'▇'.repeat(Math.max(1, Math.round(pct / 5)))} **${sec}** ${fmtNum(pct, 1)}% (${fmtRs(v)})`);
  }
  if (rows[0] && rows[0][1] / s.totalValue >= 0.5 && rows.length > 1) {
    lines.push(pick(st, `ℹ️ Over half is in ${rows[0][0]}.`, `ℹ️ බාගයකට වඩා ${rows[0][0]} වල.`, `ℹ️ බාගෙට වඩා ${rows[0][0]}.`));
  }
  lines.push(DISCLAIMER(st));
  return R(lines.join('\n'), { actions: [tabAct('Open Charts', 'charts')] });
}

/* ---------- Log a trade from chat ---------- */
function tradeConfirmAction(side, sym, qty, price, st) {
  if (!sym || !qty || !price) return null;
  const full = A.row(sym) ? A.sym(A.row(sym)) : normalizeSymbol(sym);
  if (side === 'sell') {
    const h = heldMap().get(baseOf(full));
    if (!h || qty > h.qty) return null;
  }
  return {
    label: side === 'sell'
      ? pick(st, `➕ Log this SELL to History`, `➕ මේ SELL එක History එකට දාන්න`, `➕ SELL එක log කරන්න`)
      : pick(st, `➕ Log this BUY (updates Portfolio)`, `➕ මේ BUY එක Portfolio එකට දාන්න`, `➕ BUY එක portfolio ekata danna`),
    trade: { type: side, symbol: full, qty: Math.round(qty), price },
  };
}

/** Called by the UI when a confirm button is clicked. */
function logTradeNow(trade, st) {
  const h0 = heldMap().get(baseOf(trade.symbol));
  if (trade.type === 'sell' && (!h0 || trade.qty > h0.qty)) {
    return R(pick(st, 'You don’t hold that many shares — not logged.', 'ඔයා ළඟ ඒ තරම් shares නැහැ — log කළේ නැහැ.', 'ඒ තරම් shares නැහැ — log කළේ නැහැ.'));
  }
  const tx = recordTransaction({ type: trade.type, symbol: trade.symbol, qty: trade.qty, price: trade.price, note: 'via chat' });
  const h = heldMap().get(baseOf(trade.symbol));
  const lines = [pick(st,
    `✓ Logged ${trade.type.toUpperCase()} ${fmtNum(trade.qty, 0)} ${shortSym(trade.symbol)} @ Rs ${fmtNum(trade.price)}.`,
    `✓ ${trade.type.toUpperCase()} ${fmtNum(trade.qty, 0)} ${shortSym(trade.symbol)} @ Rs ${fmtNum(trade.price)} log කළා.`,
    `✓ ${trade.type.toUpperCase()} ${fmtNum(trade.qty, 0)} ${shortSym(trade.symbol)} log කළා.`)];
  if (trade.type === 'sell') lines.push(`Realized: **${fmtRs(tx?.realized)}**`);
  if (h) lines.push(pick(st, `Now: ${fmtNum(h.qty, 0)} @ avg Rs ${fmtNum(h.avg)} · B.E.S Rs ${fmtNum(h.besPrice)}`, `දැන්: ${fmtNum(h.qty, 0)} @ avg Rs ${fmtNum(h.avg)} · B.E.S Rs ${fmtNum(h.besPrice)}`, `දැන්: ${fmtNum(h.qty, 0)} @ Rs ${fmtNum(h.avg)} · B.E.S ${fmtNum(h.besPrice)}`));
  else lines.push(pick(st, 'Position closed.', 'Position එක close වුණා.', 'Position close.'));
  lines.push(pick(st, 'Undo by deleting it in History.', 'වැරදි නම් History එකෙන් delete කරන්න.', 'Undo = History එකෙන් delete.'));
  return R(lines.join('\n'), { actions: [tabAct('Open Portfolio', 'portfolio'), tabAct('Open History', 'history')] });
}

/* =====================================================================
 * AI fallback (optional)
 * ===================================================================== */
let aiState = 'unknown'; // 'unknown' | 'on' | 'off'
let aiNoticeShown = false;

/** Short, factual context so the AI answers with the user's real numbers. */
function aiContext(raw, st) {
  const s = marketStatus();
  const lines = [
    `Now: Colombo ${s.hhmm}, ${new Date().toISOString().slice(0, 10)}. Market ${s.open ? 'open' : 'closed'} (Mon–Fri 09:30–14:30).`,
    `Commission rate set in app: ${fmtNum(A.commissionPct())}%.`,
  ];
  const { found } = detectSymbols(raw);
  const syms = [...new Set([...found, ctx.lastSymbol].filter(Boolean))].slice(0, 4);
  for (const sym of syms) {
    const p = A.price(sym);
    if (p != null) lines.push(`${shortSym(sym)} (${A.name(A.row(sym)) || ''}): last Rs ${fmtNum(p)}, today ${fmtPct(A.chg(sym))}.`);
  }
  const personal = st === 'ta' || /\b(my|mine|mage|mge|me|i|portfolio|holding|holdings|profit|loss)\b|මගේ|என்|எனது/i.test(raw);
  if (personal) {
    const ps = portfolioStats();
    if (ps.priced.length) {
      lines.push(`User portfolio: value Rs ${fmtNum(ps.totalValue)}, cost Rs ${fmtNum(ps.totalCost)}, P/L after sell commission Rs ${fmtNum(ps.pl)}.`);
      for (const r of ps.priced.slice(0, 15)) {
        lines.push(`- ${shortSym(r.symbol)}: ${fmtNum(r.qty, 0)} sh, avg ${fmtNum(r.avg)}, now ${fmtNum(r.price)}, B.E.S ${fmtNum(r.bes)}, P/L ${fmtNum(r.pl)} (${fmtNum(r.plPct)}%), signal ${r.status.toUpperCase()}, sector ${sectorOf(r.symbol)}`);
      }
    } else {
      lines.push('User has no holdings with prices.');
    }
  }
  return lines.join('\n');
}

async function askAI(query, st) {
  if (!CONFIG.aiEndpoint || aiState === 'off') return null;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), CONFIG.aiTimeoutMs) : null;
  try {
    const res = await fetch(apiUrl(CONFIG.aiEndpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        messages: [...ctx.turns.slice(-8), { role: 'user', content: query }],
        context: aiContext(query, st),
        lang: st,
      }),
      signal: ctl?.signal,
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) { aiState = 'off'; return null; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 503 || res.status === 404) { aiState = 'off'; return null; }
    if (res.status === 429) {
      return R(pick(st,
        'The free AI limit is reached for now — please try again later. I can still answer app, portfolio and company questions.',
        'Free AI limit එක දැනට ඉවරයි — ටිකකින් ආයෙ try කරන්න. App, portfolio, company ප්‍රශ්න වලට මට තාමත් උත්තර දෙන්න පුළුවන්.',
        'Free AI limit එක ඉවරයි — ටිකකින් try කරන්න. Portfolio / company ප්‍රශ්න නම් අහන්න පුළුවන්.'), { chips: starterChips(st) });
    }
    const reply = res.ok && typeof data?.reply === 'string' ? data.reply.trim() : '';
    if (!reply) return null;
    aiState = 'on';
    let text = reply;
    if (!aiNoticeShown) {
      aiNoticeShown = true;
      text += '\n\n' + pick(st,
        '✨ AI answer — it can make mistakes; check numbers in the app. Not investment advice.',
        '✨ AI උත්තරයක් — වැරදි වෙන්න පුළුවන්; numbers app එකෙන් check කරන්න. Investment advice නෙවෙයි.',
        '✨ AI answer — වැරදි වෙන්න පුළුවන්, numbers app එකෙන් check කරන්න. Advice නෙවෙයි.');
    }
    return R(text, { ai: true });
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
  brief: /\b(brief|daily brief|morning brief|summary today|today'?s? (summary|update)|ada mokada|ada update)\b|අද සාරාංශ|^good morning[!.\s]*$/i,
  alert: /\balerts?\b|\bnotify\b|\btell me when\b|\bremind\b|\bmathak\b|\bdanwanna\b|දන්වන්න|මතක් කරන්න/i,
  alertWeak: /\bkiyanna\b|\bkiyanawada\b|කියන්න/i,
  dividends: /(xd|dividends?|divs?|ලාභාංශ)/i,
  divWhen: /\b(upcoming|next|coming|ena|enne|dates?|mage|my|kawada|kawadada|when|list|income|keeyada|kiyada|labenne|labena|enawa)\b|එන|ලැබෙන|මගේ|කවදා/i,
  divIncome: /income|keeyada|kiyada|labenne|labena|how much|ආදායම|ලැබෙන/i,
  realized: /realized|realised|wikunala|vikunala|wikunapu|vikunapu|sold|booked|විකුණලා|විකුණපු|(profit|labaya|ලාභ).*(this year|me awurudde|awurudde|අවුරුද්දේ)/i,
  trades: /\b(last|recent|mage|my)\s*(trades?|transactions?)\b|trade history|transaction history/i,
  perf: /performance|kohomada giye|kohomada giya|progress|growth|value history|(this|last|me|pahugiya)\s*(week|month|year|sathiye|maase|awurudde)|සතියේ|මාසේ|portfolio.*(history|trend)/i,
  sector: /sector|diversif|allocation|bedila|බෙදීම|විවිධ/i,
  newsWord: /\bnews\b|පුවත්|\bheadlines?\b/i,
  annWord: /announcements?|disclosures?|filings?|nivedana|නිවේදන/i,
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
  if (RX.brief.test(q)) return briefReply(st);

  // Load symbols only if the text might contain one (cheap check)
  if (/[A-Za-z]{2,}/.test(raw)) {
    try { await ensureMarketSymbols(); } catch { /* offline */ }
  }
  const { found: syms, suggestions } = detectSymbols(raw);
  const sym = syms[0] || null;
  const hasNum = /\d/.test(raw.replace(/\b[A-Za-z]{2,8}\.[A-Za-z]\d{4}\b/g, ''));

  // Tamil → AI (with the user's live numbers as context)
  if (st === 'ta') {
    const ai = await askAI(raw, st);
    if (ai) return ai;
  }

  // Price alerts: "alert COMB 160", "COMB 140ට බැස්සොත් කියන්න", "my alerts"
  if ((RX.alert.test(raw) || (RX.alertWeak.test(raw) && hasNum && sym)) && !/what is|mokakda|meaning/.test(q) && !/\b(sell|near)\s*alerts?\b/i.test(q)) {
    return alertReply(raw, q, sym, st);
  }

  // What-if / average down / target profit
  if (hasNum) {
    const w = whatIfReply(raw, q, sym || (ctx.lastSymbol && /\b(eke|it|its|that)\b|ඒක/.test(q) ? ctx.lastSymbol : null), st);
    if (w) return w;
  }

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

  // 3b) Dividends on your shares / income
  if (RX.dividends.test(raw) && !hasNum && !/what is|mokakda|mokadda|meaning|kiyanne|තේරුම|මොකද/.test(q) && (RX.divWhen.test(raw) || /^(upcoming )?(xd|dividends?)\??$/i.test(q))) {
    return dividendsReply(st, RX.divIncome.test(raw) ? 'income' : 'list');
  }

  // 3c) Company news / announcements
  const newsSym = sym || (ctx.lastSymbol && /\b(eke|it|its|that|ewa)\b|ඒකේ/.test(q) ? ctx.lastSymbol : null);
  if (RX.annWord.test(raw)) return announcementsReply(st, newsSym);
  if (RX.newsWord.test(raw) && newsSym && !RX.open.test(q.replace(/\bshow\b/, ''))) {
    const hit = await resolveBySymbol(newsSym);
    if (hit) { ctx.lastSymbol = hit.symbol; return companyNewsReply(hit.symbol, st); }
  }

  // 3d) History, performance, sectors
  if (RX.realized.test(raw) && !hasNum) return realizedReply(st);
  if (RX.trades.test(raw)) return tradesReply(st);
  if (RX.perf.test(raw) && !sym) return performanceReply(raw, st);
  if (RX.sector.test(raw) && !sym) return sectorReply(st);

  // 4) Portfolio
  if (!hasNum && !/what is|mokakda|mokadda|meaning|kiyanne|තේරුම|මොකද/.test(q) &&
      /\bsignals?\b|\b(sell|near)\s*(list|eka|ewa|shares?|alerts?)\b|which .*\b(sell|near)\b|sell karanna puluwan|\balerts?\b/i.test(q)) {
    return signalsReply(st);
  }
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
      return { navigate: t.id, navSym: (t.id === 'fund' || t.id === 'tech') ? ctx.lastSymbol : null, ...R(pick(st, `Opening ${t.label} ↗`, `${t.label} open කරනවා ↗`, `${t.label} open කළා ↗`)) };
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

  // 8b) A lone ticker that isn't in today's trade list (e.g. not traded today)
  if (!sym && /^[A-Za-z]{2,8}(\.[A-Za-z]\d{4})?$/.test(raw) && !NOT_SYMBOL.has(q) && !TABS.some((t) => t.re.test(q)) && !glossaryMatch(q)) {
    const hit = await resolveBySymbol(raw);
    if (hit) return companyReply(hit, st);
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

/** Safe mini-markdown: **bold**, [text](https://…), URLs, “— header —” lines. No innerHTML. */
function renderRich(node, text) {
  String(text).split('\n').forEach((line, i) => {
    if (i) node.appendChild(document.createElement('br'));
    const isHdr = /^—.*—$/.test(line.trim());
    const target = isHdr ? node.appendChild(el('strong', 'cse-chat-h')) : node;
    const re = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) target.appendChild(document.createTextNode(line.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('**')) {
        target.appendChild(el('strong', null, tok.slice(2, -2)));
      } else if (tok.startsWith('[')) {
        const mm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        const a = document.createElement('a');
        a.href = mm[2];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = mm[1];
        target.appendChild(a);
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

const plain = (t) => String(t).replace(/\*\*/g, '').replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '$1');

/** Tiny inline line chart (SVG, no libraries). */
function sparkSvg(values) {
  const NS = 'http://www.w3.org/2000/svg';
  const w = 240, h = 48, pad = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    pad + (i * (w - pad * 2)) / Math.max(1, values.length - 1),
    h - pad - ((v - min) / span) * (h - pad * 2),
  ]);
  const up = values[values.length - 1] >= values[0];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', `cse-chat-spark ${up ? 'up' : 'down'}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Trend ${up ? 'up' : 'down'}: ${fmtNum(values[0])} to ${fmtNum(values[values.length - 1])}`);
  const area = document.createElementNS(NS, 'path');
  area.setAttribute('d', `M${pts[0][0]},${h - pad} ` + pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${pts[pts.length - 1][0]},${h - pad} Z`);
  area.setAttribute('class', 'a');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '));
  line.setAttribute('class', 'l');
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', pts[pts.length - 1][0]);
  dot.setAttribute('cy', pts[pts.length - 1][1]);
  dot.setAttribute('r', '2.5');
  dot.setAttribute('class', 'd');
  svg.append(area, line, dot);
  return svg;
}

function store(key, val) {
  try { sessionStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ }
}
function load(key, def) {
  try { const v = JSON.parse(sessionStorage.getItem(key) || 'null'); return v ?? def; } catch { return def; }
}

/** 3D-style robot face (inline SVG). `k` keeps gradient ids unique per copy. */
function robotSvg(k = 'a', cls = 'cse-bot') {
  return `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="rb-head-${k}" cx="38%" cy="30%" r="75%">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#e3e8f0"/><stop offset="1" stop-color="#9aa4b5"/>
    </radialGradient>
    <linearGradient id="rb-gold-${k}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff1b8"/><stop offset=".45" stop-color="#e7bf45"/><stop offset="1" stop-color="#8a6a12"/>
    </linearGradient>
    <linearGradient id="rb-visor-${k}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a3647"/><stop offset="1" stop-color="#0a0e14"/>
    </linearGradient>
    <radialGradient id="rb-eye-${k}" cx="50%" cy="40%" r="60%">
      <stop offset="0" stop-color="#fffbe0"/><stop offset=".5" stop-color="#ffd24a"/><stop offset="1" stop-color="#ff9f1a"/>
    </radialGradient>
    <filter id="rb-glow-${k}" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <ellipse class="rb-shadow" cx="32" cy="59" rx="15" ry="2.6" fill="#000" opacity=".28"/>
  <g class="rb-body">
    <g class="rb-antenna">
      <rect x="30.8" y="6.5" width="2.4" height="8" rx="1.2" fill="url(#rb-gold-${k})"/>
      <circle class="rb-bulb" cx="32" cy="6" r="3.3" fill="url(#rb-eye-${k})" filter="url(#rb-glow-${k})"/>
    </g>
    <rect x="7.5" y="25" width="7" height="15" rx="3.5" fill="url(#rb-gold-${k})"/>
    <rect x="49.5" y="25" width="7" height="15" rx="3.5" fill="url(#rb-gold-${k})"/>
    <rect x="12" y="13" width="40" height="38" rx="14" fill="url(#rb-head-${k})"/>
    <rect x="12" y="13" width="40" height="38" rx="14" fill="none" stroke="#7d8798" stroke-opacity=".35"/>
    <ellipse cx="22" cy="18.5" rx="7" ry="3" fill="#fff" opacity=".75"/>
    <rect x="16.5" y="22" width="31" height="19" rx="9" fill="url(#rb-visor-${k})"/>
    <path d="M20 25.5c3-2.4 9-3 14-2.6" stroke="#fff" stroke-opacity=".28" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <g class="rb-eyes" filter="url(#rb-glow-${k})">
      <ellipse cx="25.5" cy="31" rx="3.3" ry="4" fill="url(#rb-eye-${k})"><animate attributeName="ry" dur="5s" repeatCount="indefinite" values="4;4;0.4;4;4;0.4;4;0.4;4;4" keyTimes="0;0.36;0.4;0.45;0.8;0.83;0.87;0.9;0.94;1"/></ellipse>
      <ellipse cx="38.5" cy="31" rx="3.3" ry="4" fill="url(#rb-eye-${k})"><animate attributeName="ry" dur="5s" repeatCount="indefinite" values="4;4;0.4;4;4;0.4;4;0.4;4;4" keyTimes="0;0.36;0.4;0.45;0.8;0.83;0.87;0.9;0.94;1"/></ellipse>
    </g>
    <path d="M28.5 37.2q3.5 2.4 7 0" stroke="#ffd24a" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".85"/>
    <circle cx="18.5" cy="44" r="2.4" fill="#ff8fa3" opacity=".45"/>
    <circle cx="45.5" cy="44" r="2.4" fill="#ff8fa3" opacity=".45"/>
  </g>
</svg>`;
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
  const avatar = el('span', 'cse-chat-avatar');
  avatar.innerHTML = robotSvg('head', 'cse-bot-mini');
  head.append(avatar, title);

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

  const fab = el('button', 'cse-chat-fab');
  fab.innerHTML = robotSvg('fab'); // static markup, no user data
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      requestAnimationFrame(() => root.querySelectorAll('svg.cse-bot, svg.cse-bot-mini').forEach((svg) => svg.pauseAnimations?.()));
    }
  } catch { /* ignore */ }
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Open help chat');
  fab.setAttribute('aria-expanded', 'false');
  fab.title = 'CSE Assistant';

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
    const spark = typeof msg === 'object' && Array.isArray(msg.spark) && msg.spark.length >= 2 ? msg.spark : null;
    if (spark) bubble.appendChild(sparkSvg(spark));
    if (typeof msg === 'object' && msg.ai) bubble.classList.add('ai');
    wrap.appendChild(bubble);

    if (who === 'bot') {
      const acts = (typeof msg === 'object' && msg.actions) || [];
      if (acts.some((a) => a.url || a.tab || (a.trade && save))) {
        const row = el('div', 'cse-chat-actions');
        for (const a of acts) {
          if (a.url) {
            const link = el('a', 'cse-chat-act', a.label + ' ↗');
            link.href = a.url;
            if (/^https?:/.test(a.url)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
            row.appendChild(link);
          } else if (a.trade && save) {
            // Log a trade from chat — only on fresh messages (never from restored history)
            const b = el('button', 'cse-chat-act primary', a.label);
            b.type = 'button';
            b.addEventListener('click', () => {
              b.disabled = true;
              b.textContent = '✓';
              try {
                const res = logTradeNow(a.trade, lastStyle);
                addMsg(res, 'bot');
                toast(plain(res.text.split('\n')[0]));
              } catch (err) {
                console.warn('[chatbot] log trade', err);
                addMsg(pick(lastStyle, 'Could not log the trade — try in the History tab.', 'Trade එක log කරන්න බැරි වුණා — History tab එකෙන් try කරන්න.', 'Log වුණේ නැහැ — History tab එකෙන් කරන්න.'), 'bot');
              }
            });
            row.appendChild(b);
          } else if (a.tab) {
            const b = el('button', 'cse-chat-act', a.label + ' →');
            b.type = 'button';
            b.addEventListener('click', () => {
              openTab(a.tab, a.sym);
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
      if (typeof msg === 'object' && msg.ai) tools.prepend(el('span', 'cse-chat-aitag', '✨ AI'));
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
        spark: typeof msg === 'object' && msg.spark ? msg.spark : null,
        ai: typeof msg === 'object' && !!msg.ai,
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
      addMsg({ text: h.text, actions: h.actions || [], spark: h.spark, ai: h.ai }, h.who, { save: false });
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
      if (history.length) { restore(); setChips(starterChips(lastStyle)); }
      else if (wantsBrief()) showBrief();
      else welcome();
    }
    input.focus();
  }

  /** First open of the day (with holdings) → daily brief instead of the plain welcome. */
  function wantsBrief() {
    if (!A.holdings().length) return false;
    const day = new Date().toISOString().slice(0, 10);
    try {
      if (localStorage.getItem('cseChat.briefDay') === day) return false;
      localStorage.setItem('cseChat.briefDay', day);
    } catch { /* ignore */ }
    return true;
  }

  async function showBrief() {
    const typing = el('div', 'cse-chat-msg bot');
    const dots = el('div', 'cse-chat-bubble bot cse-chat-thinking');
    dots.append(el('span'), el('span'), el('span'));
    typing.appendChild(dots);
    msgs.appendChild(typing);
    try {
      const r = await briefReply(lastStyle);
      typing.remove();
      addMsg(r, 'bot');
      setChips(r.chips);
    } catch {
      typing.remove();
      welcome();
    }
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
        openTab(res.navigate, res.navSym);
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

  // Price alerts: checked every time the app refreshes prices.
  onChange((topic) => {
    if (topic !== 'prices' && topic !== 'all') return;
    const fired = checkAlerts();
    if (!fired.length) return;
    const st = lastStyle;
    const txt = fired.map((a) => `⏰ **${shortSym(a.sym)}** ${pick(st, 'is now', 'දැන්', 'දැන්')} Rs ${fmtNum(a.now)} (${pick(st, 'alert', 'alert', 'alert')} ${a.dir === 'above' ? '≥' : '≤'} ${fmtNum(a.price)})`).join('\n');
    toast(plain(txt).replace(/\n/g, ' · '), { ms: 6000 });
    try {
      if (state.settings?.notify && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('CSE Portfolio — price alert', { body: plain(txt), icon: 'assets/icons/icon-192.png', tag: 'cse-chat-alert' });
      }
    } catch { /* some mobile browsers only allow notifications from a service worker */ }
    if (!msgs.childElementCount && history.length) restore();
    addMsg(R(txt), 'bot');
    setChips(fired.map((a) => chip(shortSym(a.sym))));
    if (panel.hidden) fab.classList.add('has-dot');
  });
}

/** Exposed for tests / other modules (e.g. open the chat with a question). */
export { respond as chatRespond, marketStatus as chatMarketStatus };

export default { init: initChatbot };
