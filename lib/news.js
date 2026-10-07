/**
 * Sri Lankan market news aggregator (English + Sinhala media) via Google News RSS.
 *
 * Replaces the `/api/news/*` routes of the original portfolio_server.py:
 *   kind=google   – one free-text query
 *   kind=trusted  – fan-out over trusted local publications (+ optional extra query)
 *   kind=company  – symbol / company-name search across local media
 */
import { errorResult, fetchWithTimeout, json, runHandler } from './http.js';

const RSS_TIMEOUT_MS = 8000; // every fan-out finishes inside Netlify's 10 s limit
const NEWS_TTL = 180;        // CDN cache: 3 minutes (matches the UI auto-refresh)

/* Trusted SL finance / market queries – English + Sinhala local media. */
export const TRUSTED_QUERIES = [
  // English
  ['EconomyNext', 'site:economynext.com (CSE OR ASPI OR stock OR shares OR dividend OR market)'],
  ['Daily FT', 'site:ft.lk (CSE OR ASPI OR stock OR shares OR dividend OR bourse OR equities)'],
  ['Daily Mirror', 'site:dailymirror.lk (CSE OR ASPI OR "stock market" OR shares OR dividend)'],
  ['Sunday Times', 'site:sundaytimes.lk (CSE OR ASPI OR "stock market" OR shares OR dividend OR bourse)'],
  ['LBO', 'site:lankabusinessonline.com (CSE OR ASPI OR stock OR shares OR dividend)'],
  ['The Island', 'site:island.lk (CSE OR ASPI OR "stock market" OR shares OR dividend)'],
  // Sinhala / bilingual local
  ['Ada Derana', 'site:adaderana.lk (කොළඹ කොටස් OR CSE OR ASPI OR ආයෝජන OR ලාභාංශ OR කොටස් වෙළෙඳපොළ)'],
  ['Hiru News', 'site:hirunews.lk (කොළඹ කොටස් OR CSE OR ASPI OR ආයෝජන OR ලාභාංශ)'],
  ['News First', 'site:newsfirst.lk (කොළඹ කොටස් OR CSE OR ASPI OR ආයෝජන OR ලාභාංශ OR කොටස්)'],
  ['Lankadeepa', 'site:lankadeepa.lk (කොළඹ කොටස් OR CSE OR ASPI OR ආයෝජන OR ලාභාංශ)'],
  ['Dinamina', 'site:dinamina.lk (කොළඹ කොටස් OR CSE OR ASPI OR ආයෝජන OR ලාභාංශ)'],
  ['Mawbima', 'site:mawbima.lk (කොළඹ කොටස් OR CSE OR ASPI OR ආයෝජන)'],
];

export const LOCAL_SITES =
  '(site:economynext.com OR site:ft.lk OR site:dailymirror.lk OR site:sundaytimes.lk ' +
  'OR site:lankabusinessonline.com OR site:island.lk OR site:adaderana.lk OR site:hirunews.lk ' +
  'OR site:newsfirst.lk OR site:lankadeepa.lk OR site:dinamina.lk OR site:mawbima.lk)';

/* ---------- tiny dependency-free RSS parser ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1]) : '';
}

/** Parses Google News RSS XML into [{title, link, pubDate, source}]. */
export function parseRss(xml, limit = 20) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const block = m[1];
    const title = tag(block, 'title');
    const link = tag(block, 'link');
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({
      title,
      link,
      pubDate: tag(block, 'pubDate'),
      source: tag(block, 'source'),
      kind: 'google',
    });
  }
  return items;
}

/* ---------- fetching ---------- */

export async function fetchGoogleNews(query, limit = 20) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) +
    '&hl=en-LK&gl=LK&ceid=LK:en';
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (CSEPortfolio/3.0)' },
  }, RSS_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Google News responded ${res.status}`);
  return parseRss(await res.text(), limit);
}

function dedupeAndSort(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.title || '').trim().toLowerCase().slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  out.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
  return out;
}

/** Fetches every trusted query in parallel; individual failures are skipped. */
export async function fetchTrusted(extraQuery = '', limitPer = 12) {
  const queries = [...TRUSTED_QUERIES];
  if (extraQuery.trim()) queries.unshift(['Portfolio local', `(${extraQuery.trim()}) ${LOCAL_SITES}`]);

  const settled = await Promise.allSettled(
    queries.map(async ([label, q]) => {
      const items = await fetchGoogleNews(q, limitPer);
      return items.map((it) => ({ ...it, source_label: label, source: it.source || label }));
    }),
  );
  const all = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[news] ${queries[i][0]} failed:`, r.reason?.message || r.reason);
  });
  return dedupeAndSort(all);
}

/* ---------- input sanitising ---------- */

const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
// Strip control characters and cap length; Google treats the rest as text.
const cleanText = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/* ---------- main entry ---------- */

export function handleNews(method, params) {
  return runHandler(method, params, async (p) => {
    const kind = String(p.kind || '');
    try {
      if (kind === 'google') {
        const q = cleanText(p.q, 600) || 'Colombo Stock Exchange OR CSE Sri Lanka';
        const items = await fetchGoogleNews(q, clampInt(p.limit, 30, 1, 50));
        return json(200, { items, query: q }, NEWS_TTL);
      }
      if (kind === 'trusted') {
        const items = await fetchTrusted(cleanText(p.q, 400), clampInt(p.limit, 10, 1, 15));
        return json(200, { items, sources: TRUSTED_QUERIES.map((x) => x[0]) }, NEWS_TTL);
      }
      if (kind === 'company') {
        const symbol = cleanText(p.symbol, 20).toUpperCase().replace(/[^A-Z0-9.]/g, '');
        const name = cleanText(p.name, 120).replace(/"/g, '');
        const parts = [];
        if (symbol) parts.push(symbol.split('.')[0]);
        if (name) parts.push(`"${name}"`);
        if (!parts.length) parts.push('CSE');
        const q = `(${parts.join(' OR ')} (stock OR shares OR dividend OR CSE OR ලාභාංශ OR කොටස්)) ${LOCAL_SITES}`;
        const items = await fetchGoogleNews(q, clampInt(p.limit, 15, 1, 30));
        return json(200, { items, symbol, query: q }, NEWS_TTL);
      }
      return errorResult(400, 'bad_request', 'kind must be google | trusted | company');
    } catch (err) {
      console.warn(`[news] ${kind} failed:`, err?.message || err);
      return errorResult(502, 'news_failed', err?.message || err);
    }
  });
}
