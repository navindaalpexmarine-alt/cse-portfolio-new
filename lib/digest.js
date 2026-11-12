/**
 * Daily e-mail summary: market wrap + the subscriber's own portfolio.
 *
 *   GET  /api/digest?action=run            Vercel Cron (Mon–Fri after close). Needs
 *                                          `Authorization: Bearer <CRON_SECRET>`.
 *   POST /api/digest?action=test           Signed-in user: send yourself one now.
 *   GET|POST /api/digest?action=unsubscribe&u=<id>&t=<token>   one-click opt-out.
 *
 * Who gets it: every account, unless they turned Settings → "Daily email summary"
 * off or used the unsubscribe link. Opt-outs live in the `digest:off` set (kept in
 * step by PUT /api/data) and in settings.digestOptOut.
 *
 * Sending: Brevo transactional API (free plan: 300 e-mails/day).
 * Env: BREVO_API_KEY, DIGEST_FROM_EMAIL (a sender verified in Brevo), CRON_SECRET,
 *      optional DIGEST_SITE_URL (default https://cse-portfolio-new.vercel.app).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from './db.js';
import { csePost, fetchSmd } from './cse.js';
import { saveDay } from './market.js';
import { ApiFail, allUserIds, isAdmin, loadUserById, requireUser, runPrivate } from './auth.js';
import { DIGEST_ADMIN_OFF, DIGEST_OFF } from './userdata.js';
import { fetchWithTimeout, privateJson } from './http.js';
import { parseDate } from './dates.js';

const SITE = () => (process.env.DIGEST_SITE_URL || 'https://cse-portfolio-new.vercel.app').replace(/\/+$/, '');
const RUN_BUDGET_MS = 50_000;   // function limit is 60 s
const CONCURRENCY = 4;
const DEFAULT_RATE = 1.12;
const DAY = 86_400_000;

/* ------------------------------------------------------------------ helpers */

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const baseSym = (s) => String(s || '').split('.')[0].toUpperCase().trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (v) => `Rs ${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (v) => (n(v) >= 1e9 ? `Rs ${(n(v) / 1e9).toFixed(2)} bn` : n(v) >= 1e6 ? `Rs ${(n(v) / 1e6).toFixed(1)} mn` : money(v));
const pct = (v) => `${n(v) >= 0 ? '+' : '−'}${Math.abs(n(v)).toFixed(2)}%`;
const signed = (v) => `${n(v) >= 0 ? '+' : '−'}${money(Math.abs(n(v)))}`;
const GREEN = '#0E9F6E', RED = '#D93F3F', GOLD = '#B8901F', MUTED = '#6B7280', INK = '#111827';
const tone = (v) => (n(v) >= 0 ? GREEN : RED);

/** Sri Lanka calendar day, e.g. "2026-11-05". */
export const slDay = (t = Date.now()) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
const slLabel = (t = Date.now()) => new Date(t + 5.5 * 3600_000)
  .toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });

function secret() {
  const s = process.env.CRON_SECRET;
  if (!s) throw new ApiFail(503, 'not_configured', 'Daily e-mail is not set up yet (CRON_SECRET missing).');
  return s;
}
export const unsubToken = (userId) => createHmac('sha256', secret()).update(`unsub:${userId}`).digest('base64url').slice(0, 32);
const unsubUrl = (userId) => `${SITE()}/api/digest?action=unsubscribe&u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`;

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ------------------------------------------------------------ market data */

const firstArray = (o) => (Array.isArray(o) ? o : Object.values(o || {}).find(Array.isArray) || []);

/** Everything the e-mails need, fetched once per run. */
export async function loadMarket() {
  const jobs = {
    trade: csePost('tradeSummary'),
    aspi: csePost('aspiData'),
    snp: csePost('snpData'),
    summary: csePost('marketSummery'),
    fin: csePost('getFinancialAnnouncement'),
    approved: csePost('approvedAnnouncement'),
    divs: fetchSmd(),
  };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(Object.values(jobs));
  const r = {};
  settled.forEach((s, i) => {
    const v = s.status === 'fulfilled' ? s.value : null;
    r[keys[i]] = typeof v === 'string' ? JSON.parse(v) : v;
  });
  return buildMarket(r);
}

/** Pure: raw CSE responses -> normalised market object (tested). */
export function buildMarket(r) {
  const list = firstArray(r.trade?.reqTradeSummery ?? r.trade)
    .map((t) => ({
      symbol: String(t.symbol || '').toUpperCase(),
      name: t.name || '',
      price: n(t.price ?? t.lastTradedPrice),
      change: n(t.change),
      pct: n(t.percentageChange ?? t.changePercentage),
      turnover: n(t.turnover),
    }))
    .filter((t) => t.symbol && t.price > 0);
  const prices = Object.fromEntries(list.map((t) => [t.symbol, t]));
  const traded = list.filter((t) => t.turnover > 0);
  const byPct = [...traded].sort((a, b) => b.pct - a.pct);
  const idx = (d) => (d && n(d.value) > 0 ? { value: n(d.value), change: n(d.change), pct: n(d.percentage) } : null);
  const s = r.summary || {};
  const news = [
    ...firstArray(r.fin?.reqFinancialAnnouncemnets ?? r.fin).map((a) => ({
      symbol: String(a.symbol || '').toUpperCase(),
      title: a.fileText || a.name || 'Financial announcement',
      at: parseDate(a.uploadedDate || a.manualDate)?.getTime() || 0,
      link: a.path ? `https://cdn.cse.lk/${String(a.path).replace(/^\/+/, '')}` : 'https://www.cse.lk/',
    })),
    ...firstArray(r.approved?.approvedAnnouncements ?? r.approved).map((a) => ({
      symbol: String(a.symbol || '').toUpperCase(),
      title: [a.company, a.type, a.announcementCategory].filter(Boolean).join(' · ') || 'CSE announcement',
      at: parseDate(a.dateOfAnnouncement || a.createdDate)?.getTime() || 0,
      link: 'https://www.cse.lk/pages/announcements/announcements.component.html',
    })),
  ].filter((a) => a.symbol);
  const dividends = firstArray(r.divs).map((d) => ({
    symbol: String(d.symbol || '').toUpperCase(),
    dps: n(d.votingDivPerShare),
    xd: parseDate(d.xd),
    payment: d.payment || '',
  })).filter((d) => d.symbol && d.xd);
  return {
    prices,
    aspi: idx(r.aspi),
    snp: idx(r.snp),
    turnover: s.tradeVolume != null ? n(s.tradeVolume) : null,
    trades: s.trades != null ? n(s.trades) : null,
    gainers: byPct.filter((t) => t.pct > 0).slice(0, 5),
    losers: byPct.filter((t) => t.pct < 0).reverse().slice(0, 5),
    advancing: traded.filter((t) => t.pct > 0).length,
    declining: traded.filter((t) => t.pct < 0).length,
    news,
    dividends,
  };
}

/* ---------------------------------------------------------- per-user part */

/** Pure: stored portfolio + market -> what this user's e-mail shows (tested). */
export function buildPortfolio(data, market, now = Date.now()) {
  const rate = Number.isFinite(Number(data?.commissionRate)) ? Number(data.commissionRate) : DEFAULT_RATE;
  const holdings = (Array.isArray(data?.holdings) ? data.holdings : []).filter((h) => n(h.balance) > 0);
  const rows = holdings.map((h) => {
    const sym = String(h.name || '').toUpperCase().trim();
    const live = market.prices[sym];
    const price = live?.price || n(h.tradedPrice);
    const qty = n(h.balance);
    const cost = n(h.totalCost) || qty * n(h.avgPrice);
    const mv = qty * price;
    const net = mv * (1 - rate / 100);
    const gl = net - cost;
    const bes = n(h.besPrice) || (n(h.avgPrice) > 0 ? Math.ceil((n(h.avgPrice) / (1 - rate / 100)) * 100) / 100 : 0);
    const status = bes > 0 && price >= bes ? 'SELL' : bes > 0 && price >= bes * 0.99 ? 'NEAR' : '';
    return { sym, base: baseSym(sym), qty, price, mv, cost, gl, glPct: cost ? (gl / cost) * 100 : 0,
      dayChg: live ? qty * live.change : 0, dayPct: live ? live.pct : 0, hasLive: !!live, status };
  }).filter((r) => r.price > 0);

  const t = rows.reduce((a, r) => ({ mv: a.mv + r.mv, cost: a.cost + r.cost, gl: a.gl + r.gl, day: a.day + r.dayChg }), { mv: 0, cost: 0, gl: 0, day: 0 });
  const prevMv = t.mv - t.day;
  const live = rows.filter((r) => r.hasLive);
  const sorted = [...live].sort((a, b) => b.dayPct - a.dayPct);

  const mine = new Set(rows.map((r) => r.base));
  const today = new Date(slDay(now) + 'T00:00:00');
  const xd = market.dividends
    .filter((d) => mine.has(baseSym(d.symbol)))
    .map((d) => {
      const day = new Date(d.xd.getFullYear(), d.xd.getMonth(), d.xd.getDate());
      const days = Math.round((day - today) / DAY);
      const qty = rows.find((r) => r.base === baseSym(d.symbol))?.qty || 0;
      return { base: baseSym(d.symbol), days, date: day, dps: d.dps, expected: d.dps * qty };
    })
    .filter((d) => d.days >= 0 && d.days <= 7)
    .sort((a, b) => a.days - b.days);

  const news = market.news
    .filter((a) => mine.has(baseSym(a.symbol)) && a.at && now - a.at < 36 * 3600_000)
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);

  const watch = (Array.isArray(data?.watchlist) ? data.watchlist : [])
    .map((s) => market.prices[String(s).toUpperCase()])
    .filter(Boolean)
    .slice(0, 10);

  return {
    rows: [...rows].sort((a, b) => b.mv - a.mv),
    total: { ...t, glPct: t.cost ? (t.gl / t.cost) * 100 : 0, dayPct: prevMv > 0 ? (t.day / prevMv) * 100 : 0 },
    best: sorted[0] || null,
    worst: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    signals: rows.filter((r) => r.status),
    xd,
    news,
    watch,
  };
}

/* ---------------------------------------------------------------- e-mail */

const h2 = (t) => `<tr><td style="padding:22px 24px 8px;font:700 13px/1.4 Arial,sans-serif;letter-spacing:.06em;color:${GOLD};text-transform:uppercase">${t}</td></tr>`;
const block = (inner) => `<tr><td style="padding:0 24px">${inner}</td></tr>`;
const table = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font:14px/1.45 Arial,sans-serif;color:${INK}">${rows}</table>`;
const tr = (cells) => `<tr>${cells.map((c, i) => `<td style="padding:7px 0;border-bottom:1px solid #EEF0F3;${i ? 'text-align:right;' : ''}">${c}</td>`).join('')}</tr>`;
const big = (label, value, color) => `<td style="padding:10px 12px;background:#F7F8FA;border-radius:10px;width:50%;vertical-align:top">
  <div style="font:12px/1.3 Arial,sans-serif;color:${MUTED}">${label}</div>
  <div style="font:700 20px/1.3 Arial,sans-serif;color:${color}">${value}</div></td>`;

/** Pure: builds { subject, html, text } (tested). */
export function renderEmail({ name, market, port, unsub, now = Date.now(), wa = '' }) {
  const site = SITE();
  const hasPort = port.rows.length > 0;
  const aspiTxt = market.aspi ? `ASPI ${pct(market.aspi.pct)}` : 'Market wrap';
  const subject = `CSE ${slLabel(now).split(' ').slice(1, 3).join(' ')}: ${aspiTxt}${hasPort ? ` · Your portfolio ${pct(port.total.dayPct)}` : ''}`;

  const parts = [];
  const text = [];
  parts.push(`<tr><td style="padding:24px 24px 6px;background:#0B0F14;border-radius:14px 14px 0 0">
    <div style="font:700 22px/1.2 Georgia,serif;color:#D4AF37">CSE Portfolio</div>
    <div style="font:13px/1.5 Arial,sans-serif;color:#A3ADBF;padding-bottom:16px">Daily summary · ${esc(slLabel(now))}</div></td></tr>`);
  parts.push(`<tr><td style="padding:18px 24px 0;font:15px/1.5 Arial,sans-serif;color:${INK}">Hi ${esc(name || 'there')}, here is how the market and your shares did today.</td></tr>`);
  text.push(`CSE Portfolio · Daily summary · ${slLabel(now)}`, '');

  if (hasPort) {
    const t = port.total;
    parts.push(h2('Your portfolio'));
    parts.push(block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate"><tr>
      ${big('Value', money(t.mv), INK)}${big('Today', `${signed(t.day)} (${pct(t.dayPct)})`, tone(t.day))}</tr><tr>
      ${big('Total P/L (after selling costs)', `${signed(t.gl)} (${pct(t.glPct)})`, tone(t.gl))}${big('Shares', String(port.rows.length), INK)}</tr></table>`));
    const bw = [port.best && `Best today: <b>${esc(port.best.base)}</b> <span style="color:${tone(port.best.dayPct)}">${pct(port.best.dayPct)}</span>`,
      port.worst && `Weakest: <b>${esc(port.worst.base)}</b> <span style="color:${tone(port.worst.dayPct)}">${pct(port.worst.dayPct)}</span>`].filter(Boolean);
    if (bw.length) parts.push(`<tr><td style="padding:8px 24px 0;font:14px/1.5 Arial,sans-serif;color:${INK}">${bw.join(' &nbsp;·&nbsp; ')}</td></tr>`);
    parts.push(block(table(tr(['<b>Share</b>', '<b>Price</b>', '<b>Today</b>', '<b>P/L</b>']) +
      port.rows.slice(0, 15).map((r) => tr([
        `<b>${esc(r.base)}</b>${r.status ? ` <span style="font:700 10px Arial;color:#fff;background:${r.status === 'SELL' ? GREEN : GOLD};border-radius:4px;padding:1px 5px">${r.status}</span>` : ''}`,
        num(r.price),
        `<span style="color:${tone(r.dayPct)}">${pct(r.dayPct)}</span>`,
        `<span style="color:${tone(r.gl)}">${pct(r.glPct)}</span>`,
      ])).join(''))));
    text.push(`YOUR PORTFOLIO: value ${money(t.mv)}, today ${signed(t.day)} (${pct(t.dayPct)}), total P/L ${signed(t.gl)} (${pct(t.glPct)})`);
    port.rows.slice(0, 15).forEach((r) => text.push(`  ${r.base}  ${num(r.price)}  today ${pct(r.dayPct)}  P/L ${pct(r.glPct)}${r.status ? '  ' + r.status : ''}`));
    text.push('');
  } else {
    parts.push(`<tr><td style="padding:12px 24px 0;font:14px/1.5 Arial,sans-serif;color:${MUTED}">Add your shares in the app to see your own portfolio here.</td></tr>`);
  }

  if (port.xd.length) {
    parts.push(h2('Coming XD dates (next 7 days)'));
    parts.push(block(table(port.xd.map((d) => tr([
      `<b>${esc(d.base)}</b>`,
      d.days === 0 ? 'Today' : d.days === 1 ? 'Tomorrow' : d.date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      d.dps ? `Rs ${num(d.dps)}/share` : '',
      d.expected ? `≈ ${money(d.expected)}` : '',
    ])).join(''))));
    parts.push(`<tr><td style="padding:6px 24px 0;font:12px/1.5 Arial,sans-serif;color:${MUTED}">To get the dividend you must hold the shares before the XD date.</td></tr>`);
    text.push('COMING XD DATES:', ...port.xd.map((d) => `  ${d.base}  in ${d.days} day(s)  DPS ${num(d.dps)}`), '');
  }

  if (port.news.length) {
    parts.push(h2('News for your shares'));
    parts.push(block(table(port.news.map((a) => `<tr><td style="padding:7px 0;border-bottom:1px solid #EEF0F3"><b>${esc(baseSym(a.symbol))}</b> · <a href="${esc(a.link)}" style="color:#1D4ED8;text-decoration:none">${esc(a.title)}</a></td></tr>`).join(''))));
    text.push('NEWS FOR YOUR SHARES:', ...port.news.map((a) => `  ${baseSym(a.symbol)}: ${a.title}`), '');
  }

  parts.push(h2('Market today'));
  const idx = [market.aspi && ['ASPI', market.aspi], market.snp && ['S&amp;P SL20', market.snp]].filter(Boolean);
  if (idx.length) {
    parts.push(block(table(idx.map(([k, v]) => tr([`<b>${k}</b>`, num(v.value), `<span style="color:${tone(v.change)}">${v.change >= 0 ? '+' : '−'}${num(Math.abs(v.change))} (${pct(v.pct)})</span>`])).join(''))));
  }
  const stats = [market.turnover != null && `Turnover ${compact(market.turnover)}`, market.trades != null && `${market.trades.toLocaleString('en-US')} trades`,
    (market.advancing || market.declining) && `${market.advancing} up · ${market.declining} down`].filter(Boolean);
  if (stats.length) parts.push(`<tr><td style="padding:8px 24px 0;font:13px/1.5 Arial,sans-serif;color:${MUTED}">${stats.join(' &nbsp;·&nbsp; ')}</td></tr>`);
  const movers = (title, list) => `<td style="width:50%;vertical-align:top;padding:0 6px">
    <div style="font:700 13px Arial,sans-serif;padding:8px 0 4px">${title}</div>
    ${list.map((t) => `<div style="font:13px/1.7 Arial,sans-serif"><b>${esc(baseSym(t.symbol))}</b> ${num(t.price)} <span style="color:${tone(t.pct)}">${pct(t.pct)}</span></div>`).join('') || `<div style="font:13px Arial;color:${MUTED}">—</div>`}</td>`;
  parts.push(block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${movers('Top gainers', market.gainers)}${movers('Top losers', market.losers)}</tr></table>`));
  if (market.aspi) text.push(`MARKET: ASPI ${num(market.aspi.value)} (${pct(market.aspi.pct)})${market.snp ? `, S&P SL20 ${num(market.snp.value)} (${pct(market.snp.pct)})` : ''}`);
  text.push(`Top gainers: ${market.gainers.map((t) => `${baseSym(t.symbol)} ${pct(t.pct)}`).join(', ') || '—'}`);
  text.push(`Top losers: ${market.losers.map((t) => `${baseSym(t.symbol)} ${pct(t.pct)}`).join(', ') || '—'}`, '');

  if (port.watch.length) {
    parts.push(h2('Your watchlist'));
    parts.push(block(table(port.watch.map((t) => tr([`<b>${esc(baseSym(t.symbol))}</b>`, num(t.price), `<span style="color:${tone(t.pct)}">${pct(t.pct)}</span>`])).join(''))));
  }

  parts.push(`<tr><td style="padding:26px 24px 8px" align="center">
    <a href="${site}/" style="display:inline-block;background:#D4AF37;color:#0B0F14;font:700 15px Arial,sans-serif;text-decoration:none;padding:12px 26px;border-radius:999px">Open CSE Portfolio</a></td></tr>`);
  if (wa) {
    parts.push(`<tr><td style="padding:22px 24px 0"><div style="font:700 13px Arial,sans-serif;color:${GOLD};padding-bottom:6px">FOR YOUR WHATSAPP CHANNEL (only you see this) · copy and post</div>
      <pre style="margin:0;padding:14px;background:#F3F4F6;border-radius:10px;white-space:pre-wrap;font:13px/1.55 Arial,sans-serif;color:${INK}">${esc(wa)}</pre></td></tr>`);
    text.push('', '--- For your WhatsApp channel ---', wa, '---', '');
  }
  parts.push(`<tr><td style="padding:6px 24px 0;font:13px/1.6 Arial,sans-serif" align="center">
    Get updates on WhatsApp: <a href="https://whatsapp.com/channel/0029Vb9Fn5V5kg7CmUkexe2t" style="color:#1FAF57;font-weight:700">join CSE Market Watch</a></td></tr>`);
  parts.push(`<tr><td style="padding:14px 24px 24px;font:12px/1.6 Arial,sans-serif;color:${MUTED}" align="center">
    Prices are from the CSE at the time this e-mail was made and may be delayed. This is not investment advice.<br>
    You get this daily summary because you have a CSE Portfolio account. Don’t want it? <a href="${esc(unsub)}" style="color:${MUTED}">Unsubscribe</a> or turn it off in Settings.</td></tr>`);
  text.push(`Open: ${site}/`, 'WhatsApp channel: https://whatsapp.com/channel/0029Vb9Fn5V5kg7CmUkexe2t', 'Not investment advice.', `Unsubscribe: ${unsub}`);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#EEF0F3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF0F3"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:14px">
${parts.join('\n')}
</table></td></tr></table></body></html>`;
  return { subject, html, text: text.join('\n') };
}

/* --------------------------------------------------------------- sending */

function mailConfig() {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.DIGEST_FROM_EMAIL;
  if (!key || !from) throw new ApiFail(503, 'not_configured', 'Daily e-mail is not set up yet (BREVO_API_KEY / DIGEST_FROM_EMAIL missing).');
  return { key, from };
}

async function sendEmail({ to, name, subject, html, text, unsub }) {
  const { key, from } = mailConfig();
  const res = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'CSE Portfolio', email: from },
      to: [{ email: to, ...(name ? { name } : {}) }],
      subject,
      htmlContent: html,
      textContent: text,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
  }, 10_000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function loadDoc(userId) {
  const raw = await getDb().get(`data:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function mailOne(user, doc, market, now) {
  const port = buildPortfolio(doc?.data || {}, market, now);
  const unsub = unsubUrl(user.id);
  const mail = renderEmail({ name: user.name, market, port, unsub, now, wa: isAdmin(user) ? waSummary(market, now) : '' });
  await sendEmail({ to: user.email, name: user.name, ...mail, unsub });
}

/* ------------------------------------------------- WhatsApp channel post */

const WA_CHANNEL = 'https://whatsapp.com/channel/0029Vb9Fn5V5kg7CmUkexe2t';

/** Pure: market -> ready-to-paste WhatsApp channel post (plain text, *bold* = WhatsApp bold). */
export function waSummary(market, now = Date.now()) {
  const d = new Date(now + 5.5 * 3600_000)
    .toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const arrow = (v) => (n(v) >= 0 ? '▲' : '▼');
  const idx = (label, x) => x && `*${label}* ${num(x.value)} ${arrow(x.pct)} ${pct(x.pct)}`;
  const mover = (t) => `• ${baseSym(t.symbol)} ${pct(t.pct)} (Rs ${num(t.price)})`;
  const lines = [`📊 *Market close* · ${d}`, ''];
  const idxLines = [idx('ASPI', market.aspi), idx('S&P SL20', market.snp)].filter(Boolean);
  if (idxLines.length) lines.push(...idxLines, '');
  const stats = [market.turnover != null && `💰 Turnover ${compact(market.turnover)}`, market.trades != null && `${market.trades.toLocaleString('en-US')} trades`].filter(Boolean);
  if (stats.length) lines.push(stats.join(' · '));
  if (market.advancing || market.declining) lines.push(`🟢 ${market.advancing} up · 🔴 ${market.declining} down`);
  if (stats.length || market.advancing || market.declining) lines.push('');
  if (market.gainers.length) lines.push('🔼 *Top gainers*', ...market.gainers.map(mover), '');
  if (market.losers.length) lines.push('🔽 *Top losers*', ...market.losers.map(mover), '');
  const today = new Date(slDay(now) + 'T00:00:00');
  const xd = (market.dividends || [])
    .map((x) => ({ ...x, days: Math.round((new Date(x.xd.getFullYear(), x.xd.getMonth(), x.xd.getDate()) - today) / DAY) }))
    .filter((x) => x.days >= 1 && x.days <= 7)
    .sort((a, b) => a.days - b.days)
    .slice(0, 6);
  if (xd.length) {
    lines.push('📅 *Coming XD dates*', ...xd.map((x) => `• ${baseSym(x.symbol)}${x.dps ? ` Rs ${num(x.dps)}` : ''} · XD ${x.xd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`), '');
  }
  lines.push(`📱 Track your shares free: ${SITE()}/`, '_Prices from the CSE, may be delayed. For information only, not investment advice._');
  return lines.join('\n');
}

/** Owner only: today's channel post, built from live CSE data. */
async function wa(req) {
  const user = await requireUser(req);
  if (!isAdmin(user)) throw new ApiFail(403, 'forbidden', 'Only the site owner can do this.');
  const market = await loadMarket();
  if (!market.aspi) throw new ApiFail(502, 'no_market', 'CSE data is not available right now. Try again in a few minutes.');
  const now = Date.now();
  const sl = new Date(now + 5.5 * 3600_000);
  const mins = sl.getUTCHours() * 60 + sl.getUTCMinutes();
  const wd = sl.getUTCDay();
  // After the close on a weekday, also save today's archive page (unless the market did not trade).
  let archived = false;
  if (wd >= 1 && wd <= 5 && mins >= 870) {
    const db = getDb();
    const day = slDay(now);
    const last = await db.get('digest:lastMarket');
    const stamp = `${market.aspi.value}|${market.turnover}`;
    if (!(last && last.split('#')[0] === stamp && last.split('#')[1] !== day)) {
      archived = await saveDay(day, market, db).catch(() => false);
    }
  }
  return privateJson(200, { ok: true, text: waSummary(market, now), channel: WA_CHANNEL, marketOpen: wd >= 1 && wd <= 5 && mins >= 570 && mins < 870, archived });
}

/* --------------------------------------------------------------- actions */

/** Cron: e-mail every subscriber once per Sri Lanka trading day. */
async function run(req) {
  const auth = String(req.headers.authorization || '');
  if (!safeEq(auth, `Bearer ${secret()}`)) throw new ApiFail(401, 'unauthorized', 'Not allowed.');
  const started = Date.now();
  const db = getDb();
  const day = slDay(started);

  const market = await loadMarket();
  if (!market.aspi) return privateJson(502, { error: 'no_market', message: 'CSE data unavailable — nothing sent.' });
  // Holiday guard: if ASPI and turnover are exactly as at the last run, the market did not trade today.
  const stamp = `${market.aspi.value}|${market.turnover}`;
  const last = await db.get('digest:lastMarket');
  if (last && last.split('#')[0] === stamp && last.split('#')[1] !== day) {
    return privateJson(200, { ok: true, skipped: 'no trading today', day });
  }
  await db.set('digest:lastMarket', `${stamp}#${day}`);
  // Public archive page (/market/<day>) — saved even if e-mail sending is not set up.
  try { await saveDay(day, market, db); } catch (err) { console.warn('[digest] archive save failed:', err?.message || err); }
  mailConfig();

  const off = new Set([...(await db.smembers(DIGEST_OFF)), ...(await db.smembers(DIGEST_ADMIN_OFF))]);
  const ids = (await allUserIds()).filter((id) => !off.has(id));
  const stats = { subscribers: ids.length, sent: 0, skipped: 0, failed: 0, left: 0 };
  let capped = false;
  const queue = [...ids];
  async function worker() {
    while (queue.length) {
      if (capped || Date.now() - started > RUN_BUDGET_MS) { stats.left += queue.length; queue.length = 0; return; }
      const id = queue.shift();
      try {
        const [user, doc] = await Promise.all([loadUserById(id), loadDoc(id)]);
        if (!user) { stats.skipped++; continue; }
        if (doc?.data?.settings?.digestOptOut === true) { await db.sadd(DIGEST_OFF, id); stats.skipped++; continue; }
        // Never e-mail the same person twice in one day, even if cron fires again.
        if (!(await db.set(`digest:sent:${day}:${id}`, '1', { ex: 2 * 86400, nx: true }))) { stats.skipped++; continue; }
        try {
          await mailOne(user, doc, market, started);
          stats.sent++;
        } catch (err) {
          await db.del(`digest:sent:${day}:${id}`);
          throw err;
        }
      } catch (err) {
        stats.failed++;
        // Brevo's daily allowance used up (free plan: 300/day): stop, try the rest tomorrow.
        if (/Brevo (402|429)/.test(String(err?.message))) capped = true;
        console.warn('[digest] send failed:', err?.message || err);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log('[digest]', day, JSON.stringify(stats));
  return privateJson(200, { ok: true, day, ...stats });
}

/** Signed-in user: "Send me a test e-mail" (max 3 a day). */
async function test(req) {
  const user = await requireUser(req);
  mailConfig();
  secret();
  const n = await getDb().incr(`rl:digest-test:${user.id}`, 86400);
  if (n > 3) throw new ApiFail(429, 'rate_limited', 'You can send up to 3 test e-mails a day.');
  const market = await loadMarket();
  try {
    await mailOne(user, await loadDoc(user.id), market, Date.now());
  } catch (err) {
    console.warn('[digest] test failed:', err?.message || err);
    throw new ApiFail(502, 'send_failed', `Could not send the e-mail. ${String(err?.message || err).slice(0, 200)}`);
  }
  return privateJson(200, { ok: true, to: user.email });
}

const page = (title, msg) => ({
  status: 200,
  private: true,
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;font-family:Arial,sans-serif;background:#0B0F14;color:#EEF1F6;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:460px;padding:32px;text-align:center"><div style="font:700 26px Georgia,serif;color:#D4AF37;margin-bottom:12px">CSE Portfolio</div>
<h1 style="font-size:20px;margin:0 0 10px">${esc(title)}</h1><p style="color:#A3ADBF;line-height:1.6">${esc(msg)}</p>
<p><a href="${SITE()}/" style="color:#D4AF37">Open CSE Portfolio</a></p></div></body></html>`,
});

/** One-click opt-out from the e-mail footer (no sign-in needed). */
async function unsubscribe(req) {
  const id = String(req.params.u || '').slice(0, 64);
  const ok = id && safeEq(String(req.params.t || ''), unsubToken(id));
  if (!ok) return { ...page('Link not valid', 'This unsubscribe link is not valid. You can turn the daily e-mail off in Settings.'), status: 400 };
  const db = getDb();
  await db.sadd(DIGEST_OFF, id);
  const doc = await loadDoc(id);
  if (doc?.data && doc.data.settings?.digestOptOut !== true) {
    doc.data.settings = { ...(doc.data.settings || {}), digestOptOut: true };
    const now = Date.now();
    doc.updatedAt = Math.max(now, (doc.updatedAt || 0) + 1);
    doc.clientUpdatedAt = now; // newest edit, so other devices take it
    await db.set(`data:${id}`, JSON.stringify(doc));
  }
  return page('You are unsubscribed', 'You will not get the daily summary e-mail any more. You can turn it back on any time in Settings.');
}

/** Entry: /api/digest?action=run|test|unsubscribe|wa */
export async function handleDigest(req) {
  const action = req.params.action;
  try {
    if (action === 'unsubscribe') {
      if (!['GET', 'POST'].includes(req.method)) throw new ApiFail(405, 'method_not_allowed', 'Method not allowed.');
      secret();
      return await unsubscribe(req);
    }
    if (action === 'run') {
      if (req.method !== 'GET') throw new ApiFail(405, 'method_not_allowed', 'Method not allowed.');
      return await run(req);
    }
  } catch (err) {
    if (err instanceof ApiFail) return privateJson(err.status, { error: err.code, message: err.message });
    console.error('[digest] unhandled', err);
    return privateJson(500, { error: 'internal_error', message: 'Something went wrong.' });
  }
  if (action === 'test') return runPrivate(req, ['POST'], () => test(req));
  if (action === 'wa') return runPrivate(req, ['GET'], () => wa(req));
  return privateJson(404, { error: 'not_found', message: 'Unknown action.' });
}
