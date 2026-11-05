/**
 * Pure maths behind the Insights tab (no DOM) — goal planning, portfolio health,
 * time-weighted return vs ASPI, dividend snowball, rights issues and "what if".
 * Everything here is an estimate for planning, never investment advice.
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/* ---------- 🎯 Goal ---------- */

/** Whole months from `from` until `to` (YYYY-MM-DD or Date); 0 if past. */
export function monthsUntil(to, from = new Date()) {
  const t = to instanceof Date ? to : new Date(String(to || ''));
  if (Number.isNaN(t.getTime())) return 0;
  return Math.max(0, (t.getFullYear() - from.getFullYear()) * 12 + (t.getMonth() - from.getMonth()));
}

/**
 * Monthly amount to add so `now` grows to `target` in `months` at `annualPct` a year
 * (monthly compounding, deposits at month end). 0 if already enough.
 */
export function requiredMonthly(now, target, months, annualPct) {
  now = Math.max(0, Number(now) || 0);
  target = Math.max(0, Number(target) || 0);
  if (!target || months <= 0) return target > now ? target - now : 0;
  const r = (Number(annualPct) || 0) / 100 / 12;
  const growth = r ? (1 + r) ** months : 1;
  const fvNow = now * growth;
  if (fvNow >= target) return 0;
  const factor = r ? (growth - 1) / r : months;
  return (target - fvNow) / factor;
}

/** Value after `months` with a monthly deposit. */
export function projectValue(now, monthly, months, annualPct) {
  const r = (Number(annualPct) || 0) / 100 / 12;
  const g = r ? (1 + r) ** months : 1;
  return now * g + monthly * (r ? (g - 1) / r : months);
}

/* ---------- 🩺 Portfolio health ---------- */

/**
 * rows: [{ symbol, value, sector, plPct, dividend: bool }]
 * Returns { score 0-100, grade, parts:[{key,label,score,max,note}], tips:[] }.
 */
export function healthScore(rows) {
  const list = (rows || []).filter((r) => r && r.value > 0);
  const total = list.reduce((s, r) => s + r.value, 0);
  if (!list.length || !total) return { score: 0, grade: '—', parts: [], tips: ['Add shares to your portfolio to get a health check.'] };

  const n = list.length;
  const weights = list.map((r) => r.value / total).sort((a, b) => b - a);
  const top = weights[0];
  const bySector = new Map();
  for (const r of list) bySector.set(r.sector || 'Other', (bySector.get(r.sector || 'Other') || 0) + r.value / total);
  const sectors = [...bySector.entries()].sort((a, b) => b[1] - a[1]);
  const topSector = sectors[0];
  const payers = list.filter((r) => r.dividend).reduce((s, r) => s + r.value / total, 0);
  const deepLosers = list.filter((r) => r.plPct != null && r.plPct <= -25).reduce((s, r) => s + r.value / total, 0);

  const parts = [];
  const tips = [];
  // 1) Number of shares (25): 1 → 0 … 10+ → full
  const sCount = Math.round(25 * clamp((n - 1) / 9, 0, 1));
  parts.push({ key: 'count', label: 'Number of shares', score: sCount, max: 25, note: `${n} share${n === 1 ? '' : 's'}` });
  if (n < 5) tips.push(`Only ${n} share${n === 1 ? '' : 's'} — one bad result can move the whole portfolio.`);
  // 2) Biggest position (25): ≤15% full, ≥60% zero
  const sTop = Math.round(25 * clamp((0.6 - top) / 0.45, 0, 1));
  parts.push({ key: 'top', label: 'Biggest single share', score: sTop, max: 25, note: `${(top * 100).toFixed(0)}% of value` });
  if (top > 0.35) tips.push(`Your biggest share is ${(top * 100).toFixed(0)}% of the portfolio.`);
  // 3) Sector spread (25): biggest sector ≤30% full, ≥80% zero; +bonus for count
  const sSector = Math.round(25 * clamp((0.8 - topSector[1]) / 0.5, 0, 1));
  parts.push({ key: 'sector', label: 'Sector spread', score: sSector, max: 25, note: `${sectors.length} sector${sectors.length === 1 ? '' : 's'} · top: ${topSector[0]} ${(topSector[1] * 100).toFixed(0)}%` });
  if (topSector[1] > 0.5 && sectors.length > 0) tips.push(`${(topSector[1] * 100).toFixed(0)}% is in one sector (${topSector[0]}).`);
  // 4) Income (15): share of value in dividend payers
  const sIncome = Math.round(15 * clamp(payers / 0.6, 0, 1));
  parts.push({ key: 'income', label: 'Dividend payers', score: sIncome, max: 15, note: `${(payers * 100).toFixed(0)}% of value` });
  if (payers < 0.3) tips.push('Little of the portfolio pays dividends (set Avg DPS in the Dividends tab if yours do).');
  // 5) Deep losses (10): value sitting ≥25% below cost
  const sLoss = Math.round(10 * clamp(1 - deepLosers / 0.4, 0, 1));
  parts.push({ key: 'loss', label: 'Deep losses', score: sLoss, max: 10, note: `${(deepLosers * 100).toFixed(0)}% of value is 25%+ below cost` });
  if (deepLosers > 0.15) tips.push('A large part of the value is 25%+ below cost — worth reviewing why you hold it.');

  const score = parts.reduce((s, p) => s + p.score, 0);
  const grade = score >= 80 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Needs attention';
  if (!tips.length) tips.push('Well spread — keep reviewing it every few months.');
  return { score, grade, parts, tips, sectors };
}

/* ---------- 🆚 Portfolio vs ASPI ---------- */

/**
 * Time-weighted index (starts at 100) from daily snapshots [{day, mv, cost, aspi}].
 * New money (cost change) is removed so adding cash doesn't count as profit.
 * Only snapshots that also have an ASPI value are used, so both lines share dates.
 */
export function compareWithAspi(snaps) {
  const s = (snaps || []).filter((x) => x && x.day && x.mv > 0 && x.aspi > 0).sort((a, b) => a.day.localeCompare(b.day));
  if (s.length < 2) return null;
  const days = [s[0].day];
  const port = [100];
  const aspi = [100];
  let p = 100;
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1], cur = s[i];
    const flow = (cur.cost || 0) - (prev.cost || 0);
    const r = prev.mv > 0 ? (cur.mv - flow) / prev.mv - 1 : 0;
    p *= 1 + clamp(r, -0.9, 9);
    days.push(cur.day);
    port.push(p);
    aspi.push((cur.aspi / s[0].aspi) * 100);
  }
  return { days, port, aspi, portPct: port.at(-1) - 100, aspiPct: aspi.at(-1) - 100 };
}

/* ---------- ❄️ Dividend snowball ---------- */

/**
 * Yearly projection. income = value × yield; reinvest adds it back.
 * Returns [{year, value, income, totalIncome}].
 */
export function snowball({ value, yieldPct, growthPct = 0, years = 10, reinvest = true, yearlyAdd = 0 }) {
  const out = [];
  let v = Math.max(0, Number(value) || 0);
  let total = 0;
  const y = (Number(yieldPct) || 0) / 100;
  const g = (Number(growthPct) || 0) / 100;
  for (let i = 1; i <= years; i++) {
    const income = v * y;
    total += income;
    v = v * (1 + g) + (reinvest ? income : 0) + (Number(yearlyAdd) || 0);
    out.push({ year: i, value: v, income, totalIncome: total });
  }
  return out;
}

/* ---------- 🧮 Rights issue ---------- */

/**
 * Rights `b` for every `a` held at subscription price `s`, market price `p`.
 * TERP = (a·p + b·s) / (a + b). Right value = TERP − s.
 */
export function rightsIssue({ price, subPrice, held, a, b }) {
  const P = Number(price), S = Number(subPrice), A = Number(a), B = Number(b), H = Math.max(0, Number(held) || 0);
  if (!(P > 0) || !(S >= 0) || !(A > 0) || !(B > 0)) return null;
  const terp = (A * P + B * S) / (A + B);
  const entitled = Math.floor((H * B) / A);
  return {
    terp,
    rightValue: terp - S,
    entitled,
    cost: entitled * S,
    discountPct: ((P - S) / P) * 100,
    valueIfTake: (H + entitled) * terp - entitled * S,  // what your holding is worth after paying
    valueIfIgnore: H * terp,                             // if you let the rights lapse
  };
}

/* ---------- 🔁 What if ---------- */

/** Invest `amount` at `buy`, worth what at `now` after commission both ways (`ratePct`). */
export function whatIf(amount, buy, now, ratePct = 1.12) {
  const c = (Number(ratePct) || 0) / 100;
  amount = Number(amount) || 0;
  if (!(amount > 0) || !(buy > 0) || !(now > 0)) return null;
  const shares = Math.floor(amount / (buy * (1 + c)));
  const spent = shares * buy * (1 + c);
  const value = shares * now * (1 - c);
  return { shares, spent, value, pl: value - spent, plPct: spent ? ((value - spent) / spent) * 100 : 0 };
}
