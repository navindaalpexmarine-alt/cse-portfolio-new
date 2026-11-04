/**
 * Pure technical-indicator maths (no DOM) — simple moving averages, Wilder RSI,
 * period returns and a plain-language trend summary (English + Sinhala).
 * Rule-based orientation only; never a buy/sell recommendation.
 */

/** Simple moving average, aligned to the input (null until `n` values exist). */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Wilder's RSI, aligned to the input (null until `n + 1` values exist). */
export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

const last = (arr) => {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
};

/** % change over the last `bars` bars (null if not enough data). */
export function periodReturn(values, bars) {
  if (values.length <= bars) return null;
  const a = values[values.length - 1 - bars], b = values[values.length - 1];
  return a > 0 ? ((b - a) / a) * 100 : null;
}

/** Bars since SMA(fast) last crossed SMA(slow), with the direction ('up' | 'down'). */
function lastCross(fast, slow, lookback = 15) {
  for (let i = fast.length - 1; i > 0 && i >= fast.length - lookback; i--) {
    if ([fast[i], slow[i], fast[i - 1], slow[i - 1]].some((v) => v == null)) return null;
    const now = fast[i] - slow[i], before = fast[i - 1] - slow[i - 1];
    if (now > 0 && before <= 0) return { dir: 'up', barsAgo: fast.length - 1 - i };
    if (now < 0 && before >= 0) return { dir: 'down', barsAgo: fast.length - 1 - i };
  }
  return null;
}

/**
 * Everything the Technical tab shows from a list of closes (oldest → newest).
 * `unit` is 'day' (Daily chart) or 'week' (Weekly chart).
 */
export function analyze(closes, { price, unit = 'day' } = {}) {
  const v = closes.filter((x) => Number.isFinite(x) && x > 0);
  if (v.length < 15) return null;
  const p = Number(price) > 0 ? Number(price) : v[v.length - 1];
  const s20 = sma(v, 20), s50 = sma(v, 50), s200 = sma(v, 200);
  const r = rsi(v, 14);
  const ind = { sma20: last(s20), sma50: last(s50), sma200: last(s200), rsi: last(r) };

  let score = 0;
  const points = [];
  const add = (pts, en, si) => { score += pts; points.push({ en, si, tone: pts > 0 ? 'pos' : pts < 0 ? 'neg' : 'neut' }); };

  if (ind.sma50 != null) {
    if (p > ind.sma50) add(1, 'Price is above the 50-period average — short/medium trend up.', 'මිල 50-average එකට උඩින් — කෙටි/මධ්‍ය trend එක ඉහළට.');
    else add(-1, 'Price is below the 50-period average — short/medium trend down.', 'මිල 50-average එකට යටින් — කෙටි/මධ්‍ය trend එක පහළට.');
  } else if (ind.sma20 != null) {
    if (p > ind.sma20) add(1, 'Price is above the 20-period average.', 'මිල 20-average එකට උඩින්.');
    else add(-1, 'Price is below the 20-period average.', 'මිල 20-average එකට යටින්.');
  }
  if (ind.sma200 != null) {
    if (p > ind.sma200) add(1, 'Above the 200-period average — long-term trend up.', '200-average එකට උඩින් — දිගු කාලීන trend එක ඉහළට.');
    else add(-1, 'Below the 200-period average — long-term trend down.', '200-average එකට යටින් — දිගු කාලීන trend එක පහළට.');
  }
  if (ind.sma50 != null && ind.sma200 != null) {
    const cross = lastCross(s50, s200);
    if (cross?.dir === 'up') add(1, `50-average crossed ABOVE the 200-average ${cross.barsAgo} ${unit}(s) ago (“golden cross”).`, `50-average එක 200-average එකට උඩින් ගියා (${cross.barsAgo}කට කලින්) — “golden cross”.`);
    else if (cross?.dir === 'down') add(-1, `50-average crossed BELOW the 200-average ${cross.barsAgo} ${unit}(s) ago (“death cross”).`, `50-average එක 200-average එකට යටින් ගියා (${cross.barsAgo}කට කලින්) — “death cross”.`);
  }
  if (ind.rsi != null) {
    const x = ind.rsi;
    if (x >= 70) add(0, `RSI ${x.toFixed(0)} — overbought: rose fast, pullbacks are common.`, `RSI ${x.toFixed(0)} — overbought: ඉක්මනට නැග්ගා, ආපසු බහින එක සාමාන්‍යයි.`);
    else if (x <= 30) add(0, `RSI ${x.toFixed(0)} — oversold: fell fast, bounces are common.`, `RSI ${x.toFixed(0)} — oversold: ඉක්මනට බැස්සා, ආපහු නගින එක සාමාන්‍යයි.`);
    else if (x >= 50) add(0.5, `RSI ${x.toFixed(0)} — positive momentum.`, `RSI ${x.toFixed(0)} — momentum එක ධනාත්මකයි.`);
    else add(-0.5, `RSI ${x.toFixed(0)} — weak momentum.`, `RSI ${x.toFixed(0)} — momentum එක දුර්වලයි.`);
  }

  const max = (ind.sma50 != null || ind.sma20 != null ? 1 : 0) + (ind.sma200 != null ? 2 : 0) + (ind.rsi != null ? 0.5 : 0);
  let trend = 'neut';
  if (score >= Math.min(2, max * 0.6) && score > 0) trend = 'bull';
  else if (score <= -Math.min(2, max * 0.6) && score < 0) trend = 'bear';
  const label = {
    bull: { en: 'Uptrend', si: 'ඉහළට යන trend එකක්' },
    bear: { en: 'Downtrend', si: 'පහළට යන trend එකක්' },
    neut: { en: 'Sideways / mixed', si: 'පැහැදිලි trend එකක් නැහැ' },
  }[trend];

  const steps = unit === 'week' ? [['1M', 4], ['3M', 13], ['6M', 26], ['1Y', 52]] : [['1W', 5], ['1M', 21], ['3M', 63], ['6M', 126], ['1Y', 250]];
  const returns = steps.map(([k, n]) => ({ k, v: periodReturn(v, n) })).filter((x) => x.v != null);

  return { ...ind, series: { s20, s50, s200, rsi: r }, closes: v, score, trend, label, points, returns, bars: v.length };
}
