/**
 * Charts view: value over time, gain/loss by share, allocation, sector mix,
 * concentration. Colours come from CSS tokens so both themes are correct.
 *
 * Categorical colours are assigned in a fixed order and never cycled: past
 * seven slices the remainder folds into a grey "Other" slice.
 */
import { state } from '../core/store.js';
import { computeRow, sectorOf } from '../core/finance.js';
import { $, cssVar, esc, fmt, fmtPct } from '../core/utils.js';
import { ensureChart } from '../core/loader.js';

const charts = {};
const MAX_SLICES = 7;

const seriesColors = () => Array.from({ length: 8 }, (_, i) => cssVar(`--series-${i + 1}`));

/** Top N entries + "Other" so colours never repeat. */
function foldSlices(entries) {
  const sorted = [...entries].sort((a, b) => b.value - a.value).filter((e) => e.value > 0);
  if (sorted.length <= MAX_SLICES + 1) return sorted;
  const head = sorted.slice(0, MAX_SLICES);
  const rest = sorted.slice(MAX_SLICES).reduce((s, e) => s + e.value, 0);
  return [...head, { label: `Other (${sorted.length - MAX_SLICES})`, value: rest, other: true }];
}

/** Shows a centered message over an empty chart. */
function setEmpty(canvasId, message) {
  const box = $(`#${canvasId}`).parentElement;
  let note = box.querySelector('.chart-empty');
  if (!message) { note?.remove(); return; }
  if (!note) {
    note = document.createElement('div');
    note.className = 'chart-empty';
    note.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;text-align:center;color:var(--muted);font-size:13px;padding:16px;pointer-events:none';
    box.appendChild(note);
  }
  note.textContent = message;
}

function draw(id, config) {
  charts[id]?.destroy();
  charts[id] = new window.Chart($(`#${id}`), config);
}

const moneyTip = (ctx) => ` Rs ${fmt(ctx.raw)}`;

function doughnut(id, slices) {
  const palette = seriesColors();
  const other = cssVar('--series-other');
  const total = slices.reduce((s, e) => s + e.value, 0) || 1;
  draw(id, {
    type: 'doughnut',
    data: {
      labels: slices.map((s) => s.label),
      datasets: [{
        data: slices.map((s) => s.value),
        backgroundColor: slices.map((s, i) => (s.other ? other : palette[i])),
        borderColor: cssVar('--panel'), // 2px surface gap between segments
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 10 } },
        tooltip: { callbacks: { label: (c) => ` Rs ${fmt(c.raw)} (${((c.raw / total) * 100).toFixed(1)}%)` } },
      },
    },
  });
  setEmpty(id, slices.length ? '' : 'Add holdings with a market price to see allocation.');
}

export async function render() {
  const rate = state.commissionRate;
  const rows = state.holdings.map((h) => ({ h, c: computeRow(h, rate) }));
  renderConcentration(rows);

  let Chart;
  try {
    Chart = await ensureChart();
  } catch (err) {
    ['valueChart', 'glChart', 'allocChart', 'sectorChart'].forEach((id) => setEmpty(id, err.message));
    return;
  }
  if (!Chart) return;
  const pos = cssVar('--pos'), neg = cssVar('--neg'), gold = cssVar('--gold'), muted = cssVar('--muted');

  // Value over time
  const snaps = state.valueSnaps;
  draw('valueChart', {
    type: 'line',
    data: {
      labels: snaps.map((s) => s.day.slice(5)),
      datasets: [
        { label: 'Market value', data: snaps.map((s) => s.mv), borderColor: gold, backgroundColor: cssVar('--gold-wash'), fill: true, tension: 0.2, pointRadius: snaps.length < 30 ? 3 : 0, borderWidth: 2 },
        { label: 'Total cost', data: snaps.map((s) => s.cost), borderColor: muted, borderDash: [4, 4], fill: false, tension: 0.2, pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: Rs ${fmt(c.raw)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { maxTicksLimit: 6 } } },
    },
  });
  setEmpty('valueChart', snaps.length >= 2 ? ''
    : 'Trend appears after 2+ days — one snapshot is saved each day prices update.');

  // Gain / loss by share
  draw('glChart', {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.h.name),
      datasets: [{
        data: rows.map((r) => r.c.gainLoss),
        backgroundColor: rows.map((r) => (r.c.gainLoss >= 0 ? pos : neg)),
        borderRadius: 4, maxBarThickness: 36,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.raw >= 0 ? 'Gain +' : 'Loss '}Rs ${fmt(c.raw)}` } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { maxTicksLimit: 6 } } },
    },
  });
  setEmpty('glChart', rows.length ? '' : 'No holdings yet.');

  doughnut('allocChart', foldSlices(rows.map((r) => ({ label: r.h.name, value: r.c.marketValue }))));

  const bySector = {};
  rows.forEach((r) => { const s = sectorOf(r.h.name); bySector[s] = (bySector[s] || 0) + r.c.marketValue; });
  doughnut('sectorChart', foldSlices(Object.entries(bySector).map(([label, value]) => ({ label, value }))));
}

function renderConcentration(rows) {
  const total = rows.reduce((s, r) => s + r.c.marketValue, 0) || 1;
  const ranked = rows.map((r) => ({ name: r.h.name, pct: (r.c.marketValue / total) * 100 })).sort((a, b) => b.pct - a.pct);
  const top3 = ranked.slice(0, 3);
  const top3pct = top3.reduce((s, x) => s + x.pct, 0);
  const sectors = new Set(rows.map((r) => sectorOf(r.h.name))).size;
  const warn = top3pct >= 60 && rows.length > 3;
  $('#concBox').innerHTML = `
    <div class="res-row hi"><span class="l">Top 3 concentration</span><span class="v" style="color:var(${warn ? '--warn' : '--pos'})">${fmtPct(top3pct)}</span></div>
    ${top3.map((x, i) => `<div class="res-row"><span class="l">${i + 1}. ${esc(x.name)}</span><span class="v">${fmtPct(x.pct)}</span></div>`).join('')}
    <div class="res-row"><span class="l">Sectors held</span><span class="v">${sectors}</span></div>
    ${warn ? '<div class="tip" style="margin:8px 0 0">⚠ Top 3 ≥ 60% — concentration risk ඉහළයි.</div>' : ''}`;
}

export default { render };
