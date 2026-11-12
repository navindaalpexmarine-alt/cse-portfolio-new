/**
 * Daily market close archive: public, crawlable pages at /market and /market/YYYY-MM-DD.
 *
 *  - The daily cron (lib/digest.js run) calls saveDay() once per trading day after the close.
 *  - Pages are rendered on the server (plain HTML, no JS needed) and cached at the CDN edge.
 *  - The site owner can add a short written note for any day from the Users page.
 *
 * Redis keys:
 *   mkt:day:<YYYY-MM-DD>   JSON snapshot of the session
 *   mkt:days               sorted set of stored days (score = YYYYMMDD)
 *   mkt:note:<YYYY-MM-DD>  owner's note (plain text)
 *
 * Information only — the narrative states what happened; it never recommends buying or selling.
 */
import { getDb } from './db.js';
import { ApiFail, isAdmin, requireUser, runPrivate } from './auth.js';
import { privateJson } from './http.js';

const SITE = () => (process.env.DIGEST_SITE_URL || 'https://cse-portfolio-new.vercel.app').replace(/\/+$/, '');
const WA_CHANNEL = 'https://whatsapp.com/channel/0029Vb9Fn5V5kg7CmUkexe2t';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTE = 2000;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v) => n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pts = (v) => Math.abs(n(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => `${n(v) >= 0 ? '+' : '−'}${Math.abs(n(v)).toFixed(2)}%`;
const money = (v) => (n(v) >= 1e9 ? `Rs ${(n(v) / 1e9).toFixed(2)} billion` : n(v) >= 1e6 ? `Rs ${(n(v) / 1e6).toFixed(1)} million` : `Rs ${Math.round(n(v)).toLocaleString('en-US')}`);
const baseSym = (s) => String(s || '').split('.')[0].toUpperCase().trim();
const score = (day) => Number(day.replace(/-/g, ''));
const dateOf = (day) => new Date(`${day}T00:00:00Z`);
const longDate = (day) => dateOf(day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDate = (day) => dateOf(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const ymd = (d) => d.toISOString().slice(0, 10);

/* --------------------------------------------------------------- storage */

/** Pure: market object (lib/digest.js buildMarket) -> compact snapshot worth keeping. */
export function snapshot(market, day) {
  const slim = (t) => ({ symbol: baseSym(t.symbol), name: t.name || '', price: n(t.price), pct: n(t.pct), turnover: n(t.turnover) });
  const all = Object.values(market.prices || {});
  const traded = all.filter((t) => n(t.turnover) > 0);
  const active = [...traded].sort((a, b) => n(b.turnover) - n(a.turnover)).slice(0, 5).map(slim);
  const start = dateOf(day).getTime();
  const xd = (market.dividends || [])
    .map((d) => {
      const x = d.xd instanceof Date ? d.xd : new Date(d.xd);
      const xdDay = ymd(new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())));
      return { symbol: baseSym(d.symbol), dps: n(d.dps), xd: xdDay };
    })
    .filter((d) => { const t = dateOf(d.xd).getTime(); return t > start && t <= start + 14 * 86400_000; })
    .sort((a, b) => a.xd.localeCompare(b.xd))
    .slice(0, 8);
  return {
    day,
    aspi: market.aspi ? { value: n(market.aspi.value), change: n(market.aspi.change), pct: n(market.aspi.pct) } : null,
    snp: market.snp ? { value: n(market.snp.value), change: n(market.snp.change), pct: n(market.snp.pct) } : null,
    turnover: market.turnover ?? null,
    trades: market.trades ?? null,
    advancing: n(market.advancing),
    declining: n(market.declining),
    unchanged: traded.filter((t) => n(t.pct) === 0).length,
    gainers: (market.gainers || []).slice(0, 5).map(slim),
    losers: (market.losers || []).slice(0, 5).map(slim),
    active,
    xd,
    savedAt: Date.now(),
  };
}

export async function saveDay(day, market, db = getDb()) {
  if (!DAY_RE.test(day) || !market?.aspi) return false;
  await db.set(`mkt:day:${day}`, JSON.stringify(snapshot(market, day)));
  await db.zadd('mkt:days', score(day), day);
  return true;
}

async function loadDay(db, day) {
  const raw = await db.get(`mkt:day:${day}`);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

async function allDays(db) {
  return (await db.zrangebyscore('mkt:days', 0, 99999999)).filter((d) => DAY_RE.test(d));
}

/* ------------------------------------------------------------- narrative */

const who = (t) => (t.name ? `${esc(t.name)} (${esc(t.symbol)})` : esc(t.symbol));
const listJoin = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/**
 * Pure: snapshot (+ earlier snapshots, oldest first) -> paragraphs of plain-English HTML.
 * States facts and comparisons only. No opinions, no forecasts, no recommendations.
 */
export function narrate(s, history = []) {
  const prev = history.length ? history[history.length - 1] : null;
  const out = [];
  const a = s.aspi;
  if (a) {
    const dir = a.change > 0 ? 'up' : a.change < 0 ? 'down' : 'unchanged';
    let p = `The All Share Price Index (ASPI) closed at <b>${num(a.value)}</b> on ${longDate(s.day)}`;
    p += dir === 'unchanged' ? ', unchanged from the previous session.' : `, ${dir} ${pts(a.change)} points or <b>${pct(a.pct)}</b> from the previous session.`;
    if (s.snp) {
      const same = Math.sign(s.snp.change) === Math.sign(a.change);
      p += ` The S&amp;P Sri Lanka 20, which tracks 20 of the largest and most traded companies, ${s.snp.change >= 0 ? 'gained' : 'lost'} ${pct(s.snp.pct).replace(/^[+−]/, '')} to ${num(s.snp.value)}`;
      p += same || a.change === 0 ? '.' : ', moving the other way from the broader market.';
    }
    out.push(p);
  }
  // Week so far: earliest stored session of the same Monday-based week.
  if (a) {
    const d = dateOf(s.day);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400_000);
    const lastWeek = [...history].reverse().find((h) => dateOf(h.day) < monday && h.aspi);
    if (lastWeek) {
      const wk = ((a.value - lastWeek.aspi.value) / lastWeek.aspi.value) * 100;
      out.push(`Compared with the close on ${shortDate(lastWeek.day)} (the last session of the previous week), the ASPI is ${wk >= 0 ? 'up' : 'down'} <b>${pct(wk).replace(/^[+−]/, '')}</b> for the week so far.`);
    }
  }
  if (s.turnover != null) {
    let p = `Market turnover was <b>${money(s.turnover)}</b>`;
    if (s.trades != null) p += ` across ${n(s.trades).toLocaleString('en-US')} trades`;
    if (prev?.turnover) {
      const ch = ((s.turnover - prev.turnover) / prev.turnover) * 100;
      if (Math.abs(ch) >= 5) p += `, about ${Math.round(Math.abs(ch))}% ${ch > 0 ? 'higher' : 'lower'} than the ${money(prev.turnover)} traded on ${shortDate(prev.day)}`;
      else p += `, close to the previous session's ${money(prev.turnover)}`;
    }
    out.push(`${p}.`);
  }
  if (s.advancing || s.declining) {
    const tone = s.advancing > s.declining * 1.3 ? 'positive' : s.declining > s.advancing * 1.3 ? 'negative' : 'mixed';
    out.push(`Market breadth was ${tone}: <b>${s.advancing}</b> shares closed higher, <b>${s.declining}</b> closed lower${s.unchanged ? ` and ${s.unchanged} were unchanged` : ''}.`);
  }
  if (s.gainers.length) {
    const [g, ...rest] = s.gainers;
    let p = `${who(g)} led the gainers, rising <b>${pct(g.pct)}</b> to Rs ${num(g.price)}`;
    if (rest.length) p += `, followed by ${listJoin(rest.slice(0, 3).map((t) => `${esc(t.symbol)} (${pct(t.pct)})`))}`;
    out.push(`${p}.`);
  }
  if (s.losers.length) {
    const [l, ...rest] = s.losers;
    let p = `On the downside, ${who(l)} fell <b>${pct(l.pct).replace('−', '')}</b> to Rs ${num(l.price)}`;
    if (rest.length) p += `, while ${listJoin(rest.slice(0, 3).map((t) => `${esc(t.symbol)} (${pct(t.pct)})`))} also declined`;
    out.push(`${p}.`);
  }
  if (s.active.length && s.turnover) {
    const t = s.active[0];
    const share = (t.turnover / s.turnover) * 100;
    out.push(`By value traded, the most active share was ${who(t)} with ${money(t.turnover)}${share >= 1 ? `, about ${Math.round(share)}% of the day's turnover` : ''}, closing at Rs ${num(t.price)} (${pct(t.pct)}).`);
  }
  if (s.xd.length) {
    out.push(`Coming up: ${listJoin(s.xd.slice(0, 4).map((x) => `${esc(x.symbol)} goes ex-dividend on ${shortDate(x.xd)}${x.dps ? ` (Rs ${num(x.dps)} per share)` : ''}`))}. Shares bought on or after the XD date do not receive that dividend.`);
  }
  return out;
}

/* ----------------------------------------------------------------- pages */

function shell({ title, description, canonical, body, jsonLd }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${esc(canonical)}">
<meta name="theme-color" content="#0B0F14">
<link rel="icon" href="/assets/icons/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/assets/css/styles.css">
<link rel="stylesheet" href="/assets/css/legal.css">
<script src="/assets/js/theme-init.js"></script>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
<style>
.mkt-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.mkt-card{background:var(--panel-2,rgba(255,255,255,.03));border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.mkt-card .k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.mkt-card .v{font-size:20px;font-weight:700;margin-top:4px}
.up{color:var(--pos,#2ECC9A)} .down{color:var(--neg,#E85D5D)}
.mkt-table{width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:15px}
.mkt-table th,.mkt-table td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left}
.mkt-table td.r,.mkt-table th.r{text-align:right;font-variant-numeric:tabular-nums}
.mkt-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
.mkt-nav{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:22px}
.mkt-note{border-left:3px solid var(--gold,#D4AF37);padding:4px 0 4px 14px;margin:16px 0}
.mkt-cta{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 6px}
.mkt-cta a{display:inline-block;padding:10px 16px;border-radius:12px;border:1px solid var(--line);text-decoration:none;font-weight:600}
.mkt-cta a.wa{background:#25D366;border-color:#25D366;color:#0B0F14}
</style>
</head>
<body class="legal-page">
<a class="skip-link" href="#main">Skip to content</a>
<header class="legal-header">
  <div class="wrap legal-header-inner">
    <a class="brand" href="/">
      <img src="/assets/icons/icon-192.png" width="36" height="36" alt="" class="brand-icon">
      <span><span class="brand-title">CSE Portfolio</span><span class="brand-sub">Market close</span></span>
    </a>
    <nav class="legal-nav" aria-label="Site pages">
      <a href="/">App</a>
      <a href="/market">Market close</a>
      <a href="/guides/">Guides</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </nav>
  </div>
</header>
<main id="main" class="wrap legal-main">
<article class="legal-card prose">
${body}
</article>
</main>
<footer class="app-footer">
  <div class="wrap">
    <p><b>For information only, not investment advice.</b> Figures come from public Colombo Stock Exchange data at the close and may be revised. Always confirm with the CSE and your broker. This site is not affiliated with the Colombo Stock Exchange.</p>
    <p class="footer-links">
      <a href="/">App</a> · <a href="/market">Market close</a> · <a href="/guides/">Guides</a> ·
      <a href="${WA_CHANNEL}" target="_blank" rel="noopener">WhatsApp channel</a> ·
      <a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a> · <a href="/terms">Terms</a>
    </p>
  </div>
</footer>
</body>
</html>`;
}

const cls = (v) => (n(v) > 0 ? 'up' : n(v) < 0 ? 'down' : '');
function moverTable(rows, valueCol = 'pct') {
  if (!rows.length) return '<p>No data for this session.</p>';
  return `<table class="mkt-table"><thead><tr><th>Share</th><th class="r">Close (Rs)</th><th class="r">${valueCol === 'pct' ? 'Change' : 'Value traded'}</th></tr></thead><tbody>${
    rows.map((t) => `<tr><td><b>${esc(t.symbol)}</b>${t.name ? `<br><small>${esc(t.name)}</small>` : ''}</td><td class="r">${num(t.price)}</td><td class="r ${valueCol === 'pct' ? cls(t.pct) : ''}">${valueCol === 'pct' ? pct(t.pct) : money(t.turnover)}</td></tr>`).join('')
  }</tbody></table>`;
}

export function renderDay(s, { history = [], note = '', prevDay = null, nextDay = null } = {}) {
  const site = SITE();
  const paras = narrate(s, history);
  const a = s.aspi;
  const title = `CSE market close, ${shortDate(s.day)}: ASPI ${a ? `${num(a.value)} (${pct(a.pct)})` : ''}`;
  const desc = `Colombo Stock Exchange summary for ${longDate(s.day)}: ASPI ${a ? `${num(a.value)} ${pct(a.pct)}` : ''}, turnover ${s.turnover != null ? money(s.turnover) : 'n/a'}, top gainers and losers, most traded shares and coming XD dates.`;
  const card = (k, v, extra = '', c = '') => `<div class="mkt-card"><div class="k">${k}</div><div class="v ${c}">${v}</div>${extra ? `<div class="hint">${extra}</div>` : ''}</div>`;
  const body = `
  <p><a href="/market">← All market close summaries</a></p>
  <h1>Market close: ${esc(longDate(s.day))}</h1>
  <p class="lead">${paras[0] || 'Summary of the trading session on the Colombo Stock Exchange.'}</p>
  <div class="mkt-cards">
    ${a ? card('ASPI', num(a.value), `${a.change >= 0 ? '+' : '−'}${pts(a.change)} pts · <span class="${cls(a.pct)}">${pct(a.pct)}</span>`) : ''}
    ${s.snp ? card('S&amp;P SL20', num(s.snp.value), `<span class="${cls(s.snp.pct)}">${pct(s.snp.pct)}</span>`) : ''}
    ${s.turnover != null ? card('Turnover', money(s.turnover).replace(' billion', ' bn').replace(' million', ' mn'), s.trades != null ? `${n(s.trades).toLocaleString('en-US')} trades` : '') : ''}
    ${card('Up / down', `<span class="up">${s.advancing}</span> / <span class="down">${s.declining}</span>`, s.unchanged ? `${s.unchanged} unchanged` : '')}
  </div>
  ${note ? `<h2>Note from the editor</h2><div class="mkt-note">${esc(note).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').concat('</p>')}</div>` : ''}
  <h2>How the session went</h2>
  ${paras.slice(1).map((p) => `<p>${p}</p>`).join('\n  ')}
  <div class="mkt-two">
    <section><h2>Top gainers</h2>${moverTable(s.gainers)}</section>
    <section><h2>Top losers</h2>${moverTable(s.losers)}</section>
  </div>
  <h2>Most traded by value</h2>
  ${moverTable(s.active, 'turnover')}
  ${s.xd.length ? `<h2>Coming XD dates</h2><table class="mkt-table"><thead><tr><th>Share</th><th>XD date</th><th class="r">Dividend per share</th></tr></thead><tbody>${s.xd.map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td>${shortDate(x.xd)}</td><td class="r">${x.dps ? `Rs ${num(x.dps)}` : '—'}</td></tr>`).join('')}</tbody></table>
  <p>New to dividends? Read <a href="/guides/cse-dividends-basics">how CSE dividends and XD dates work</a>.</p>` : ''}
  <h2>Reading these numbers</h2>
  <p>The ASPI covers every listed company, so a few large companies can move it on their own. The S&amp;P SL20 follows only 20 big, liquid companies. Turnover is the total rupee value of shares traded in the session. See <a href="/guides/aspi-and-sp-sl20">ASPI vs S&amp;P SL20 explained</a> and <a href="/guides/cse-market-hours-settlement">CSE market hours and settlement</a> for more.</p>
  <div class="mkt-cta">
    <a href="/">Track your own shares free</a>
    <a class="wa" href="${WA_CHANNEL}" target="_blank" rel="noopener">Get this summary on WhatsApp</a>
  </div>
  <nav class="mkt-nav" aria-label="Other days">
    <span>${prevDay ? `<a href="/market/${prevDay}">← ${shortDate(prevDay)}</a>` : ''}</span>
    <span>${nextDay ? `<a href="/market/${nextDay}">${shortDate(nextDay)} →</a>` : ''}</span>
  </nav>
  <p class="legal-updated">Data saved after the close on ${shortDate(s.day)}. Prices are closing prices from the CSE trade summary.</p>`;
  return shell({
    title, description: desc, canonical: `${site}/market/${s.day}`, body,
    jsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: title, datePublished: s.day, dateModified: s.day, description: desc, mainEntityOfPage: `${site}/market/${s.day}`, author: { '@type': 'Organization', name: 'CSE Portfolio' }, publisher: { '@type': 'Organization', name: 'CSE Portfolio' } },
  });
}

export function renderIndex(rows) {
  const site = SITE();
  const latest = rows[0];
  const body = `
  <h1>CSE market close summaries</h1>
  <p class="lead">A short, plain-English record of every trading day on the Colombo Stock Exchange: where the ASPI and S&amp;P SL20 closed, how much was traded, which shares moved most and which dividends are coming up.</p>
  <p>Each summary is saved automatically after the market closes at 2:30 pm Sri Lanka time, from the CSE's public end-of-day data. Use the archive to look back at a particular day, compare sessions, or see how the market reacted to news. For what each figure means, start with <a href="/guides/aspi-and-sp-sl20">ASPI vs S&amp;P SL20 explained</a>.</p>
  ${latest ? `<p><a href="/market/${latest.day}"><b>Latest: ${esc(longDate(latest.day))} →</b></a></p>` : '<p>The first summary appears after the next trading session closes.</p>'}
  ${rows.length ? `<table class="mkt-table"><thead><tr><th>Date</th><th class="r">ASPI</th><th class="r">Change</th><th class="r">Turnover</th></tr></thead><tbody>${
    rows.map((r) => `<tr><td><a href="/market/${r.day}">${esc(shortDate(r.day))}</a></td><td class="r">${r.aspi ? num(r.aspi.value) : '—'}</td><td class="r ${cls(r.aspi?.pct)}">${r.aspi ? pct(r.aspi.pct) : '—'}</td><td class="r">${r.turnover != null ? money(r.turnover).replace(' billion', ' bn').replace(' million', ' mn') : '—'}</td></tr>`).join('')
  }</tbody></table>` : ''}
  <div class="mkt-cta">
    <a href="/">Track your own shares free</a>
    <a class="wa" href="${WA_CHANNEL}" target="_blank" rel="noopener">Get the daily summary on WhatsApp</a>
  </div>`;
  return shell({ title: 'CSE market close summaries · daily ASPI, turnover, gainers and losers', description: 'Daily Colombo Stock Exchange market close summaries: ASPI and S&P SL20 closes, turnover, top gainers and losers, most traded shares and coming XD dates.', canonical: `${site}/market`, body });
}

export function renderSitemap(days) {
  const site = SITE();
  const urls = [`<url><loc>${site}/market</loc><changefreq>daily</changefreq></url>`, ...days.map((d) => `<url><loc>${site}/market/${d}</loc><lastmod>${d}</lastmod></url>`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/* -------------------------------------------------------------- handlers */

const html = (status, body, ttl = 600) => ({ status, body, ttl, contentType: 'text/html; charset=utf-8' });

function notFound() {
  return html(404, shell({ title: 'No summary for this date · CSE Portfolio', description: 'No market close summary for this date.', canonical: `${SITE()}/market`,
    body: '<h1>No summary for this date</h1><p>The market may have been closed that day (weekend or holiday), or the summary was not saved. <a href="/market">See all market close summaries</a>.</p>' }), 300);
}

async function page(params) {
  const db = getDb();
  const days = await allDays(db);
  if (params.action === 'sitemap') return { status: 200, body: renderSitemap(days), ttl: 3600, contentType: 'application/xml; charset=utf-8' };
  if (!params.day) {
    const recent = days.slice(-120).reverse();
    const rows = (await Promise.all(recent.map((d) => loadDay(db, d)))).filter(Boolean);
    return html(200, renderIndex(rows));
  }
  const day = String(params.day);
  if (!DAY_RE.test(day)) return notFound();
  const s = await loadDay(db, day);
  if (!s) return notFound();
  const i = days.indexOf(day);
  const before = i > 0 ? days.slice(Math.max(0, i - 6), i) : [];
  const history = (await Promise.all(before.map((d) => loadDay(db, d)))).filter(Boolean);
  const note = (await db.get(`mkt:note:${day}`)) || '';
  return html(200, renderDay(s, { history, note: String(note), prevDay: i > 0 ? days[i - 1] : null, nextDay: i >= 0 && i < days.length - 1 ? days[i + 1] : null }));
}

/** Owner: read/save the note shown on a day's page. */
async function note(req) {
  const user = await requireUser(req);
  if (!isAdmin(user)) throw new ApiFail(403, 'forbidden', 'Only the site owner can do this.');
  const db = getDb();
  const days = await allDays(db);
  const day = String(req.body?.day || req.params?.day || days[days.length - 1] || '');
  if (!DAY_RE.test(day)) throw new ApiFail(400, 'bad_day', 'No saved market day yet.');
  if (req.method === 'GET') return privateJson(200, { ok: true, day, note: (await db.get(`mkt:note:${day}`)) || '', saved: days.includes(day) });
  const text = String(req.body?.note ?? '').trim().slice(0, MAX_NOTE);
  if (text) await db.set(`mkt:note:${day}`, text); else await db.del(`mkt:note:${day}`);
  return privateJson(200, { ok: true, day, note: text });
}

/** Entry: /api/market?day=YYYY-MM-DD | (none = index) | action=sitemap | action=note (owner) */
export async function handleMarket(req) {
  const params = { ...(req.params || {}) };
  // Vercel rewrites may hand us the original path (/market/2026-11-11) instead of the query.
  const path = String(req.path || "");
  const m = path.match(/\/market\/(\d{4}-\d{2}-\d{2})\/?$/);
  if (!params.day && m) params.day = m[1];
  if (/market-sitemap\.xml$/.test(path)) params.action = "sitemap";
  if (params.action === 'note') return runPrivate(req, ['GET', 'POST'], () => note(req));
  if (req.method !== 'GET' && req.method !== 'HEAD') return html(405, 'Method not allowed', 0);
  try {
    return await page(params);
  } catch (err) {
    console.warn('[market] page failed:', err?.message || err);
    return html(503, shell({ title: 'Market summaries unavailable · CSE Portfolio', description: 'Temporarily unavailable.', canonical: `${SITE()}/market`, body: '<h1>Temporarily unavailable</h1><p>Please try again in a minute.</p>' }), 0);
  }
}
