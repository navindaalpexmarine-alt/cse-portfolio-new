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

function findCompany(query) {
  const q = (query || '').toLowerCase().replace(/[?.!,]/g, ' ').trim();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  const market = state.market || [];
  if (!market.length) return null;

  const symMatch = query.toUpperCase().match(/\b([A-Z]{2,8})(?:\.(N|X|P|Z)?\d*)?\b/);
  if (symMatch) {
    const base = symMatch[1];
    const hit = market.find((m) => {
      const s = m.symbol || '';
      return s === base || s.startsWith(base + '.') || s.replace(/\..*$/, '') === base;
    });
    if (hit) return hit;
  }

  let best = null;
  let bestScore = 0;
  for (const m of market) {
    const sym = (m.symbol || '').toLowerCase();
    const name = (m.name || '').toLowerCase();
    let sc = 0;
    if (q.includes(sym) || q.includes(sym.split('.')[0])) sc += 5;
    for (const t of tokens) {
      if (t.length < 3) continue;
      if (name.includes(t)) sc += 3;
      if (sym.includes(t)) sc += 2;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = m;
    }
  }
  return bestScore >= 3 ? best : null;
}

async function companyReply(hit, st) {
  const pm = state.priceMap?.[hit.symbol] || {};
  const price = pm.price ?? hit.price;
  const chg = pm.changePct ?? pm.percentageChange ?? pm.change;
  const name = hit.name || hit.symbol;
  let extra = '';
  try {
    const data = await cse('tradeSummary');
    const list = data?.reqTradeSummery || data || [];
    const row = list.find((x) => String(x.symbol || '').toUpperCase() === hit.symbol);
    if (row) {
      const vol = row.sharevolume ?? row.shareVolume ?? row.volume;
      const turn = row.turnover;
      if (vol != null) extra += `\nVolume: ${fmtNum(vol)}`;
      if (turn != null) extra += `\nTurnover: Rs ${fmtNum(turn)}`;
    }
  } catch { /* ignore */ }

  return pick(st,
    `${name} (${hit.symbol})\nLast price: Rs ${fmtNum(price)}\nChange: ${fmtPct(chg)}${extra}\n\nMore detail: Fundamentals or Technicals tab → type this symbol → Load.\nNot investment advice.`,
    `${name} (${hit.symbol})\nඅවසාන මිල: Rs ${fmtNum(price)}\nවෙනස: ${fmtPct(chg)}${extra}\n\nතව details: Fundamentals / Technicals tab එකේ symbol එක Load කරන්න.\nInvestment advice නෙවෙයි.`,
    `${name} (${hit.symbol})\nLast price: Rs ${fmtNum(price)} · Change: ${fmtPct(chg)}${extra}\n\nFundamentals/Technicals tab එකේ මේ symbol Load කරන්න තව info එකට.\nAdvice නෙවෙයි — market numbers විතරයි.`
  );
}

const FAQ = [
  {
    test: (q) => /^(hi|hello|hey|ayubowan|ayu)\b/i.test(q) || /ආයුබෝවන්|හායි|කොහොමද/.test(q),
    reply: (st) => pick(st,
      'Hey! Ask about the app (portfolio, calculator, dividends…) or a CSE company / symbol — e.g. COMB, SAMP.',
      'ආයුබෝවන්! App එක ගැන හෝ CSE company/symbol එකක් අහන්න — උදා: COMB, SAMP.',
      'Hi! App ගැන හෝ company symbol එකක් type කරන්න (COMB, SAMP). Calculator / portfolio ගැනත් අහන්න පුළුවන්.'
    ),
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

  const maybeCompany = /[a-zA-Z]{2,}|company|share|price|කොටස|මිල|ශෙයර්/.test(q);
  if (maybeCompany) {
    try { await ensureMarketSymbols(); } catch { /* offline */ }
  }

  const hit = findCompany(q);
  const companyAsk = hit && (
    /price|share|company|stock|කොටස|මිල|ගැන|about|tell|what|කියන්න|details|info/.test(q.toLowerCase())
    || q.trim().length <= 28
    || q.toUpperCase().includes((hit.symbol || '').split('.')[0])
  );

  if (hit && companyAsk) return companyReply(hit, st);

  const faq = faqReply(q);
  if (faq) return faq;
  if (hit) return companyReply(hit, st);
  return fallback(st);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
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
  head.innerHTML = '<strong>Help</strong><span class="cse-chat-sub">EN · සිංහල · mix</span>';
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
    const bubble = el('div', `cse-chat-bubble ${who}`);
    bubble.textContent = text;
    msgs.appendChild(bubble);
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
