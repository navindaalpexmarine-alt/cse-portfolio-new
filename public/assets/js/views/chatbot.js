/**
 * Lightweight bilingual (English / Sinhala) help chatbot for CSE Portfolio.
 * Rule-based answers about the app — no external AI API required.
 */
import { $ } from '../core/utils.js';

const SINHALA_RE = /[\u0D80-\u0DFF]/;

function isSinhala(text) {
  return SINHALA_RE.test(text || '');
}

/** Knowledge base: each item has keywords (EN + SI) and answers in both languages. */
const KB = [
  {
    keys: ['hello', 'hi', 'hey', 'ayubowan', 'ayu', 'හායි', 'ආයුබෝවන්', 'කොහොමද'],
    en: 'Hi! I can explain CSE Portfolio — portfolio tracking, calculator, dividends, news, and guides. What do you want to know?',
    si: 'ආයුබෝවන්! CSE Portfolio ගැන — portfolio, calculator, dividends, news, guides — මම පැහැදිලි කරන්නම්. මොකක්ද අහන්න ඕන?',
  },
  {
    keys: ['what is', 'about', 'app', 'website', 'cse portfolio', 'මොකක්ද', 'ගැන', 'website එක', 'app එක', 'මේක මොකද'],
    en: 'CSE Portfolio is a free web tool for Colombo Stock Exchange investors. Track shares, calculate break-even after commission, log dividends, read news, and view basic fundamentals/technicals. Not investment advice.',
    si: 'CSE Portfolio කියන්නේ Colombo Stock Exchange investors ලට free web tool එකක්. Shares track කරන්න, commission එක්ක break-even ගණන් කරන්න, dividends log කරන්න, news බලන්න. මේක investment advice නෙවෙයි.',
  },
  {
    keys: ['how work', 'how to use', 'help', 'guide', 'කොහොමද භාවිතා', 'කොහොමද පාවිච්චි', 'භාවිතා කරන්නේ', 'help', 'උදව්'],
    en: 'Use the tabs at the top: Portfolio (your shares), Calculator (buy/sell costs), Dividends, Charts, History, News, Fundamentals, Technicals. Guides (menu/footer) explain CSE basics in plain English. Sign in only if you want to save data across devices.',
    si: 'උඩ tabs: Portfolio, Calculator, Dividends, Charts, History, News, Fundamentals, Technicals. Footer එකේ Guides වල CSE basics තියෙනවා. Devices දෙකකට data save කරන්න ඕන නම් විතරක් Sign in කරන්න.',
  },
  {
    keys: ['portfolio', 'share', 'holding', 'track', 'පෝට්ෆෝලියෝ', 'ශෙයර්', 'track'],
    en: 'Portfolio tab: add shares with quantity and average price. Live prices update when available. B.E.S = break-even sell after commission. Sign in to sync holdings across devices; as guest you can still try the tools.',
    si: 'Portfolio tab එකේ shares, quantity, average price දාන්න. Live prices තියෙනවා නම් update වෙනවා. B.E.S = commission එක්ක break-even sell. Sync ඕන නම් Sign in; guest විදිහටත් tools use කරන්න පුළුවන්.',
  },
  {
    keys: ['calculator', 'break even', 'bes', 'commission', 'calc', 'ගණන්', 'කොමිස්'],
    en: 'Calculator: choose BUY or SELL, enter quantity and price. It shows total cost/net after the commission rate in the header (default ~1.12%). Break-even sell price is the price where you roughly recover buy costs after both sides’ fees.',
    si: 'Calculator: BUY හෝ SELL තෝරලා quantity සහ price දාන්න. Header එකේ commission rate (default ~1.12%) එක්ක total cost/net පේනවා. Break-even sell = buy costs recover වෙන approximate price (දෙපැත්තේ fees එක්ක).',
  },
  {
    keys: ['dividend', 'dps', 'ලාභාංශ', 'ඩිවිඩන්ට්'],
    en: 'Dividends tab: search seasonality patterns, log announced dividends, and estimate income from your holdings. Always confirm official XD/payment dates on the CSE — patterns are history-based only.',
    si: 'Dividends tab: seasonality patterns, announced dividends log කරන්න, holdings වලින් income estimate. Official XD/payment CSE එකෙන් confirm කරන්න — patterns history-based විතරයි.',
  },
  {
    keys: ['news', 'media', 'පුවත්'],
    en: 'News tab aggregates CSE-related and local media headlines. Filters help narrow topics. Always verify important news from official sources before trading.',
    si: 'News tab එකේ CSE සහ local media headlines. Filters තියෙනවා. Trade කරන්න කලින් official sources වලින් confirm කරන්න.',
  },
  {
    keys: ['account', 'sign in', 'login', 'register', 'password', 'recovery', 'ගිණුම', 'ලොගින්', 'සයින්'],
    en: 'You can browse calculator, news and guides without an account. Sign in to save portfolio, dividends and history to your account and sync across devices. Save your recovery code when you register — it is the only way to reset a forgotten password.',
    si: 'Calculator, news, guides account නැතුව use කරන්න පුළුවන්. Portfolio save/sync ඕන නම් Sign in. Register කරද්දී recovery code එක save කරන්න — password නැති උනාම ඒකෙන් restore කරන්න පුළුවන්.',
  },
  {
    keys: ['atrade', 'excel', 'upload', 'import'],
    en: 'On Portfolio you can upload an ATrade portfolio Excel export. The app maps symbol and quantity columns. Use Replace or Merge when prompted.',
    si: 'Portfolio එකේ ATrade Excel export upload කරන්න පුළුවන්. Symbol සහ quantity columns map වෙනවා. Replace හෝ Merge තෝරන්න.',
  },
  {
    keys: ['guide', 'guides', 'learn', 'tutorial', 'උපදෙස්', 'ගයිඩ්'],
    en: 'Open Guides from the footer or /guides/ — articles on tracking shares, commission, break-even, dividends, ASPI, CDS accounts, common mistakes, and market hours.',
    si: 'Footer එකෙන් හෝ /guides/ වලින් Guides open කරන්න — tracking, commission, break-even, dividends, ASPI, CDS, common mistakes, market hours ගැන articles.',
  },
  {
    keys: ['price', 'live', 'market', 'aspi', 'මිල', 'ලයිව්'],
    en: 'Live CSE-related prices load when the connection works. If the banner says data is unavailable, enter Market Price manually. Indices like ASPI are market context, not buy/sell signals.',
    si: 'Live CSE prices connection තියෙනකොට load වෙනවා. Banner එකේ unavailable නම් Market Price manual දාන්න. ASPI වගේ indices = market context මිස buy/sell signal නෙවෙයි.',
  },
  {
    keys: ['safe', 'privacy', 'data', 'security', 'පුද්ගලික', 'දත්ත'],
    en: 'Portfolio data is stored in your account (and a local browser copy). We do not sell your personal data. See the Privacy page in the footer for cookies and AdSense details.',
    si: 'Portfolio data ඔයාගේ account එකේ (සහ browser local copy). Personal data විකුණන්නේ නැහැ. Footer → Privacy page බලන්න.',
  },
  {
    keys: ['advice', 'buy', 'sell', 'recommend', 'tip', 'උපදෙස් දෙන්න', 'මිලදී', 'විකුණන්න'],
    en: 'This app does not give investment advice or stock tips. It only helps you organise numbers. Confirm everything with the CSE, your broker, and licensed advisers.',
    si: 'මේ app එක investment advice හෝ stock tips දෙන්නේ නැහැ. Numbers organise කරන්න විතරයි. CSE, broker, licensed advisers ලගෙන් confirm කරන්න.',
  },
  {
    keys: ['contact', 'support', 'email', 'සම්බන්ධ', 'ඊමේල්'],
    en: 'Use the Contact page linked in the footer for questions or feedback about the site.',
    si: 'Site ගැන ප්‍රශ්න/feedback තියෙනවා නම් footer එකේ Contact page බලන්න.',
  },
  {
    keys: ['adsense', 'ads', 'advertis'],
    en: 'The site may show ads when approved by Google AdSense. Ads do not change how portfolio numbers are calculated.',
    si: 'Google AdSense approve උනාම ads පේන්න පුළුවන්. Ads නිසා portfolio calculations වෙනස් වෙන්නේ නැහැ.',
  },
];

const FALLBACK = {
  en: 'I can help with: what the app is, Portfolio, Calculator, Dividends, News, account/sign-in, Guides, and privacy. Try a short question — e.g. “How does the calculator work?”',
  si: 'මම උදව් කරන්නේ: app එක මොකද, Portfolio, Calculator, Dividends, News, account, Guides, privacy. කෙටි ප්‍රශ්නයක් අහන්න — උදා: “Calculator එක කොහොමද work වෙන්නේ?”',
};

function score(query, keys) {
  const q = query.toLowerCase();
  let s = 0;
  for (const k of keys) {
    if (q.includes(k.toLowerCase())) s += k.length > 3 ? 2 : 1;
  }
  return s;
}

function answer(query) {
  const si = isSinhala(query);
  let best = null;
  let bestScore = 0;
  for (const item of KB) {
    const sc = score(query, item.keys);
    if (sc > bestScore) {
      bestScore = sc;
      best = item;
    }
  }
  if (!best || bestScore < 1) return si ? FALLBACK.si : FALLBACK.en;
  return si ? best.si : best.en;
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
  head.innerHTML = '<strong>CSE Portfolio Help</strong><span class="cse-chat-sub">EN · සිංහල</span>';
  const closeBtn = el('button', 'cse-chat-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close chat');
  head.appendChild(closeBtn);

  const msgs = el('div', 'cse-chat-msgs');
  msgs.id = 'cseChatMsgs';

  const form = document.createElement('form');
  form.className = 'cse-chat-form';
  form.innerHTML = `
    <input type="text" id="cseChatInput" class="cse-chat-input" placeholder="Ask in English or සිංහල…" autocomplete="off" maxlength="300" />
    <button type="submit" class="cse-chat-send" aria-label="Send">➤</button>
  `;

  panel.append(head, msgs, form);

  const fab = el('button', 'cse-chat-fab', '💬');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Open help chat');
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
      addMsg('Hi! / ආයුබෝවන්! Ask how the app works — Portfolio, Calculator, Dividends, News, account…', 'bot');
    }
    $('#cseChatInput')?.focus();
  }

  function close() {
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener('click', close);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#cseChatInput');
    const q = (input.value || '').trim();
    if (!q) return;
    addMsg(q, 'user');
    input.value = '';
    addMsg(answer(q), 'bot');
  });
}

export default { init: initChatbot };
