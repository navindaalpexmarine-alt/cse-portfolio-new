/**
 * Pure portfolio maths (no DOM). Same formulas as the original app.
 */
import { SECTOR_MAP } from '../data/reference.js';
import { round2 } from './utils.js';

/** Break-even sell price: lowest price where selling (after commission) returns the average cost. */
export function calcBes(avg, ratePct) {
  if (!avg || avg <= 0) return 0;
  const f = 1 - ratePct / 100;
  return f <= 0 ? avg : Math.ceil((avg / f) * 100) / 100;
}

/** Derived values for one holding. */
export function computeRow(h, ratePct) {
  const marketValue = (h.balance || 0) * (h.tradedPrice || 0);
  const commission = marketValue * (ratePct / 100);
  const netProceeds = marketValue - commission;
  const gainLoss = netProceeds - (h.totalCost || 0);
  const gainLossPct = h.totalCost ? (gainLoss / h.totalCost) * 100 : 0;
  const bes = h.besPrice || 0;
  let status = 'hold';
  if (bes > 0 && h.tradedPrice >= bes) status = 'sell';
  else if (bes > 0 && h.tradedPrice >= bes * 0.99) status = 'near';
  return { marketValue, netProceeds, gainLoss, gainLossPct, status };
}

export const STATUS_LABEL = { sell: 'SELL', near: 'NEAR', hold: 'WAIT' };

/** "SAMP.N0000" -> "SAMP" */
export const baseSym = (sym) => String(sym || '').split('.')[0].toUpperCase().trim();

/** "jkh" -> "JKH.N0000" (CSE ordinary voting share suffix when none given). */
export function normalizeSymbol(name) {
  let s = String(name || '').trim().toUpperCase();
  if (s && !s.includes('.') && /^[A-Z0-9]+$/.test(s)) s += '.N0000';
  return s;
}

export const sectorOf = (sym) => SECTOR_MAP[baseSym(sym)] || 'Other';

/** Coerces any stored/imported holding into a clean, fully-numeric record. */
export function sanitizeHolding(h = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    name: String(h.name || '').trim().toUpperCase().slice(0, 24),
    balance: n(h.balance),
    avgPrice: n(h.avgPrice),
    besPrice: n(h.besPrice),
    totalCost: n(h.totalCost),
    tradedPrice: n(h.tradedPrice),
    avgDps: n(h.avgDps),
    divMonth: Math.max(0, Math.min(12, Math.round(n(h.divMonth)))),
  };
}

/** Portfolio totals. */
export function totals(holdings, ratePct) {
  let cost = 0, mv = 0, gl = 0, sell = 0, near = 0;
  for (const h of holdings) {
    const c = computeRow(h, ratePct);
    cost += h.totalCost || 0;
    mv += c.marketValue;
    gl += c.gainLoss;
    if (c.status === 'sell') sell++;
    if (c.status === 'near') near++;
  }
  return { cost, mv, gl, glPct: cost ? (gl / cost) * 100 : 0, sell, near };
}

/** Recomputes cost when balance/avg change (original behaviour). */
export function syncCost(h) {
  if (h.balance > 0 && h.avgPrice > 0) h.totalCost = round2(h.balance * h.avgPrice);
}
