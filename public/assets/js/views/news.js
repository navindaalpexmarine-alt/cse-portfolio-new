/**
 * News view: CSE financial disclosures + official announcements + English and
 * Sinhala local media (via the proxy), merged, de-duplicated and filterable.
 */
import { cse, news } from '../core/api.js';
import { emit, state } from '../core/store.js';
import { go } from '../core/router.js';
import { baseSym } from '../core/finance.js';
import { $, $$, debounce, esc, fmtDate, safeUrl, timeHM } from '../core/utils.js';
import { emptyHtml, setBusy } from '../core/ui.js';

const AUTO_MS = 180000; // 3 min, matches the proxy's CDN cache
const MEDIA_KINDS = ['google', 'en', 'ft', 'dm', 'st', 'is', 'lbo'];
const KIND_LABEL = {
  fin: 'FINANCIAL', div: 'DIVIDEND', cse: 'CSE OFFICIAL', en: 'ECONOMYNEXT', ft: 'DAILY FT', dm: 'DAILY MIRROR',
  st: 'SUNDAY TIMES', is: 'THE ISLAND', lbo: 'LBO', si: 'SINHALA MEDIA', google: 'LOCAL MEDIA',
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
/** Which of your holdings a headline mentions ('' if none). */
const portfolioMatch = (title, syms) => {
  const t = String(title || '').toUpperCase();
  for (const s of syms) if (s.length >= 2 && new RegExp(`\\b${s}\\b`).test(t)) return s;
  return '';
};

/* ---------- "new since your last visit" ---------- */
const SEEN_KEY = 'cse_news_seen_v1';
let seenBefore = 0; // when the user last opened the News tab (0 = first visit → no badges)
let visitMarked = false;
/** Once per page load: remember the previous visit, then record this one. Switching tabs keeps the badges. */
function markVisit() {
  if (visitMarked) return;
  visitMarked = true;
  try {
    seenBefore = Number(localStorage.getItem(SEEN_KEY)) || 0;
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch { seenBefore = 0; }
}
/** Robust date parse ("2026-11-03 10:22:11" also works in Safari). */
const timeOf = (v) => {
  if (v == null || v === '') return 0;
  if (/^\d{13}$/.test(String(v))) return Number(v);
  const t = Date.parse(String(v).trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'));
  return Number.isNaN(t) ? 0 : t;
};
const isNew = (it) => seenBefore > 0 && timeOf(it.pubDate) > seenBefore;

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
        symbol: sym, company: a.name || '', inPort: syms.has(baseSym(sym)), pSym: syms.has(baseSym(sym)) ? baseSym(sym) : '',
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
        symbol: sym, company: a.company || '', inPort: syms.has(baseSym(sym)), pSym: syms.has(baseSym(sym)) ? baseSym(sym) : '',
      });
    });
  }
  for (const r of [trusted, trustedPort, local, latest]) {
    if (r.status !== 'fulfilled') continue;
    (r.value.items || []).forEach((it) => {
      const src = String(it.source || it.source_label || 'Google News').trim();
      items.push({
        title: it.title, link: it.link, pubDate: it.pubDate, source: 'Media · ' + src,
        kind: mediaKind(src, it.title), symbol: '', company: '', ...(() => { const m = portfolioMatch(it.title, syms); return { inPort: !!m, pSym: m }; })(),
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
  }).sort((a, b) => timeOf(b.pubDate) - timeOf(a.pubDate));

  const failed = [fin, approved, trusted, local, latest].every((r) => r.status === 'rejected');
  if (dot) dot.className = 'status-dot ' + (failed ? 'err' : 'ok');
  const fresh = state.newsCache.filter(isNew).length;
  if (st) st.textContent = failed ? 'Unavailable' : `${state.newsCache.length} stories${fresh ? ` · ${fresh} new` : ''} · ${timeHM()}`;
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

/** "Your shares" box: the last 2 days of news about your holdings, grouped by share. */
function renderMine() {
  const box = $('#newsMine');
  if (!box) return;
  const syms = portSymbols();
  if (!syms.size) { box.hidden = true; return; }
  box.hidden = false;
  const since = Date.now() - 2 * 86400000;
  const groups = new Map();
  for (const it of state.newsCache) {
    if (!it.inPort || timeOf(it.pubDate) < since) continue;
    const key = it.pSym || baseSym(it.symbol);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const head = `<div class="panel-head"><h2>📌 Your shares · last 2 days</h2>${state.newsCache.length ? `<span class="chip">${groups.size} of ${syms.size} shares in the news</span>` : ''}</div>`;
  if (!state.newsCache.length) { box.innerHTML = head + emptyHtml('Loading…', true); return; }
  if (!groups.size) { box.innerHTML = head + emptyHtml('No news about your shares in the last 2 days.', true); return; }
  const fullSym = (b) => state.holdings.find((h) => baseSym(h.name) === b)?.name || b;
  box.innerHTML = head + `<div class="mine-groups">${[...groups.entries()].slice(0, 8).map(([sym, list]) => `
    <div class="mine-group">
      <button type="button" class="mine-sym" data-fund="${esc(fullSym(sym))}" title="Open ${esc(sym)} in Fundamentals">${esc(sym)} <span>→</span></button>
      <ul>${list.slice(0, 3).map((it) => `<li>
        ${isNew(it) ? '<span class="badge new">NEW</span>' : ''}
        <a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <span class="ni-time">${esc(fmtDate(it.pubDate, true))}</span></li>`).join('')}
        ${list.length > 3 ? `<li class="t-muted">+${list.length - 3} more — use the “My holdings” filter</li>` : ''}
      </ul>
    </div>`).join('')}</div>`;
}

function matchesFilter(it, q) {
  if (filter === 'new' && !isNew(it)) return false;
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
      ? (filter === 'new' ? (seenBefore ? 'Nothing new since your last visit.' : 'NEW badges start from your next visit.') : 'No news for this filter. Try another chip.')
      : 'Click <strong>Refresh now</strong> — CSE + English/Sinhala media news will load.');
    return;
  }
  $('#newsList').innerHTML = rows.slice(0, 80).map((it) => {
    const sent = sentimentOf(it.title);
    const badge = it.kind === 'fin' ? 'fin' : it.kind === 'cse' || it.kind === 'div' ? 'cse' : 'news';
    const link = esc(safeUrl(it.link));
    return `<article class="news-item${isNew(it) ? ' is-new' : ''}">
      <div class="ni-body">
        <a class="title" href="${link}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <div class="news-meta">
          <span class="badge ${badge}">${KIND_LABEL[it.kind] || 'MEDIA'}</span>
          <span class="badge ${sent}">${sent === 'bull' ? 'Bullish' : sent === 'bear' ? 'Bearish' : 'Neutral'}</span>
          ${isNew(it) ? '<span class="badge new">NEW</span>' : ''}
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
  renderMine();
  renderList();
}

/* ---------- lifecycle ---------- */

export function init() {
  $('#newsRefreshBtn').addEventListener('click', () => loadNews());
  $('#newsSearch').addEventListener('input', debounce(renderList, 150));
  $('#newsMine')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fund]');
    if (b) go('fund', { sym: b.dataset.fund });
  });
  $('#newsChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.news-chip');
    if (!chip) return;
    $$('.news-chip').forEach((c) => { c.classList.toggle('on', c === chip); c.setAttribute('aria-pressed', String(c === chip)); });
    filter = chip.dataset.nf || 'all';
    renderList();
  });
}

export function show() {
  markVisit();
  render();
  if (!state.newsCache.length) loadNews();
  clearInterval(autoTimer);
  autoTimer = setInterval(() => { if (!document.hidden) loadNews(); }, AUTO_MS);
}

export function hide() {
  clearInterval(autoTimer);
}

export default { init, render, show, hide };
