/**
 * News view: CSE financial disclosures + official announcements + English and
 * Sinhala local media (via the proxy), merged, de-duplicated and filterable.
 */
import { cse, news } from '../core/api.js';
import { emit, state } from '../core/store.js';
import { baseSym } from '../core/finance.js';
import { $, $$, debounce, esc, fmtDate, safeUrl, timeHM } from '../core/utils.js';
import { emptyHtml, setBusy } from '../core/ui.js';

const AUTO_MS = 180000; // 3 min, matches the proxy's CDN cache
const MEDIA_KINDS = ['google', 'en', 'ft', 'dm', 'st', 'is', 'lbo'];
const KIND_LABEL = {
  fin: 'FINANCIAL', div: 'DIVIDEND', cse: 'CSE OFFICIAL', en: 'ECONOMYNEXT', ft: 'DAILY FT', dm: 'DAILY MIRROR',
  st: 'SUNDAY TIMES', is: 'THE ISLAND', lbo: 'LBO', si: 'සිංහල MEDIA', google: 'LOCAL MEDIA',
};
const BULL = ['profit', 'growth', 'dividend', 'approval', 'expansion', 'record', 'surge', 'gain', 'upgrade', 'strong', 'rise', 'ලාභ', 'වර්ධන', 'ලාභාංශ', 'අනුමත', 'වාර්තා'];
const BEAR = ['loss', 'decline', 'warning', 'alert', 'fine', 'drop', 'fall', 'downgrade', 'weak', 'suspend', 'slash', 'අලාභ', 'පහත', 'අනතුරු', 'දඬුවම'];

let filter = 'all';
let inflight = null;
let autoTimer = null;

/** Keyword tone – a rough hint only, not advice. */
export function sentimentOf(text) {
  const t = String(text || '').toLowerCase();
  const b = BULL.filter((w) => t.includes(w)).length;
  const e = BEAR.filter((w) => t.includes(w)).length;
  return b > e ? 'bull' : e > b ? 'bear' : 'neut';
}

/** Source -> kind (publication). Sinhala script in the title also counts as Sinhala media. */
function mediaKind(source, title) {
  const s = String(source || '').toLowerCase();
  if (/ada ?derana|hiru|news ?first|lankadeepa|dinamina|mawbima/.test(s) || /[඀-෿]/.test(title || '')) return 'si';
  if (s.includes('economynext')) return 'en';
  if (s.includes('ft.lk') || s.includes('daily ft') || s === 'ft') return 'ft';
  if (s.includes('mirror')) return 'dm';
  if (s.includes('sunday times') || s.includes('sundaytimes')) return 'st';
  if (s.includes('island')) return 'is';
  if (s.includes('lbo') || s.includes('lanka business')) return 'lbo';
  return 'google';
}

const portSymbols = () => new Set(state.holdings.map((h) => baseSym(h.name)).filter(Boolean));
const mentionsPortfolio = (title, syms) => {
  const t = String(title || '').toUpperCase();
  for (const s of syms) if (s.length >= 2 && new RegExp(`\\b${s}\\b`).test(t)) return true;
  return false;
};

/** Loads every source in parallel. Concurrent callers share one request. */
export function loadNews() {
  if (inflight) return inflight;
  inflight = doLoad().finally(() => { inflight = null; });
  return inflight;
}

async function doLoad() {
  const dot = $('#newsDot'), st = $('#newsStatusText'), btn = $('#newsRefreshBtn');
  if (dot) dot.className = 'status-dot load';
  if (st) st.textContent = 'Updating…';
  setBusy(btn, true);

  const syms = portSymbols();
  const top = [...syms].slice(0, 8);
  // Anchored to Sri Lanka so "CSE"/"ASPI" don't match other exchanges or tickers.
  const latestQ = '("Colombo Stock Exchange" OR "Sri Lanka stocks" OR "Sri Lanka shares" OR (ASPI "Sri Lanka") OR (CSE "Sri Lanka")) when:7d';
  const localQ = `(${['"Colombo Stock Exchange"', 'CSE', 'ASPI', '"stock market"', 'dividend', 'bourse', ...top.slice(0, 5)].join(' OR ')}) ` +
    '(site:economynext.com OR site:ft.lk OR site:dailymirror.lk OR site:sundaytimes.lk OR site:lankabusinessonline.com OR site:island.lk OR site:adaderana.lk OR site:hirunews.lk OR site:newsfirst.lk OR site:lankadeepa.lk OR site:dinamina.lk)';

  const [fin, approved, trusted, trustedPort, local, latest] = await Promise.allSettled([
    cse('getFinancialAnnouncement'),
    cse('approvedAnnouncement'),
    news('trusted', { limit: 12 }),
    top.length ? news('trusted', { limit: 10, q: `${top.join(' OR ')} (stock OR CSE OR dividend OR shares)` }) : Promise.resolve({ items: [] }),
    news('google', { q: localQ, limit: 35 }),
    news('google', { q: latestQ, limit: 25 }),
  ]);

  const items = [];
  if (fin.status === 'fulfilled') {
    (fin.value.reqFinancialAnnouncemnets || []).forEach((a) => {
      const sym = String(a.symbol || '').toUpperCase();
      items.push({
        title: a.fileText || a.name || 'Financial announcement',
        link: a.path ? 'https://cdn.cse.lk/' + String(a.path).replace(/^\/+/, '') : 'https://www.cse.lk/',
        pubDate: a.uploadedDate || a.manualDate || '', source: 'CSE · Financial disclosure', kind: 'fin',
        symbol: sym, company: a.name || '', inPort: syms.has(baseSym(sym)),
      });
    });
  }
  if (approved.status === 'fulfilled') {
    (approved.value.approvedAnnouncements || []).slice(0, 100).forEach((a) => {
      const sym = String(a.symbol || '').toUpperCase();
      const title = [a.company, a.type, a.announcementCategory].filter(Boolean).join(' · ');
      items.push({
        title: title || 'CSE announcement',
        link: 'https://www.cse.lk/pages/announcements/announcements.component.html',
        pubDate: a.dateOfAnnouncement || a.createdDate || '', source: 'CSE · Official announcement',
        kind: /dividend|xd |x-div|cash div/i.test(title) ? 'div' : 'cse',
        symbol: sym, company: a.company || '', inPort: syms.has(baseSym(sym)),
      });
    });
  }
  for (const r of [trusted, trustedPort, local, latest]) {
    if (r.status !== 'fulfilled') continue;
    (r.value.items || []).forEach((it) => {
      const src = String(it.source || it.source_label || 'Google News').trim();
      items.push({
        title: it.title, link: it.link, pubDate: it.pubDate, source: 'Media · ' + src,
        kind: mediaKind(src, it.title), symbol: '', company: '', inPort: mentionsPortfolio(it.title, syms),
      });
    });
  }

  // De-duplicate by title, newest first.
  const seen = new Set();
  state.newsCache = items.filter((it) => {
    const k = String(it.title || '').trim().toLowerCase().slice(0, 100);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));

  const failed = [fin, approved, trusted, local, latest].every((r) => r.status === 'rejected');
  if (dot) dot.className = 'status-dot ' + (failed ? 'err' : 'ok');
  if (st) st.textContent = failed ? 'Unavailable' : `${state.newsCache.length} stories · ${timeHM()}`;
  setBusy(btn, false);
  emit('news');
  return state.newsCache;
}

/* ---------- rendering ---------- */

function renderHero() {
  const c = state.newsCache;
  const count = (fn) => c.filter(fn).length;
  $('#newsHero').innerHTML = `
    <div class="card"><div class="label">Your holdings</div><div class="value t-gold">${count((x) => x.inPort)}</div><div class="hint">related stories</div></div>
    <div class="card"><div class="label">Financial filings</div><div class="value">${count((x) => x.kind === 'fin')}</div><div class="hint">CSE disclosures</div></div>
    <div class="card"><div class="label">CSE official</div><div class="value">${count((x) => x.kind === 'cse' || x.kind === 'div')}</div><div class="hint">announcements</div></div>
    <div class="card"><div class="label">Newspapers / media</div><div class="value">${count((x) => [...MEDIA_KINDS, 'si'].includes(x.kind))}</div><div class="hint">external sources</div></div>
    <div class="card"><div class="label">Tone</div><div class="value" style="font-size:16px"><span class="t-pos">${count((x) => sentimentOf(x.title) === 'bull')}↑</span> <span class="t-muted">/</span> <span class="t-neg">${count((x) => sentimentOf(x.title) === 'bear')}↓</span></div><div class="hint">keyword signal</div></div>`;
}

function matchesFilter(it, q) {
  if (filter === 'cse' && it.kind !== 'cse' && it.kind !== 'div') return false;
  if (filter === 'fin' && it.kind !== 'fin') return false;
  if (filter === 'div' && it.kind !== 'div' && !/dividend|xd |x-div|cash div|ලාභාංශ/i.test(it.title)) return false;
  if (filter === 'media' && !MEDIA_KINDS.includes(it.kind)) return false;
  if (filter === 'si' && it.kind !== 'si') return false;
  if (filter === 'portfolio' && !it.inPort) return false;
  if (q && !`${it.title} ${it.source} ${it.symbol} ${it.company}`.toLowerCase().includes(q)) return false;
  return true;
}

function renderList() {
  const q = $('#newsSearch').value.trim().toLowerCase();
  const rows = state.newsCache.filter((it) => matchesFilter(it, q));
  if (!rows.length) {
    $('#newsList').innerHTML = emptyHtml(state.newsCache.length
      ? 'News නෑ මේ filter එකට. Chip change කරන්න.'
      : '<strong>Refresh now</strong> click කරන්න — CSE + English/Sinhala media news load වෙනවා.');
    return;
  }
  $('#newsList').innerHTML = rows.slice(0, 80).map((it) => {
    const sent = sentimentOf(it.title);
    const badge = it.kind === 'fin' ? 'fin' : it.kind === 'cse' || it.kind === 'div' ? 'cse' : 'news';
    const link = esc(safeUrl(it.link));
    return `<article class="news-item">
      <div class="ni-body">
        <a class="title" href="${link}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <div class="news-meta">
          <span class="badge ${badge}">${KIND_LABEL[it.kind] || 'MEDIA'}</span>
          <span class="badge ${sent}">${sent === 'bull' ? 'Bullish' : sent === 'bear' ? 'Bearish' : 'Neutral'}</span>
          ${it.inPort ? '<span class="badge port">YOUR PORTFOLIO</span>' : ''}
          ${it.symbol ? `<b class="t-gold">${esc(it.symbol)}</b>` : ''}
        </div>
        <div class="news-source-row"><span class="src-dot"></span><span>${esc(it.source)}</span></div>
      </div>
      <div class="ni-side">
        <span class="ni-time">${esc(fmtDate(it.pubDate, true))}</span>
        <a class="btn ghost sm" href="${link}" target="_blank" rel="noopener">Open ↗</a>
      </div>
    </article>`;
  }).join('');
}

export function render() {
  renderHero();
  renderList();
}

/* ---------- lifecycle ---------- */

export function init() {
  $('#newsRefreshBtn').addEventListener('click', () => loadNews());
  $('#newsSearch').addEventListener('input', debounce(renderList, 150));
  $('#newsChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.news-chip');
    if (!chip) return;
    $$('.news-chip').forEach((c) => { c.classList.toggle('on', c === chip); c.setAttribute('aria-pressed', String(c === chip)); });
    filter = chip.dataset.nf || 'all';
    renderList();
  });
}

export function show() {
  render();
  if (!state.newsCache.length) loadNews();
  clearInterval(autoTimer);
  autoTimer = setInterval(() => { if (!document.hidden) loadNews(); }, AUTO_MS);
}

export function hide() {
  clearInterval(autoTimer);
}

export default { init, render, show, hide };
