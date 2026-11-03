/**
 * Colombo Stock Exchange (CSE) API proxy.
 *
 * cse.lk does not send CORS headers, so a browser cannot call it directly.
 * This module forwards a *whitelisted* set of endpoints with validated
 * parameters, so the deployment can never be abused as an open proxy.
 *
 * Replaces the `/api/cse/*` routes of the original portfolio_server.py.
 *
 * Virtual endpoints (built here, not forwarded 1:1):
 *   marketOverview – ASPI + S&P SL20 + market status + summary in one call
 *   cashDividends  – CSE /api/smd "CASH DIVIDEND" list, with DPS, XD, record & payment dates
 */
import { errorResult, fetchWithTimeout, json, runHandler } from './http.js';

const CSE_BASE = 'https://www.cse.lk/api/';
const UPSTREAM_TIMEOUT_MS = 9000; // stays under Netlify's 10 s function limit

const CSE_HEADERS = {
  Origin: 'https://www.cse.lk',
  Referer: 'https://www.cse.lk/',
  'User-Agent': 'Mozilla/5.0 (CSEPortfolio/3.0)',
  Accept: 'application/json',
};

/* Parameter validators: each returns the cleaned value or null if invalid. */
const VALIDATORS = {
  symbol: (v) => {
    const s = String(v || '').trim().toUpperCase();
    return /^[A-Z0-9]{1,12}(\.[A-Z0-9]{1,6})?$/.test(s) ? s : null;
  },
  stockId: (v) => (/^\d{1,8}$/.test(String(v || '')) ? String(v) : null),
  period: (v) => (/^[1-5]$/.test(String(v || '')) ? String(v) : null),
};

/**
 * Endpoint whitelist.
 *   ttl    – seconds the CDN may cache the response
 *   params – required parameters (validated with VALIDATORS)
 */
export const CSE_ENDPOINTS = {
  tradeSummary:             { ttl: 30 },
  marketStatus:             { ttl: 30 },
  aspiData:                 { ttl: 30 },
  snpData:                  { ttl: 30 },
  marketSummery:            { ttl: 30 },
  topGainers:               { ttl: 60 },
  topLooses:                { ttl: 60 },
  mostActiveTrades:         { ttl: 60 },
  getFinancialAnnouncement: { ttl: 300 },
  approvedAnnouncement:     { ttl: 300 },
  companyInfoSummery:       { ttl: 60,  params: ['symbol'] },
  companyProfile:           { ttl: 300, params: ['symbol'] },
  companyChartDataByStock:  { ttl: 120, params: ['stockId', 'period'] },
};

/** Validates params for an endpoint. Returns { form } or { error }. */
export function buildForm(endpoint, raw = {}) {
  const spec = CSE_ENDPOINTS[endpoint];
  if (!spec) return { error: `Unknown endpoint "${endpoint}"` };
  const form = {};
  for (const name of spec.params || []) {
    const clean = VALIDATORS[name](raw[name]);
    if (clean == null) return { error: `Invalid or missing "${name}"` };
    form[name] = clean;
  }
  return { form };
}

/** POSTs to cse.lk exactly like the browser on cse.lk does. Returns raw text. */
export async function csePost(endpoint, form = {}) {
  const res = await fetchWithTimeout(CSE_BASE + endpoint, {
    method: 'POST',
    headers: { ...CSE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  }, UPSTREAM_TIMEOUT_MS);
  if (!res.ok) throw new Error(`CSE responded ${res.status}`);
  const text = await res.text();
  // Guard against HTML error pages being passed through as "JSON".
  JSON.parse(text);
  return text;
}

/**
 * Virtual endpoint: ASPI + S&P SL20 + market status + summary in ONE request,
 * so the header ticker costs a single function invocation.
 */
async function marketOverview() {
  const parts = ['aspiData', 'snpData', 'marketStatus', 'marketSummery'];
  const settled = await Promise.allSettled(parts.map((p) => csePost(p)));
  const out = {};
  settled.forEach((r, i) => {
    out[parts[i]] = r.status === 'fulfilled' ? JSON.parse(r.value) : null;
  });
  if (Object.values(out).every((v) => v == null)) {
    return errorResult(502, 'proxy_failed', 'All market endpoints failed');
  }
  return json(200, out, 30);
}

/* ---------------------------------------------------------------------
 * Cash dividends (CSE /api/smd)
 * ------------------------------------------------------------------- */

const SMD_QUERY = { allCategories: false, allCompanies: true, categories: ['CASH DIVIDEND'] };

/** Return the first non-empty value among several possible field names. */
function firstOf(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/**
 * CSE has changed response shapes before, so don't trust one exact path.
 * Finds the cash-dividend array and renames fields to what dividends.js reads.
 */
function extractCashDividends(data) {
  const root = data?.Announcement || data?.announcement || data || {};
  let list =
    root['CASH DIVIDEND'] ||
    root.cashDividend ||
    root.cashDividends ||
    (Array.isArray(data) ? data : null);

  // Last resort: first array of objects found in the response.
  if (!Array.isArray(list)) {
    list = Object.values(root).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object') || [];
  }

  return list
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      ...r, // keep every original field (dividends.js also scans these)
      symbol: firstOf(r, ['symbol', 'securitySymbol', 'stockSymbol']) || '',
      company: firstOf(r, ['company', 'companyName', 'name']) || '',
      votingDivPerShare: firstOf(r, ['votingDivPerShare', 'votingDividendPerShare', 'divPerShare', 'dividendPerShare', 'dps', 'rate']),
      nonVotingDivPerShare: firstOf(r, ['nonVotingDivPerShare', 'nonVotingDividendPerShare']),
      xd: firstOf(r, ['xd', 'xdDate', 'exDate']) || '',
      recordDate: firstOf(r, ['recordDate', 'record']) || '',
      payment: firstOf(r, ['payment', 'paymentDate', 'dateOfPayment']) || '',
      dateOfAnnouncement: firstOf(r, ['dateOfAnnouncement', 'announcementDate', 'createdDate']) || '',
    }));
}

/** POST to /api/smd. Tries a JSON body first, then a form body (CSE accepts one or the other). */
async function fetchSmd() {
  const attempts = [
    { 'Content-Type': 'application/json', body: JSON.stringify(SMD_QUERY) },
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        allCategories: 'false',
        allCompanies: 'true',
        categories: 'CASH DIVIDEND',
      }).toString(),
    },
  ];
  // Both attempts share ONE time budget so the function never exceeds the
  // hosting limit (~10 s on Netlify / Vercel hobby plans).
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
  let lastErr;
  for (const a of attempts) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break; // not enough time left for a second try
    try {
      const res = await fetchWithTimeout(CSE_BASE + 'smd', {
        method: 'POST',
        headers: { ...CSE_HEADERS, 'Content-Type': a['Content-Type'] },
        body: a.body,
      }, remaining);
      if (!res.ok) throw new Error(`CSE smd responded ${res.status}`);
      const data = JSON.parse(await res.text()); // throws on HTML error pages
      const list = extractCashDividends(data);
      if (list.length) return list;
      lastErr = new Error('CSE smd returned no cash dividends');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('CSE smd failed');
}

/** Virtual endpoint: official cash-dividend list with DPS. */
async function cashDividends() {
  try {
    const list = await fetchSmd();
    return json(200, {
      cashDividends: list,
      count: list.length,
      // Field names CSE actually sent — handy for debugging, tiny payload.
      sampleKeys: list[0] ? Object.keys(list[0]) : [],
    }, 300);
  } catch (err) {
    console.warn('[cse] cashDividends failed:', err?.message || err);
    return errorResult(502, 'proxy_failed', err?.message || err);
  }
}

/* ---------------------------------------------------------------------
 * Main entry
 * ------------------------------------------------------------------- */

/** Virtual endpoints are handled here and never forwarded 1:1 to cse.lk. */
const VIRTUAL = { marketOverview, cashDividends };

/** Main entry: params = { endpoint, ...endpointParams } */
export function handleCse(method, params) {
  return runHandler(method, params, async (p) => {
    const endpoint = String(p.endpoint || '');
    if (Object.prototype.hasOwnProperty.call(VIRTUAL, endpoint)) return VIRTUAL[endpoint]();

    const { form, error } = buildForm(endpoint, p);
    if (error) return errorResult(400, 'bad_request', error);
    try {
      const body = await csePost(endpoint, form);
      return { status: 200, body, ttl: CSE_ENDPOINTS[endpoint].ttl };
    } catch (err) {
      console.warn(`[cse] ${endpoint} failed:`, err?.message || err);
      return errorResult(502, 'proxy_failed', err?.message || err);
    }
  });
}
