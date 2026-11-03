/**
 * Friendly help chatbot — English / Sinhala / mix (user style).
 * Looks up CSE companies from live trade summary when asked.
 */
import { $ } from '../core/utils.js';
import { ensureMarketSymbols } from '../core/symbols.js';
import { state } from '../core/store.js';
import { cse } from '../core/api.js';

const SINHALA_RE = /[\u0D80-\u0DFF]/;

function hasSi(text) {
  return SINHALA_RE.test(text || '');
}

function style(query) {
  const si = hasSi(query);
  const en = /[a-zA-Z]{3,}/.test(query || '');
  if (si && en) return 'mix';
  if (si) return 'si';
  return 'en';
}

function pick(st, en, si, mix) {
  if (st === 'si') return si;
  if (st === 'mix') return mix || (si + '\n' + en);
  return en;
}

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-LK', { maximumFractionDigits: 2 });
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** Words that appear in many CSE names — never match on these alone. */
const STOP = new Set([
  'plc', 'ltd', 'limited', 'company', 'companies', 'the', 'and', 'of', 'sri', 'lanka',
  'holdings', 'holding', 'group', 'corp', 'corporation', 'inc', 'co', 'public',
  'plantations', 'plantation', 'finance', 'bank', 'hotels', 'hotel', 'investments',
  'investment', 'services', 'service', 'trading', 'industries', 'industry',
  'details', 'detail', 'overview', 'info', 'information', 'about',
  'ගැන', 'කියන්න', 'share', 'shares', 'stock', 'wala', 'walata', 'ekk', 'eka',
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

/**
 * Resolve a CSE company from free text.
 * Uses live trade list + symbolSearch (works even if not traded today, e.g. KOTA).
 */
async function resolveCompany(query) {
  const q = (query || '').trim();
  if (!q) return null;
  const market = state.market || [];

  // Pure ticker only: "COMB" or "COMB.N0000" (whole query)
  const pure = q.toUpperCase().match(/^([A-Z]{2,8})(\.(N|X|P|Z|D|R)?\d+)?$/);
  if (pure) {
    const base = pure[1];
    const full = pure[0];
    if (base === 'PLC' || base === 'LTD') return null;
    const hit = market.find((m) => {
      const s = (m.symbol || '').toUpperCase();
      return s === full || s === base || s.startsWith(base + '.') || s.replace(/\..*$/, '') === base;
    });
    if (hit) return hit;
    try {
      const data = await cse('symbolSearch', { symbol: base });
      const rows = (data.reqCompanySymbol || []).filter((r) => r.symbol && !String(r.symbol).includes('"') && r.name && r.name !== 'NOT DEFINED');
      const n0000 = rows.find((r) => /\.N0000$/i.test(r.symbol)) || rows[0];
      if (n0000) return { symbol: n0000.symbol, name: n0000.name, id: n0000.id };
    } catch { /* ignore */ }
    return null; // do NOT invent .N0000
  }

  // Name / phrase: need company-ish intent + strong name score
  const intent = /company|share|stock|plc|ltd|price|overview|details|symbol|ticker|ගැන|කොටස|මිල|විස්තර|plantations?|bank|finance|holdings?|hotels?|tobacco|leasing/i.test(q);
  if (!intent && q.split(/\s+/).length > 1) {
    // multi-word without company intent → not a company lookup
    return null;
  }

  let best = null;
  let bestScore = 0;
  for (const m of market) {
    const sc = scoreName(q, m.name, m.symbol);
    if (sc > bestScore) {
      bestScore = sc;
      best = m;
    }
  }
  if (best && bestScore >= 12) return best;

  // symbolSearch only with distinctive 4+ letter tokens (Kotagala → KOTA)
  const tokens = q.toLowerCase().replace(/[?.!,]/g, ' ').split(/\s+/).filter((t) => t.length >= 4 && !STOP.has(t));
  if (!tokens.length) return null;

  for (const t0 of tokens) {
    const pref = t0.slice(0, 4).toUpperCase();
    try {
      const data = await cse('symbolSearch', { symbol: pref });
      const rows = (data.reqCompanySymbol || []).filter((r) => r.symbol && !String(r.symbol).includes('"') && r.name && r.name !== 'NOT DEFINED');
      let localBest = null;
      let localSc = 0;
      for (const r of rows) {
        const sc = scoreName(q, r.name, r.symbol);
        // Prefer ordinary shares
        const bonus = /\.N0000$/i.test(r.symbol) ? 2 : 0;
        if (sc + bonus > localSc) {
          localSc = sc + bonus;
          localBest = r;
        }
      }
      // Require strong name overlap (avoid random prefix hits)
      if (localBest && localSc >= 12) {
        return { symbol: localBest.symbol, name: localBest.name, id: localBest.id };
      }
    } catch { /* ignore */ }
  }

  return null;
}

/** Only run company lookup when the user is clearly asking about a stock. */
function wantsCompanyInfo(query) {
  const q = (query || '').trim();
  if (!q || isGreeting(q)) return false;
  // pure symbol
  if (/^[A-Za-z]{2,8}(\.[A-Za-z0-9]+)?$/.test(q)) return true;
  // explicit company intent / name
  if (/company|share|stock|plc|price|overview|details|symbol|ticker|ගැන|කොටස|මිල|විස්තර|plantations?|about\s+/i.test(q)) return true;
  // short query containing a ticker-like token: "COMB price", "what is SAMP"
  const words = q.split(/\s+/);
  if (words.length <= 6 && /\b[A-Za-z]{2,8}\b/.test(q) && /\b(what|who|tell|show|about|is|ගැන)\b/i.test(q)) return true;
  if (words.length <= 4 && /\b[A-Z]{2,8}\b/.test(q)) return true;
  return false;
}

async function companyReply(hit, st) {
  const sym = hit.symbol;
  const pm = state.priceMap?.[sym] || {};
  let info = {};
  let beta = {};
  let profile = null;

  try {
    const raw = await cse('companyInfoSummery', { symbol: sym });
    info = raw.reqSymbolInfo || {};
    beta = raw.reqSymbolBetaInfo || {};
  } catch { /* ignore */ }

  try {
    profile = await cse('companyProfile', { symbol: sym });
  } catch { /* may need redeploy of api whitelist */ }

  const sum = (profile?.reqComSumInfo && profile.reqComSumInfo[0]) || {};
  const bizList = profile?.infoCompanyBusinessSummary || [];
  const biz = bizList.map((b) => (b.body || b.title || '').trim()).filter(Boolean).join('; ');
  const posts = profile?.topPosts || [];
  const directors = (profile?.infoCompanyDirector || []).slice(0, 8);

  const name = sum.name || info.name || hit.name || sym;
  const sector = sum.sector || info.sectorName || info.sector || '';
  const board = sum.boardType || '';
  const web = sum.web || '';
  const established = sum.established || '';
  const price = info.lastTradedPrice ?? info.price ?? pm.price ?? hit.price;
  const chgPct = info.changePercentage ?? info.percentageChange ?? pm.changePct;
  const prev = info.previousClose;
  const high = info.hiTrade ?? info.high;
  const low = info.lowTrade ?? info.low;
  const lo52 = info.p12LowPrice ?? info.ytdLowPrice;
  const hi52 = info.p12HiPrice ?? info.ytdHiPrice;
  const vol = info.tdyShareVolume;
  const trades = info.tdyTradeVolume;
  const turn = info.tdyTurnover ?? info.turnover;
  const mcap = info.marketCap;
  const mcapPct = info.marketCapPercentage;
  const foreignPct = info.foreignPercentage;
  const foreignHold = info.foreignHoldings;
  const betaVal = beta.triASIBetaValue ?? beta.betaValueSPSL;
  const issued = info.quantityIssued;

  const lines = [];
  lines.push(`${name} (${info.symbol || sym})`);
  if (sector || board) {
    lines.push(pick(st,
      `Type: ${[sector, board].filter(Boolean).join(' · ')}`,
      `වර්ගය: ${[sector, board].filter(Boolean).join(' · ')}`,
      `Type: ${[sector, board].filter(Boolean).join(' · ')}`));
  }
  if (biz) {
    lines.push(pick(st, `Business: ${biz}`, `ව්‍යාපාරය: ${biz}`, `Business: ${biz}`));
  } else if (sector) {
    lines.push(pick(st,
      `Business: operates in the ${sector} sector (see company site for full description).`,
      `ව්‍යාපාරය: ${sector} අංශයේ (සම්පූර්ණ විස්තර company website එකේ).`,
      `Business: ${sector} sector එකේ — full story company website එකේ.`));
  }
  if (established) lines.push(pick(st, `Established: ${established}`, `ආරම්භය: ${established}`, `Established: ${established}`));
  if (web) lines.push(`Web: ${web.startsWith('http') ? web : 'https://' + web.replace(/^\/\//, '')}`);

  lines.push('');
  lines.push(pick(st, '— Market snapshot —', '— වෙළඳපොළ —', '— Market snapshot —'));
  lines.push(pick(st, `Last: Rs ${fmtNum(price)} (${fmtPct(chgPct)})`, `අවසාන මිල: Rs ${fmtNum(price)} (${fmtPct(chgPct)})`, `Last: Rs ${fmtNum(price)} · ${fmtPct(chgPct)}`));
  if (prev != null) lines.push(`Prev close: Rs ${fmtNum(prev)}`);
  if (high != null || low != null) lines.push(`Today H/L: ${fmtNum(high)} / ${fmtNum(low)}`);
  if (lo52 != null || hi52 != null) lines.push(`52w: ${fmtNum(lo52)} – ${fmtNum(hi52)}`);
  if (vol != null) lines.push(`Volume: ${fmtNum(vol)}`);
  if (trades != null) lines.push(`Trades: ${fmtNum(trades)}`);
  if (turn != null) lines.push(`Turnover: Rs ${fmtNum(turn)}`);
  if (mcap != null) lines.push(`Market cap: Rs ${fmtNum(mcap)}` + (mcapPct != null ? ` (${fmtNum(mcapPct)}% of market)` : ''));
  if (issued != null) lines.push(`Shares issued: ${fmtNum(issued)}`);
  if (foreignPct != null || foreignHold != null) {
    lines.push(pick(st,
      `Foreign holding: ${foreignPct != null ? fmtNum(foreignPct) + '%' : ''} ${foreignHold != null ? '(' + fmtNum(foreignHold) + ' shares)' : ''}`.trim(),
      `විදේශීය holding: ${foreignPct != null ? fmtNum(foreignPct) + '%' : ''} ${foreignHold != null ? '(' + fmtNum(foreignHold) + ')' : ''}`.trim(),
      `Foreign holding: ${foreignPct != null ? fmtNum(foreignPct) + '%' : ''} ${foreignHold != null ? '(' + fmtNum(foreignHold) + ')' : ''}`.trim()
    ));
  }
  if (betaVal != null) lines.push(`Beta (approx): ${fmtNum(betaVal)}`);

  if (posts.length) {
    lines.push('');
    lines.push(pick(st, '— Key people —', '— ප්‍රධාන නිලධාරීන් —', '— Key people —'));
    for (const p of posts.slice(0, 5)) {
      const nm = `${(p.firstName || '').trim()} ${(p.lastName || '').trim()}`.trim();
      const role = p.designationOther || '';
      lines.push(role ? `${role}: ${nm}` : nm);
    }
  }

  // Top shareholders: CSE public API does not expose a stable top-10 list here
  lines.push('');
  lines.push(pick(st,
    '— Major shareholders —\nTop 10 holder names are not in the free CSE feed we use. Check the latest annual report / CSE company page for the official top shareholders list.',
    '— ප්‍රධාන කොටස් හිමියන් —\nTop 10 නම් මේ free CSE feed එකේ නැහැ. Official list එක annual report හෝ CSE company page එකේ බලන්න.',
    '— Major shareholders —\nTop 10 list මේ API එකේ නැහැ. CSE company page / annual report එකේ official list බලන්න.'
  ));

  const csePage = `https://www.cse.lk/pages/company-profile/company-profile.component.html?symbol=${encodeURIComponent((info.symbol || sym).replace(/\..*$/, '') + ((info.symbol || sym).includes('.') ? '' : '.N0000'))}`;
  // simpler CSE search link
  lines.push(`CSE: https://www.cse.lk/`);
  if (sum.email1) lines.push(`Email: ${sum.email1}`);

  lines.push('');
  lines.push(pick(st,
    'More charts: Fundamentals / Technicals tab → Load symbol. Not investment advice.',
    'තව: Fundamentals / Technicals tab → symbol Load. Investment advice නෙවෙයි.',
    'තව charts: Fundamentals/Technicals → Load. Advice නෙවෙයි.'
  ));

  return lines.join('\n');
}

function isGreeting(q) {
  const t = (q || '').trim().toLowerCase();
  if (!t) return false;
  // how are you / how r u / how're you
  if (/how\s*are\s*you|how\s*r\s*u|howre\s*you|how\s*do\s*you\s*do/.test(t)) return true;
  // sinhala / mix
  if (/ඔබට\s*කොහොමද|ඔයාට\s*කොහොමද|ඔබ\s*කොහොමද|කොහොමද\s*[.?ǃ!]*$/.test(q)) return true;
  if (/obata\s*kohomada|oyata\s*kohomada|kohomada\??$|oba\s*kohomada/.test(t)) return true;
  // short hellos
  if (/^(hi|hello|hey|ayubowan|ayu|හායි|ආයුබෝවන්)[!.?\s]*$/i.test(t)) return true;
  if (/^(hi|hello|hey)\b/.test(t) && t.length < 24) return true;
  return false;
}

function greetingReply(st) {
  return pick(st,
    "I'm good, thanks for asking! 😊 How can I help — app tips, or a CSE company symbol like COMB?",
    'මම හොඳට ඉන්නවා, අහපු එකට thanks! 😊 App එක ගැන හෝ company symbol එකක් අහන්න පුළුවන් (COMB, SAMP…).',
    "මම හොඳට ඉන්නවා! 😊 How can I help — calculator/portfolio ගැන, හෝ company එකක් (COMB)?"
  );
}

const FAQ = [
  {
    test: (q) => isGreeting(q),
    reply: (st) => greetingReply(st),
  },
  {
    test: (q) => /what is|about (this )?(app|site|website)|cse portfolio|මේක මොකද|app එක මොකද|website එක මොකද/.test(q),
    reply: (st) => pick(st,
      'CSE Portfolio is a free CSE tool: track shares, buy/sell calculator with commission, dividends, news, fundamentals & charts. Not investment advice.',
      'CSE Portfolio = CSE investors ලට free tool එකක්. Shares track, calculator, dividends, news, charts. Investment advice නෙවෙයි.',
      'CSE Portfolio කියන්නේ free CSE tool එකක් — portfolio track, calculator (commission එක්ක), dividends, news. Advice නෙවෙයි, numbers organise කරන්න.'
    ),
  },
  {
    test: (q) => /how (to )?use|how (does|do).*work|කොහොමද (පාවිච්චි|භාවිතා|use)|කොහොමද work|help|උදව්/.test(q),
    reply: (st) => pick(st,
      'Use the top tabs: Portfolio, Calculator, Dividends, Charts, History, News, Fundamentals, Technicals. Guides are in the footer. Sign in only to save/sync.',
      'උඩ tabs: Portfolio, Calculator, Dividends, News… Footer එකේ Guides. Save/sync ඕන නම් විතරක් Sign in.',
      'Tabs උඩින් switch කරන්න. Guides footer එකේ. Guest විදිහටත් tools use කරන්න පුළුවන් — save ඕන නම් Sign in.'
    ),
  },
  {
    test: (q) => /calculator|break.?even|bes|commission|කැල්කියුලේටර්|කොමිස්/.test(q),
    reply: (st) => pick(st,
      'Calculator: BUY or SELL → qty + price. Uses commission % in the header. Shows total/net and break-even sell. On SELL, enter buy cost for P/L.',
      'Calculator: BUY/SELL තෝරලා qty + price දාන්න. Header commission use වෙනවා. Break-even පේනවා. SELL එකේ buy cost දැම්මොත් profit/loss.',
      'Calculator tab → BUY/SELL → qty + price දාන්න. Commission header එකෙන්. Break-even හා P/L ඒකෙන් බලන්න පුළුවන්.'
    ),
  },
  {
    test: (q) => /portfolio|holding|track.*share|පෝට්ෆෝලියෝ/.test(q),
    reply: (st) => pick(st,
      'Portfolio: + Add share with symbol, qty, avg price. Live prices when available. B.E.S = break-even after commission. Sign in to sync devices.',
      'Portfolio: + Add share → symbol, qty, avg price. Live prices තියෙනවා. B.E.S = commission එක්ක break-even. Sync = Sign in.',
      'Portfolio tab එකේ + Add share. Qty + avg price දාන්න. B.E.S කියන්නේ commission එක්ක break-even. Sync ඕන නම් Sign in.'
    ),
  },
  {
    test: (q) => /dividend|ලාභාංශ|ඩිවිඩන්/.test(q),
    reply: (st) => pick(st,
      'Dividends tab: seasonality hints, log events, estimates. Confirm official XD dates on the CSE — patterns are history only.',
      'Dividends tab එකේ patterns + log. Official XD CSE එකෙන් confirm කරන්න.',
      'Dividends tab බලන්න. Estimate තියෙනවාත් official announcement CSE එකෙන් check කරන්න.'
    ),
  },
  {
    test: (q) => /news|පුවත්/.test(q),
    reply: (st) => pick(st,
      'News tab: CSE-related + local media headlines, with filters. Verify important news officially before trading.',
      'News tab එකේ headlines + filters. Trade කරන්න කලින් official source බලන්න.',
      'News tab → filters තියෙනවා. වැදගත් එකක් official source එකෙන් confirm.'
    ),
  },
  {
    test: (q) => /sign in|login|account|register|recovery|ගිණුම|ලොගින්|සයින්/.test(q),
    reply: (st) => pick(st,
      'Without account you can use calculator, news, guides. Sign in to save portfolio across devices. Save your recovery code when you register.',
      'Account නැතුව calculator, news, guides OK. Portfolio save ඕන නම් Sign in. Recovery code save කරන්න.',
      'Guest = tools OK. Save/sync ඕන නම් Sign in. Recovery code එක miss කරන්න එපා.'
    ),
  },
  {
    test: (q) => /guide|tutorial|ගයිඩ්|උගන්ව/.test(q),
    reply: (st) => pick(st,
      'Footer → Guides, or open /guides/ — short articles on tracking, commission, break-even, dividends, ASPI, CDS, mistakes, market hours.',
      'Footer එකේ Guides හෝ /guides/ — CSE basics articles.',
      'Guides footer එකේ තියෙනවා — tracking, commission, break-even වගේ.'
    ),
  },
  {
    test: (q) => /advice|recommend|should i buy|tip එක|මිලදී ගන්නද/.test(q),
    reply: (st) => pick(st,
      'No buy/sell advice here — only tools and info. Use a licensed adviser, CSE and your broker.',
      'Buy/sell advice නැහැ. Licensed adviser + CSE/broker බලන්න.',
      'Advice නැහැ මෙතන — tools විතරයි. Decide එක ඔයාගේ broker/adviser එක්ක.'
    ),
  },
  {
    test: (q) => /contact|email|support|සම්බන්ධ/.test(q),
    reply: (st) => pick(st,
      'Footer → Contact page for site questions or feedback.',
      'Footer එකේ Contact page බලන්න.',
      'Contact = footer link.'
    ),
  },
];

function faqReply(query) {
  const q = query.toLowerCase();
  const st = style(query);
  for (const item of FAQ) {
    if (item.test(q) || item.test(query)) return item.reply(st);
  }
  return null;
}

function fallback(st) {
  return pick(st,
    'Try: “How does the calculator work?”, “What is portfolio?”, or a company like COMB / SAMP.',
    'උදා: “Calculator කොහොමද?”, “Portfolio මොකද?”, නැත්නම් COMB, SAMP.',
    'උදා: calculator කොහොමද / COMB / portfolio මොකද — එහෙම අහන්න.'
  );
}

async function respond(query) {
  const st = style(query);
  const q = (query || '').trim();
  if (!q) return fallback(st);

  // Greetings first
  if (isGreeting(q)) return greetingReply(st);

  // FAQ (app help) before any company guess
  const faq = faqReply(q);
  // If FAQ matched a real topic (not only weak), use it — but faqReply returns null if no match
  if (faq) return faq;

  // Company lookup only when clearly requested
  if (wantsCompanyInfo(q)) {
    try { await ensureMarketSymbols(); } catch { /* offline */ }
    const hit = await resolveCompany(q);
    if (hit) return companyReply(hit, st);
    return pick(st,
      'I could not match that to a CSE company. Try the exact symbol (e.g. COMB) or full name (e.g. Kotagala Plantations).',
      'CSE company එකකට match වුණේ නැහැ. Exact symbol (COMB) හෝ full name (Kotagala Plantations) try කරන්න.',
      'Match නැහැ — symbol එක (COMB) හෝ full name එක type කරන්න.'
    );
  }

  return fallback(st);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function translateUrl(text, toLang) {
  const tl = toLang || 'si';
  return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(tl)}&text=${encodeURIComponent(text)}&op=translate`;
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
  head.innerHTML = '<strong>Help</strong><span class="cse-chat-sub">EN · සිංහල · Translate</span>';
  const closeBtn = el('button', 'cse-chat-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  head.appendChild(closeBtn);

  const msgs = el('div', 'cse-chat-msgs');
  msgs.id = 'cseChatMsgs';

  const chips = el('div', 'cse-chat-chips');
  for (const [label, send] of [
    ['Calculator', 'calculator කොහොමද work වෙන්නේ?'],
    ['Portfolio', 'portfolio එක කොහොමද use කරන්නේ?'],
    ['COMB', 'COMB'],
    ['Guides', 'guides තියෙන්නේ කොහෙද?'],
  ]) {
    const b = el('button', 'cse-chat-chip', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      const inp = $('#cseChatInput');
      if (inp) inp.value = send;
      form.requestSubmit();
    });
    chips.appendChild(b);
  }

  const form = document.createElement('form');
  form.className = 'cse-chat-form';
  form.innerHTML = `
    <input type="text" id="cseChatInput" class="cse-chat-input" placeholder="Type here… English / සිංහල / mix" autocomplete="off" maxlength="300" />
    <button type="submit" class="cse-chat-send" aria-label="Send">➤</button>
  `;

  panel.append(head, msgs, chips, form);

  const fab = el('button', 'cse-chat-fab', '💬');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Open help');
  fab.title = 'Help';

  root.append(panel, fab);
  document.body.appendChild(root);

  function addMsg(text, who) {
    const wrap = el('div', `cse-chat-msg ${who}`);
    const bubble = el('div', `cse-chat-bubble ${who}`);
    bubble.textContent = text;
    wrap.appendChild(bubble);
    if (who === 'bot') {
      const tools = el('div', 'cse-chat-tools');
      const aSi = document.createElement('a');
      aSi.className = 'cse-chat-tr';
      aSi.href = translateUrl(text, 'si');
      aSi.target = '_blank';
      aSi.rel = 'noopener noreferrer';
      aSi.textContent = 'Translate → සිංහල';
      const aEn = document.createElement('a');
      aEn.className = 'cse-chat-tr';
      aEn.href = translateUrl(text, 'en');
      aEn.target = '_blank';
      aEn.rel = 'noopener noreferrer';
      aEn.textContent = 'Translate → English';
      tools.append(aSi, aEn);
      wrap.appendChild(tools);
    }
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function open() {
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    if (!msgs.childElementCount) {
      addMsg('Hi! / ආයුබෝවන්!\nApp එක ගැන අහන්න හෝ company symbol එකක් type කරන්න (COMB, SAMP…).\nපහළ quick buttons තියෙනවා.', 'bot');
    }
    $('#cseChatInput')?.focus();
  }

  function close() {
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#cseChatInput');
    const q = (inp?.value || '').trim();
    if (!q) return;
    addMsg(q, 'user');
    inp.value = '';
    const thinking = el('div', 'cse-chat-bubble bot cse-chat-thinking', '…');
    msgs.appendChild(thinking);
    msgs.scrollTop = msgs.scrollHeight;
    try {
      const a = await respond(q);
      thinking.remove();
      addMsg(a, 'bot');
    } catch {
      thinking.remove();
      addMsg(pick(style(q), 'Something went wrong — try again.', 'අවුලක් — ආයෙ try කරන්න.', 'Error එකක් — ආයෙ try කරන්න.'), 'bot');
    }
  });
}

export default { init: initChatbot };
