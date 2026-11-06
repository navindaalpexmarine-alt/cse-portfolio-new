/**
 * Insights view — planning tools built on the user's own data:
 *  🎯 Goal tracker · 🩺 Portfolio health score · 🆚 Portfolio vs ASPI · 🏦 FD vs shares
 *  ❄️ Dividend snowball · 🔔 Alerts centre (+ XD reminders) · 🗺️ Market heatmap
 *  🔁 "What if" · 🧮 Rights issue / bonus calculator · 📤 Share card (% only by default)
 * Every number here is an estimate for planning — never a buy/sell recommendation.
 */
import { commit, onChange, state } from '../core/store.js';
import { cse } from '../core/api.js';
import { baseSym, computeRow, normalizeSymbol, sectorOf } from '../core/finance.js';
import { ensureMarketSymbols } from '../core/symbols.js';
import { ensureChart } from '../core/loader.js';
import { go } from '../core/router.js';
import { parseDate } from '../core/dates.js';
import { $, cssVar, esc, fmt, fmtInt } from '../core/utils.js';
import { emptyHtml, toast } from '../core/ui.js';
import { drawQr } from '../core/qr.js';
import { compareWithAspi, healthScore, monthsUntil, projectValue, requiredMonthly, rightsIssue, snowball, whatIf } from '../core/insights-math.js';

const ALERT_KEY = 'cseChat.alerts.v1'; // shared with the chatbot, which fires them on price refresh
const charts = {};
let built = false;

/* ---------- shared helpers ---------- */

const rs = (n) => `Rs ${fmt(n)}`;
const pct = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`);
const cls = (n) => (n > 0 ? 't-pos' : n < 0 ? 't-neg' : 't-muted');
const priceOf = (sym) => {
  const p = Number(state.priceMap[sym]?.price);
  if (p > 0) return p;
  const h = state.holdings.find((x) => x.name === sym);
  return Number(h?.tradedPrice) > 0 ? Number(h.tradedPrice) : null;
};

/** Holdings with live numbers (same maths as the Portfolio tab). */
function portfolioRows() {
  const rate = state.commissionRate;
  return state.holdings.filter((h) => h.name && h.balance > 0).map((h) => {
    const price = priceOf(h.name);
    const r = computeRow({ ...h, tradedPrice: price ?? h.tradedPrice }, rate);
    return {
      symbol: h.name,
      qty: h.balance,
      avg: h.avgPrice,
      avgDps: Number(h.avgDps) || 0,
      price,
      value: price ? r.marketValue : 0,
      cost: h.totalCost || 0,
      pl: price ? r.gainLoss : 0,
      plPct: price ? r.gainLossPct : null,
      chg: Number(state.priceMap[h.name]?.changePct),
      status: price ? r.status : 'hold',
      sector: sectorOf(h.name),
    };
  });
}

function totals(rows) {
  const value = rows.reduce((s, r) => s + r.value, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const pl = rows.reduce((s, r) => s + r.pl, 0);
  const day = rows.reduce((s, r) => (Number.isFinite(r.chg) && r.value ? s + r.value - r.value / (1 + r.chg / 100) : s), 0);
  return { value, cost, pl, plPct: cost ? (pl / cost) * 100 : 0, day, dayPct: value ? (day / (value - day)) * 100 : 0 };
}

function saveSetting(key, val) {
  if (state.settings[key] === val) return;
  state.settings[key] = val;
  commit('settings');
}

const card = (id, icon, title, sub, body) => `
  <section class="panel ins-card" id="${id}">
    <div class="panel-head"><h2>${icon} ${title}</h2>${sub ? `<span class="chip">${sub}</span>` : ''}</div>
    ${body}
  </section>`;

const field = (id, label, attrs = '', hint = '') => `<label class="ins-field" for="${id}"><span>${label}</span><input id="${id}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</label>`;

let divCache = { at: 0, rows: null, p: null };
function cashDividends() {
  if (divCache.rows && Date.now() - divCache.at < 600000) return Promise.resolve(divCache.rows);
  if (!divCache.p) {
    divCache.p = cse('cashDividends').then((d) => {
      const rows = (Array.isArray(d?.cashDividends) ? d.cashDividends : []).map((r) => ({
        symbol: baseSym(r.symbol || ''), company: r.company || '', dps: Number(r.votingDivPerShare) || 0,
        xd: parseDate(r.xd), pay: parseDate(r.payment),
      }));
      divCache = { at: Date.now(), rows, p: null };
      return rows;
    }).catch((e) => { divCache.p = null; throw e; });
  }
  return divCache.p;
}
const dShort = (d) => (d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—');
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/* =====================================================================
 * 🎯 Goal
 * ===================================================================== */
function goalCard() {
  const s = state.settings;
  return card('insGoal', '🎯', 'Goal tracker', 'plan', `
    <div class="ins-form">
      ${field('goalAmount', 'Target value (Rs)', `type="number" min="0" step="1000" inputmode="numeric" placeholder="e.g. 2000000" value="${s.goalAmount || ''}"`)}
      ${field('goalDate', 'By date', `type="date" value="${esc(s.goalDate || '')}"`)}
      ${field('goalReturn', 'Expected return / year %', `type="number" min="0" max="50" step="0.5" value="${s.goalReturn ?? 10}"`, 'An assumption, not a promise')}
    </div>
    <div class="ins-out" id="goalOut"></div>`);
}

function renderGoal() {
  const out = $('#goalOut');
  if (!out) return;
  const s = state.settings;
  const target = Number(s.goalAmount) || 0;
  const t = totals(portfolioRows());
  if (!target || !s.goalDate) {
    out.innerHTML = emptyHtml(`Set a target and a date. Your portfolio is worth <b>${rs(t.value)}</b> today.`, true);
    return;
  }
  const months = monthsUntil(s.goalDate);
  const ret = Number(s.goalReturn) || 0;
  const need = requiredMonthly(t.value, target, months, ret);
  const noAdd = projectValue(t.value, 0, months, ret);
  const prog = Math.max(0, Math.min(100, (t.value / target) * 100));
  const onTrack = need === 0;
  out.innerHTML = `
    <div class="goal-bar" role="img" aria-label="${prog.toFixed(0)}% of goal"><i style="width:${prog}%"></i><span>${prog.toFixed(1)}%</span></div>
    <div class="metric-grid">
      <div class="metric"><div class="m-label">Now</div><div class="m-val">${rs(t.value)}</div><div class="m-hint">of ${rs(target)}</div></div>
      <div class="metric"><div class="m-label">Time left</div><div class="m-val">${months} months</div><div class="m-hint">until ${esc(s.goalDate)}</div></div>
      <div class="metric ${onTrack ? 'good' : ''}"><div class="m-label">Add per month</div><div class="m-val t-gold">${onTrack ? 'Nothing 🎉' : rs(need)}</div><div class="m-hint">at ${ret}% a year</div></div>
      <div class="metric"><div class="m-label">If you add nothing</div><div class="m-val">${rs(noAdd)}</div><div class="m-hint">${noAdd >= target ? 'reaches the goal' : `short by ${rs(target - noAdd)}`}</div></div>
    </div>
    ${months === 0 ? '<div class="legend">The date has passed — pick a new one.</div>' : ''}`;
}

/* =====================================================================
 * 🩺 Health
 * ===================================================================== */
function renderHealth() {
  const box = $('#healthOut');
  if (!box) return;
  const rows = portfolioRows();
  const divSyms = new Set(state.divEvents.map((e) => baseSym(e.symbol)));
  const h = healthScore(rows.map((r) => ({ ...r, dividend: r.avgDps > 0 || divSyms.has(baseSym(r.symbol)) })));
  if (!h.parts.length) { box.innerHTML = emptyHtml(esc(h.tips[0]), true); return; }
  const tone = h.score >= 80 ? 'pos' : h.score >= 60 ? 'gold' : h.score >= 40 ? 'warn' : 'neg';
  box.innerHTML = `
    <div class="health-wrap">
      <div class="health-ring ${tone}" style="--p:${h.score}" role="img" aria-label="Health score ${h.score} of 100"><b>${h.score}</b><span>${esc(h.grade)}</span></div>
      <div class="health-parts">${h.parts.map((p) => `
        <div class="hp"><div class="hp-top"><span>${esc(p.label)}</span><b>${p.score}/${p.max}</b></div>
          <div class="hp-bar"><i style="width:${(p.score / p.max) * 100}%"></i></div><small>${esc(p.note)}</small></div>`).join('')}
      </div>
    </div>
    <ul class="ins-tips">${h.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <div class="legend">A simple check of spread and risk — not advice. Sector labels come from a built-in list; unknown shares count as “Other”.</div>`;
}

/* =====================================================================
 * 🆚 vs ASPI
 * ===================================================================== */
async function renderAspi() {
  const box = $('#aspiOut');
  if (!box) return;
  const cmp = compareWithAspi(state.valueSnaps);
  const withAspi = state.valueSnaps.filter((s) => s.aspi > 0).length;
  if (!cmp) {
    box.innerHTML = emptyHtml(`Collecting data — each time prices update, today’s ASPI is saved next to your portfolio value.
      The comparison appears after <b>2 days</b> (${withAspi} saved so far). Keep the app open during market hours or press <b>Update prices</b>.`, true);
    return;
  }
  const beat = cmp.portPct - cmp.aspiPct;
  box.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><div class="m-label">Your portfolio</div><div class="m-val ${cls(cmp.portPct)}">${pct(cmp.portPct)}</div><div class="m-hint">time-weighted · new money excluded</div></div>
      <div class="metric"><div class="m-label">ASPI</div><div class="m-val ${cls(cmp.aspiPct)}">${pct(cmp.aspiPct)}</div><div class="m-hint">since ${esc(cmp.days[0])}</div></div>
      <div class="metric ${beat >= 0 ? 'good' : ''}"><div class="m-label">Difference</div><div class="m-val ${cls(beat)}">${pct(beat)}</div><div class="m-hint">${beat >= 0 ? 'ahead of the market' : 'behind the market'}</div></div>
    </div>
    <div class="chart-box" style="height:240px"><canvas id="aspiChart" role="img" aria-label="Portfolio versus ASPI"></canvas></div>`;
  let Chart;
  try { Chart = await ensureChart(); } catch { return; }
  if (!$('#aspiChart')) return;
  charts.aspi?.destroy();
  charts.aspi = new Chart($('#aspiChart'), {
    type: 'line',
    data: {
      labels: cmp.days,
      datasets: [
        { label: 'Your portfolio', data: cmp.port, borderColor: cssVar('--gold'), backgroundColor: cssVar('--gold-wash'), fill: true, pointRadius: 0, tension: 0.2, borderWidth: 2 },
        { label: 'ASPI', data: cmp.aspi, borderColor: cssVar('--blue'), pointRadius: 0, tension: 0.2, borderWidth: 1.6, borderDash: [5, 3] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${pct(c.raw - 100)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 6 }, grid: { display: false } }, y: { ticks: { callback: (v) => pct(v - 100, 0) } } },
    },
  });
}

/* =====================================================================
 * 🏦 FD vs shares
 * ===================================================================== */
function renderFd() {
  const box = $('#fdOut');
  if (!box) return;
  const fd = Number(state.settings.fdRate) || 0;
  const rows = portfolioRows().filter((r) => r.price);
  if (!rows.length) { box.innerHTML = emptyHtml('Add shares (with live prices) to compare with a fixed deposit.', true); return; }
  if (!fd) { box.innerHTML = emptyHtml('Enter your bank’s FD rate above (e.g. 8.5) to compare.', true); return; }
  const t = totals(rows);
  const yearlyDiv = rows.reduce((s, r) => s + r.avgDps * r.qty, 0);
  const fdOnValue = t.value * (fd / 100);
  const divYield = t.value ? (yearlyDiv / t.value) * 100 : 0;
  const noDps = rows.filter((r) => !r.avgDps).length;
  box.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><div class="m-label">FD interest / year</div><div class="m-val">${rs(fdOnValue)}</div><div class="m-hint">${fd}% on today’s value ${rs(t.value)}</div></div>
      <div class="metric ${yearlyDiv >= fdOnValue ? 'good' : ''}"><div class="m-label">Dividends / year (est.)</div><div class="m-val">${rs(yearlyDiv)}</div><div class="m-hint">yield ${divYield.toFixed(2)}% · from your Avg DPS</div></div>
      <div class="metric"><div class="m-label">Price growth needed</div><div class="m-val t-gold">${pct(Math.max(0, fd - divYield))}</div><div class="m-hint">a year, for shares to match the FD</div></div>
    </div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th class="left">Share</th><th>Price</th><th>Avg DPS</th><th>Dividend yield</th><th>vs FD ${fd}%</th></tr></thead>
      <tbody>${rows.map((r) => {
        const y = r.avgDps && r.price ? (r.avgDps / r.price) * 100 : null;
        return `<tr><td class="left"><b>${esc(baseSym(r.symbol))}</b></td><td>${fmt(r.price)}</td><td>${r.avgDps ? fmt(r.avgDps) : '—'}</td>
          <td>${y != null ? y.toFixed(2) + '%' : '—'}</td><td class="${y == null ? 't-muted' : y >= fd ? 't-pos' : 't-neg'}">${y == null ? 'set Avg DPS' : y >= fd ? 'higher' : `needs ${pct(fd - y)} growth`}</td></tr>`;
      }).join('')}</tbody></table></div>
    <div class="legend">An FD pays a fixed rate; shares can also rise or fall in price. Dividends are before tax and not guaranteed.
      ${noDps ? `${noDps} share(s) have no Avg DPS — set it in the <a href="#div">Dividends tab</a>.` : ''}</div>`;
}

/* =====================================================================
 * ❄️ Snowball
 * ===================================================================== */
function snowCard() {
  const rows = portfolioRows();
  const t = totals(rows);
  const yearlyDiv = rows.reduce((s, r) => s + r.avgDps * r.qty, 0);
  const y = t.value && yearlyDiv ? ((yearlyDiv / t.value) * 100).toFixed(2) : '6';
  return card('insSnow', '❄️', 'Dividend snowball', 'what reinvesting does', `
    <div class="ins-form">
      ${field('snowValue', 'Start value (Rs)', `type="number" min="0" step="1000" value="${Math.round(t.value) || 100000}"`)}
      ${field('snowYield', 'Dividend yield %', `type="number" min="0" max="40" step="0.1" value="${y}"`)}
      ${field('snowGrowth', 'Price growth / year %', 'type="number" min="-20" max="40" step="0.5" value="4"')}
      ${field('snowAdd', 'Add per year (Rs)', 'type="number" min="0" step="1000" value="0"')}
      ${field('snowYears', 'Years', 'type="number" min="1" max="40" step="1" value="10"')}
      <label class="ins-check"><input type="checkbox" id="snowReinvest" checked> Reinvest dividends</label>
    </div>
    <div class="ins-out" id="snowOut"></div>`);
}

async function renderSnow() {
  const box = $('#snowOut');
  if (!box) return;
  const v = (id) => Number($(id)?.value) || 0;
  const params = { value: v('#snowValue'), yieldPct: v('#snowYield'), growthPct: v('#snowGrowth'), yearlyAdd: v('#snowAdd'), years: Math.max(1, Math.min(40, v('#snowYears') || 10)) };
  const a = snowball({ ...params, reinvest: !!$('#snowReinvest')?.checked });
  const b = snowball({ ...params, reinvest: false });
  const last = a.at(-1), lastB = b.at(-1);
  box.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><div class="m-label">Dividends in year 1</div><div class="m-val">${rs(a[0].income)}</div><div class="m-hint">${rs(a[0].income / 12)} a month</div></div>
      <div class="metric good"><div class="m-label">Dividends in year ${params.years}</div><div class="m-val t-gold">${rs(last.income)}</div><div class="m-hint">${rs(last.income / 12)} a month</div></div>
      <div class="metric"><div class="m-label">Value after ${params.years} years</div><div class="m-val">${rs(last.value)}</div><div class="m-hint">total dividends ${rs(last.totalIncome)}</div></div>
      <div class="metric"><div class="m-label">Reinvesting adds</div><div class="m-val ${cls(last.value - lastB.value)}">${rs(last.value - lastB.value)}</div><div class="m-hint">vs taking the cash</div></div>
    </div>
    <div class="chart-box" style="height:220px"><canvas id="snowChart" role="img" aria-label="Dividend income by year"></canvas></div>
    <div class="legend">Assumes the same yield and growth every year — real results will differ. Before tax and fees.</div>`;
  let Chart;
  try { Chart = await ensureChart(); } catch { return; }
  if (!$('#snowChart')) return;
  charts.snow?.destroy();
  charts.snow = new Chart($('#snowChart'), {
    type: 'bar',
    data: {
      labels: a.map((r) => `Y${r.year}`),
      datasets: [
        { label: $('#snowReinvest')?.checked ? 'Income (reinvesting)' : 'Income', data: a.map((r) => Math.round(r.income)), backgroundColor: cssVar('--gold'), borderRadius: 4 },
        { label: 'Income (cash out)', data: b.map((r) => Math.round(r.income)), backgroundColor: cssVar('--line'), borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${rs(c.raw)}` } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { maxTicksLimit: 5, callback: (v) => fmtInt(v) } } },
    },
  });
}

/* =====================================================================
 * 🔔 Alerts centre + XD reminders
 * ===================================================================== */
const loadAlerts = () => { try { const v = JSON.parse(localStorage.getItem(ALERT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveAlerts = (l) => { try { localStorage.setItem(ALERT_KEY, JSON.stringify(l.slice(0, 30))); } catch { /* blocked */ } };

function alertsCard() {
  return card('insAlerts', '🔔', 'Alerts centre', 'price · XD · signals', `
    <form class="ins-form" id="alertForm" autocomplete="off">
      ${field('alertSym', 'Share', 'list="fundDatalist" placeholder="e.g. COMB" required')}
      <label class="ins-field" for="alertDir"><span>When price is</span><select id="alertDir" class="select"><option value="above">at or above</option><option value="below">at or below</option></select></label>
      ${field('alertPrice', 'Price (Rs)', 'type="number" min="0" step="0.1" required')}
      <button class="btn primary" type="submit">+ Add alert</button>
    </form>
    <div class="ins-out" id="alertsOut"></div>
    <div class="alert-prefs">
      <label class="ins-check"><input type="checkbox" id="xdRemind" ${state.settings.xdRemind !== false ? 'checked' : ''}> Remind me 2 days before an XD date of my shares</label>
      <button class="btn ghost sm" type="button" id="notifyBtn"></button>
    </div>`);
}

function notifyLabel() {
  const b = $('#notifyBtn');
  if (!b) return;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  b.textContent = perm === 'granted' && state.settings.notify ? '🔔 Browser notifications: on' : perm === 'denied' ? '🔕 Notifications blocked in browser settings' : '🔔 Turn on browser notifications';
  b.disabled = perm === 'denied' || perm === 'unsupported';
}

async function renderAlerts() {
  const box = $('#alertsOut');
  if (!box) return;
  const list = loadAlerts();
  const rows = portfolioRows();
  const signals = rows.filter((r) => r.status === 'sell' || r.status === 'near');
  box.innerHTML = `
    <div class="alert-cols">
      <div><h3>⏰ Price alerts</h3>${list.length ? `<ul class="alert-list">${list.map((a, i) => {
        const now = priceOf(a.sym);
        return `<li><b>${esc(baseSym(a.sym))}</b> ${a.dir === 'above' ? '≥' : '≤'} ${rs(a.price)} <span class="t-muted">· now ${now ? rs(now) : '—'}</span>
          <button type="button" class="w-del" data-del-alert="${i}" aria-label="Delete alert">×</button></li>`;
      }).join('')}</ul>` : '<p class="t-muted">No price alerts. They fire when prices update (keep the app open).</p>'}</div>
      <div><h3>💰 XD in the next 30 days</h3><div id="xdList"><p class="t-muted">Loading…</p></div></div>
      <div><h3>🔔 SELL / NEAR now</h3>${signals.length ? `<ul class="alert-list">${signals.map((r) => `<li><span class="badge ${r.status === 'sell' ? 'fin' : 'news'}">${r.status.toUpperCase()}</span> <b>${esc(baseSym(r.symbol))}</b> ${rs(r.price)} <span class="t-muted">· ${pct(r.plPct)}</span></li>`).join('')}</ul>` : '<p class="t-muted">None of your shares is at or near its B.E.S.</p>'}</div>
    </div>`;
  notifyLabel();
  const held = new Map(rows.map((r) => [baseSym(r.symbol), r]));
  const xdBox = $('#xdList');
  if (!held.size) { xdBox.innerHTML = '<p class="t-muted">Add shares to see their XD dates.</p>'; return; }
  try {
    const all = await cashDividends();
    const today = startOfToday();
    const soon = all.filter((d) => held.has(d.symbol) && d.xd && d.xd >= today && d.xd - today <= 30 * 86400000).sort((a, b) => a.xd - b.xd);
    if (!xdBox.isConnected) return;
    xdBox.innerHTML = soon.length ? `<ul class="alert-list">${soon.map((d) => {
      const h = held.get(d.symbol);
      const days = Math.round((d.xd - today) / 86400000);
      return `<li><b>${esc(d.symbol)}</b> XD ${dShort(d.xd)} <span class="badge ${days <= 2 ? 'new' : 'soon'}">${days === 0 ? 'today' : `in ${days}d`}</span><br>
        <span class="t-muted">Rs ${fmt(d.dps)}/share${d.pay ? ` · pay ${dShort(d.pay)}` : ''} · you ≈ ${rs(d.dps * h.qty)}</span></li>`;
    }).join('')}</ul>` : '<p class="t-muted">No XD dates announced for your shares in the CSE feed.</p>';
  } catch {
    if (xdBox.isConnected) xdBox.innerHTML = '<p class="t-muted">CSE dividend list unavailable right now.</p>';
  }
}

/** Once a day: toast + notification when one of your shares goes XD within 2 days. */
async function checkXdReminders() {
  if (state.settings.xdRemind === false || !state.holdings.length) return;
  const day = new Date().toISOString().slice(0, 10);
  try { if (localStorage.getItem('cse_xd_remind_day') === day) return; } catch { /* ignore */ }
  let all;
  try { all = await cashDividends(); } catch { return; }
  try { localStorage.setItem('cse_xd_remind_day', day); } catch { /* ignore */ }
  const held = new Map(state.holdings.filter((h) => h.balance > 0).map((h) => [baseSym(h.name), h]));
  const today = startOfToday();
  const msgs = [];
  for (const d of all) {
    const h = held.get(d.symbol);
    if (!h || !d.xd || d.xd < today || d.xd - today > 2 * 86400000) continue;
    const key = `xd:${d.symbol}:${d.xd.getFullYear()}-${String(d.xd.getMonth() + 1).padStart(2, '0')}-${String(d.xd.getDate()).padStart(2, '0')}`;
    if (state.alertSeen[key]) continue;
    state.alertSeen[key] = Date.now();
    msgs.push(`${d.symbol} goes XD on ${dShort(d.xd)} — Rs ${fmt(d.dps)}/share (≈ ${rs(d.dps * h.balance)} for your ${fmtInt(h.balance)})`);
  }
  if (!msgs.length) return;
  commit('alerts', { sync: false });
  toast(`💰 ${msgs.join(' · ')}`, { ms: 8000 });
  try {
    if (state.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('CSE Portfolio — XD reminder', { body: msgs.join('\n'), icon: 'assets/icons/icon-192.png', tag: 'cse-xd' });
    }
  } catch { /* some mobile browsers only allow notifications from a service worker */ }
}

let remindersStarted = false;
/** Called once from main.js after the app starts. */
export function startReminders() {
  if (remindersStarted) return;
  remindersStarted = true;
  setTimeout(checkXdReminders, 8000);
  onChange((topic) => { if (topic === 'prices') checkXdReminders(); });
}

/* =====================================================================
 * 🗺️ Heatmap
 * ===================================================================== */
let heatFilter = 'all';
async function renderHeat() {
  const box = $('#heatOut');
  if (!box) return;
  let list;
  try {
    const d = await cse('tradeSummary');
    list = Array.isArray(d?.reqTradeSummery) ? d.reqTradeSummery : [];
  } catch { box.innerHTML = emptyHtml('Market data unavailable right now.', true); return; }
  if (!box.isConnected) return;
  const mine = new Set(state.holdings.map((h) => h.name));
  const watch = new Set(state.watchlist || []);
  let rows = list.map((r) => ({ sym: String(r.symbol || '').toUpperCase(), name: r.name || '', pct: Number(r.percentageChange ?? r.changePercentage) || 0, to: Number(r.turnover) || 0, price: Number(r.price) || 0 }))
    .filter((r) => r.sym && r.price);
  if (heatFilter === 'mine') rows = rows.filter((r) => mine.has(r.sym));
  else if (heatFilter === 'watch') rows = rows.filter((r) => watch.has(r.sym));
  else rows = rows.filter((r) => r.to > 0);
  rows.sort((a, b) => b.to - a.to);
  rows = rows.slice(0, heatFilter === 'all' ? 60 : 100);
  if (!rows.length) { box.innerHTML = emptyHtml(heatFilter === 'all' ? 'No trades yet today.' : 'None of these shares traded today.', true); return; }
  const maxTo = Math.max(...rows.map((r) => r.to), 1);
  const up = list.filter((r) => Number(r.percentageChange ?? r.changePercentage) > 0).length;
  const dn = list.filter((r) => Number(r.percentageChange ?? r.changePercentage) < 0).length;
  box.innerHTML = `
    <div class="heat-breadth"><span class="t-pos">▲ ${up} up</span> · <span class="t-neg">▼ ${dn} down</span> · ${list.length - up - dn} unchanged</div>
    <div class="heatmap">${rows.map((r) => {
      const w = 64 + Math.round(Math.sqrt(r.to / maxTo) * 120);
      const a = Math.min(1, Math.abs(r.pct) / 6);
      const bg = r.pct > 0 ? `color-mix(in srgb, var(--pos) ${Math.round(18 + a * 60)}%, var(--panel-2))` : r.pct < 0 ? `color-mix(in srgb, var(--neg) ${Math.round(18 + a * 60)}%, var(--panel-2))` : 'var(--panel-2)';
      return `<button type="button" class="heat-tile${mine.has(r.sym) ? ' mine' : ''}" style="flex-basis:${w}px;background:${bg}" data-sym="${esc(r.sym)}"
        title="${esc(r.name)} · Rs ${fmt(r.price)} · turnover Rs ${fmtInt(r.to)}"><b>${esc(baseSym(r.sym))}</b><span>${pct(r.pct)}</span></button>`;
    }).join('')}</div>
    <div class="legend">Tile size = today’s turnover · colour = % change · ★ outline = your share. Click a tile for Fundamentals.</div>`;
}

/* =====================================================================
 * 🔁 What if
 * ===================================================================== */
function whatIfCard() {
  return card('insWhatIf', '🔁', 'What if I had invested?', 'from CSE daily prices', `
    <form class="ins-form" id="whatIfForm" autocomplete="off">
      ${field('wiSym', 'Share', 'list="fundDatalist" placeholder="e.g. JKH" required')}
      ${field('wiAmount', 'Amount (Rs)', 'type="number" min="1000" step="1000" value="100000" required')}
      <label class="ins-field" for="wiWhen"><span>Invested</span><select id="wiWhen" class="select">
        <option value="30">1 month ago</option><option value="91">3 months ago</option><option value="182" selected>6 months ago</option><option value="365">1 year ago</option></select></label>
      <button class="btn primary" type="submit">Calculate</button>
    </form>
    <div class="ins-out" id="wiOut"></div>`);
}

async function runWhatIf() {
  const out = $('#wiOut');
  let sym = String($('#wiSym').value || '').trim().toUpperCase();
  if (!sym) return;
  await ensureMarketSymbols(false);
  const hit = state.market.find((x) => x.symbol === sym) || state.market.find((x) => x.symbol.startsWith(sym + '.')) || state.market.find((x) => x.symbol.startsWith(sym));
  sym = hit?.symbol || normalizeSymbol(sym);
  const id = state.priceMap[sym]?.id ?? hit?.id;
  if (id == null) { out.innerHTML = emptyHtml(`${esc(sym)} not found in today’s CSE list.`, true); return; }
  out.innerHTML = emptyHtml('Loading prices…', true);
  let pts = [];
  try {
    const ch = await cse('companyChartDataByStock', { stockId: id, period: '5' });
    const raw = ch.chartData || ch.reqTradeSummery?.chartData || [];
    pts = (Array.isArray(raw) ? raw : []).map((p) => ({ t: Number(p.t), p: Number(p.p ?? p.c) })).filter((p) => p.t && p.p > 0).sort((a, b) => a.t - b.t);
  } catch { /* handled below */ }
  if (pts.length < 2) { out.innerHTML = emptyHtml('No price history available for this share.', true); return; }
  const days = Number($('#wiWhen').value) || 182;
  const target = Date.now() - days * 86400000;
  const start = pts.find((p) => p.t >= target) || pts[0];
  const now = priceOf(sym) || pts.at(-1).p;
  const r = whatIf(Number($('#wiAmount').value), start.p, now, state.commissionRate);
  if (!r || !r.shares) { out.innerHTML = emptyHtml('Amount is too small for one share.', true); return; }
  const startD = new Date(start.t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const short = start.t - target > 20 * 86400000;
  out.innerHTML = `
    <div class="whatif-line">${rs(r.spent)} in <b>${esc(baseSym(sym))}</b> on ${startD} at ${rs(start.p)}
      → <b>${fmtInt(r.shares)}</b> shares, worth <b class="${cls(r.pl)}">${rs(r.value)}</b> today (${rs(now)}).</div>
    <div class="metric-grid">
      <div class="metric ${r.pl >= 0 ? 'good' : ''}"><div class="m-label">Profit / loss</div><div class="m-val ${cls(r.pl)}">${rs(r.pl)}</div><div class="m-hint">${pct(r.plPct)} after ${fmt(state.commissionRate)}% commission both ways</div></div>
    </div>
    <div class="legend">${short ? 'Price history starts later than the chosen date, so the earliest available price is used. ' : ''}Excludes dividends received. Past moves don’t predict future ones.</div>`;
}

/* =====================================================================
 * 🧮 Rights issue / bonus
 * ===================================================================== */
function rightsCard() {
  return card('insRights', '🧮', 'Rights issue & bonus calculator', '', `
    <div class="ins-form">
      ${field('riSym', 'Share (optional)', 'list="fundDatalist" placeholder="fills price & qty"')}
      ${field('riPrice', 'Market price (Rs)', 'type="number" min="0" step="0.1"')}
      ${field('riSub', 'Rights price (Rs)', 'type="number" min="0" step="0.1"')}
      <label class="ins-field"><span>Ratio: new for held</span><span class="ratio"><input id="riB" type="number" min="1" step="1" value="1" aria-label="New shares"> for <input id="riA" type="number" min="1" step="1" value="4" aria-label="Held shares"></span></label>
      ${field('riHeld', 'Your shares', 'type="number" min="0" step="1"')}
    </div>
    <div class="ins-out" id="riOut"></div>`);
}

function renderRights() {
  const out = $('#riOut');
  if (!out) return;
  const v = (id) => Number($(id)?.value);
  const r = rightsIssue({ price: v('#riPrice'), subPrice: v('#riSub'), held: v('#riHeld'), a: v('#riA'), b: v('#riB') });
  if (!r) { out.innerHTML = emptyHtml('Enter the market price, the rights price and the ratio (e.g. 1 for 4).', true); return; }
  const a = v('#riA'), b = v('#riB'), held = v('#riHeld') || 0, P = v('#riPrice');
  const bonusQty = Math.floor((held * b) / a);
  out.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><div class="m-label">Price after rights (TERP)</div><div class="m-val t-gold">${rs(r.terp)}</div><div class="m-hint">rights price is ${r.discountPct.toFixed(1)}% below market</div></div>
      <div class="metric"><div class="m-label">Value of one right</div><div class="m-val">${rs(r.rightValue)}</div><div class="m-hint">TERP − rights price</div></div>
      <div class="metric"><div class="m-label">You can buy</div><div class="m-val">${fmtInt(r.entitled)} shares</div><div class="m-hint">costs ${rs(r.cost)}</div></div>
      <div class="metric"><div class="m-label">Take up vs let lapse</div><div class="m-val">${rs(r.valueIfTake)}</div><div class="m-hint">vs ${rs(r.valueIfIgnore)} if you do nothing (after paying)</div></div>
    </div>
    <div class="legend">Letting rights lapse can lose value — rights can often be sold (renounced) instead. If this were a <b>bonus issue</b> of ${b} for ${a}:
      you’d get ${fmtInt(bonusQty)} free shares (total ${fmtInt(held + bonusQty)}) and the price would adjust to about ${rs((P * a) / (a + b))}. Check the official circular on cse.lk.</div>`;
}

/* =====================================================================
 * 📤 Share card (canvas) — with a QR code that opens the site
 * ===================================================================== */
const SHARE_URL = () => (location.protocol === 'https:' ? `${location.origin}/` : 'https://cse-portfolio-new.vercel.app/');

// Site logo for the share card — loaded once, cached; the card still draws if it fails.
let logoPromise = null;
function loadLogo() {
  if (!logoPromise) {
    logoPromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = new URL('../../icons/icon-192.png', import.meta.url).href;
    });
  }
  return logoPromise;
}

function drawShareCard(showAmounts, logo = null) {
  const rows = portfolioRows().filter((r) => r.price);
  const t = totals(rows);
  const best = [...rows].filter((r) => r.plPct != null).sort((a, b) => b.plPct - a.plPct)[0];
  const cv = document.createElement('canvas');
  cv.width = 1080; cv.height = 1080;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1080, 1080);
  grad.addColorStop(0, '#0B0F14'); grad.addColorStop(1, '#1d2633');
  g.fillStyle = grad; g.fillRect(0, 0, 1080, 1080);
  g.strokeStyle = '#D4AF37'; g.lineWidth = 6; g.strokeRect(40, 40, 1000, 1000);
  // Logo + title (header)
  const tx = logo ? 210 : 90;
  if (logo) {
    g.save();
    g.beginPath(); g.roundRect ? g.roundRect(90, 96, 100, 100, 22) : g.rect(90, 96, 100, 100); g.clip();
    g.drawImage(logo, 90, 96, 100, 100);
    g.restore();
  }
  g.fillStyle = '#D4AF37'; g.font = '700 54px Georgia, serif'; g.fillText('CSE Portfolio', tx, 150);
  g.fillStyle = '#8B95A8'; g.font = '500 32px Inter, system-ui, sans-serif';
  g.fillText(new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }), tx, 196);
  const W = 640; // text column; the QR code sits bottom-right
  const W2 = 570; // narrower next to the QR code
  const line = (label, value, color, y, size = 92) => {
    g.fillStyle = '#8B95A8'; g.font = '600 30px Inter, system-ui, sans-serif'; g.fillText(label.toUpperCase(), 90, y, W);
    g.fillStyle = color; g.font = `700 ${size}px Inter, system-ui, sans-serif`; g.fillText(value, 90, y + size + 6, W);
  };
  const col = (n) => (n >= 0 ? '#2ECC9A' : '#E85D5D');
  line('Total return', pct(t.plPct), col(t.plPct), 330, 130);
  line('Today', pct(t.dayPct), col(t.dayPct), 560);
  if (best) { g.fillStyle = '#8B95A8'; g.font = '600 30px Inter, system-ui, sans-serif'; g.fillText(`BEST SHARE · ${baseSym(best.symbol)}`, 90, 760, W2);
    g.fillStyle = col(best.plPct); g.font = '700 76px Inter, system-ui, sans-serif'; g.fillText(pct(best.plPct), 90, 842, W2); }
  if (showAmounts) { g.fillStyle = '#EEF1F6'; g.font = '600 32px Inter, system-ui, sans-serif'; g.fillText(`Value ${rs(t.value)} · P/L ${rs(t.pl)}`, 90, 915, W2); }
  const url = SHARE_URL();
  g.fillStyle = '#D4AF37'; g.font = '600 30px Inter, system-ui, sans-serif';
  g.fillText(url.replace(/^https?:\/\//, '').replace(/\/$/, ''), 90, 965, W2);
  g.fillStyle = '#5c6474'; g.font = '500 24px Inter, system-ui, sans-serif';
  g.fillText(`${rows.length} shares · not investment advice`, 90, 1005, W2);
  // QR code (bottom-right) — scan to open the site
  const qx = 696, qy = 620, qs = 296; // 37 modules × 8 px for a short link
  g.fillStyle = '#FFFFFF';
  g.beginPath(); g.roundRect ? g.roundRect(qx - 12, qy - 12, qs + 24, qs + 24, 18) : g.rect(qx - 12, qy - 12, qs + 24, qs + 24); g.fill();
  try { drawQr(g, url, qx, qy, qs); } catch { /* text too long — skip the code */ }
  g.fillStyle = '#EEF1F6'; g.font = '600 26px Inter, system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('Scan to open', qx + qs / 2, qy + qs + 52);
  g.textAlign = 'left';
  return cv;
}

async function renderShare() {
  const out = $('#shareOut');
  if (!out) return;
  if (!portfolioRows().some((r) => r.price)) { out.innerHTML = emptyHtml('Add shares with live prices to make a share card.', true); return; }
  const logo = await loadLogo();
  const cv = drawShareCard(!!$('#shareAmounts')?.checked, logo);
  out.innerHTML = `<img class="share-preview" alt="Portfolio share card preview" src="${cv.toDataURL('image/png')}">`;
}

async function shareNow() {
  const cv = drawShareCard(!!$('#shareAmounts')?.checked, await loadLogo());
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const file = new File([blob], 'cse-portfolio.png', { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'My CSE portfolio', text: `Tracked with CSE Portfolio — ${SHARE_URL()}` });
      return;
    }
  } catch (err) { if (err?.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cse-portfolio.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Image downloaded — share it on WhatsApp or anywhere');
}

/* =====================================================================
 * Layout + lifecycle
 * ===================================================================== */
function build() {
  const root = $('#insightsRoot');
  root.innerHTML = [
    goalCard(),
    card('insHealth', '🩺', 'Portfolio health', 'score 0–100', '<div class="ins-out" id="healthOut"></div>'),
    card('insAspi', '🆚', 'Your portfolio vs ASPI', 'time-weighted', '<div class="ins-out" id="aspiOut"></div>'),
    card('insFd', '🏦', 'FD vs shares', 'income comparison', `<div class="ins-form">${field('fdRate', 'Your FD rate % a year', `type="number" min="0" max="40" step="0.05" placeholder="e.g. 8.5" value="${state.settings.fdRate || ''}"`, 'From your bank — saved for next time')}</div><div class="ins-out" id="fdOut"></div>`),
    snowCard(),
    alertsCard(),
    card('insHeat', '🗺️', 'Market heatmap', 'today', `<div class="news-chips" id="heatChips" role="group" aria-label="Heatmap filter">
      <button type="button" class="news-chip on" data-hf="all" aria-pressed="true">Most traded</button>
      <button type="button" class="news-chip" data-hf="mine" aria-pressed="false">My shares</button>
      <button type="button" class="news-chip" data-hf="watch" aria-pressed="false">Watchlist</button></div><div class="ins-out" id="heatOut"></div>`),
    whatIfCard(),
    rightsCard(),
    card('insShare', '📤', 'Share card', 'WhatsApp · Facebook', `<label class="ins-check"><input type="checkbox" id="shareAmounts"> Show rupee amounts (off = % only, safer to share)</label>
      <div class="ins-out" id="shareOut"></div><div class="panel-actions"><button class="btn primary" type="button" id="shareBtn">📤 Share / download image</button></div>`),
  ].join('');

  // Goal + FD inputs save to settings (synced with the account)
  const num = (el) => Math.max(0, Number(el.value) || 0);
  $('#goalAmount').addEventListener('change', (e) => { saveSetting('goalAmount', num(e.target)); renderGoal(); });
  $('#goalDate').addEventListener('change', (e) => { saveSetting('goalDate', String(e.target.value || '').slice(0, 10)); renderGoal(); });
  $('#goalReturn').addEventListener('change', (e) => { saveSetting('goalReturn', Math.min(50, num(e.target))); renderGoal(); });
  $('#fdRate').addEventListener('change', (e) => { saveSetting('fdRate', Math.min(40, num(e.target))); renderFd(); });
  ['#snowValue', '#snowYield', '#snowGrowth', '#snowAdd', '#snowYears', '#snowReinvest'].forEach((id) => $(id).addEventListener('change', renderSnow));

  $('#alertForm').addEventListener('submit', (e) => {
    e.preventDefault();
    let sym = String($('#alertSym').value || '').trim().toUpperCase();
    const hit = state.market.find((x) => x.symbol === sym) || state.market.find((x) => x.symbol.startsWith(sym + '.'));
    sym = hit?.symbol || normalizeSymbol(sym);
    const price = Number($('#alertPrice').value);
    if (!sym || !(price > 0)) return;
    const dir = $('#alertDir').value === 'below' ? 'below' : 'above';
    const list = loadAlerts().filter((a) => !(a.sym === sym && a.dir === dir));
    saveAlerts([...list, { sym, price, dir, created: Date.now() }]);
    toast(`⏰ Alert set: ${baseSym(sym)} ${dir === 'above' ? '≥' : '≤'} ${rs(price)}`);
    e.target.reset();
    renderAlerts();
  });
  $('#alertsOut').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-alert]');
    if (!b) return;
    const list = loadAlerts();
    list.splice(Number(b.dataset.delAlert), 1);
    saveAlerts(list);
    renderAlerts();
  });
  $('#xdRemind').addEventListener('change', (e) => saveSetting('xdRemind', !!e.target.checked));
  $('#notifyBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    saveSetting('notify', perm === 'granted');
    notifyLabel();
    if (perm === 'granted') toast('Notifications on ✓');
  });

  $('#heatChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-hf]');
    if (!c) return;
    heatFilter = c.dataset.hf;
    $('#heatChips').querySelectorAll('.news-chip').forEach((x) => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', String(x === c)); });
    renderHeat();
  });
  $('#heatOut').addEventListener('click', (e) => {
    const t = e.target.closest('[data-sym]');
    if (t) go('fund', { sym: t.dataset.sym });
  });

  $('#whatIfForm').addEventListener('submit', (e) => { e.preventDefault(); runWhatIf(); });

  ['#riPrice', '#riSub', '#riA', '#riB', '#riHeld'].forEach((id) => $(id).addEventListener('input', renderRights));
  $('#riSym').addEventListener('change', (e) => {
    let sym = String(e.target.value || '').trim().toUpperCase();
    const hit = state.market.find((x) => x.symbol === sym) || state.market.find((x) => x.symbol.startsWith(sym + '.'));
    sym = hit?.symbol || normalizeSymbol(sym);
    const p = priceOf(sym);
    if (p) $('#riPrice').value = p;
    const h = state.holdings.find((x) => x.name === sym);
    if (h) $('#riHeld').value = h.balance;
    renderRights();
  });

  $('#shareAmounts').addEventListener('change', renderShare);
  $('#shareBtn').addEventListener('click', shareNow);
  built = true;
}

function renderLive() {
  renderGoal();
  renderHealth();
  renderAspi();
  renderFd();
  renderAlerts();
  renderShare();
}

export function init() {
  // In-page jump links must not change the route hash.
  $('#view-insights .ins-jump')?.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#ins"]');
    if (!a) return;
    e.preventDefault();
    document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

export async function show() {
  if (!built) build();
  renderLive();
  renderSnow();
  renderRights();
  renderHeat();
  ensureMarketSymbols(false).catch(() => {});
}

export function hide() {
  Object.values(charts).forEach((c) => c?.destroy?.());
  Object.keys(charts).forEach((k) => delete charts[k]);
}

/** Live data changed while the tab is open (prices, sync, settings…). */
export function onData(topic) {
  if (!built) return;
  if (['prices', 'all', 'holdings', 'transactions', 'settings', 'alerts', 'watchlist'].includes(topic)) renderLive();
  if (topic === 'prices') renderHeat();
}

export default { init, show, hide, onData };
