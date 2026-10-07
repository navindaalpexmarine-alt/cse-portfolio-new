/**
 * Colombo Stock Exchange (CSE) API proxy.
 *
 * cse.lk does not send CORS headers, so a browser cannot call it directly.
 * This module forwards a *whitelisted* set of endpoints with validated
 * parameters, so the deployment can never be abused as an open proxy.
 *
 * Replaces the `/api/cse/*` routes of the original portfolio_server.py.
 */
import { errorResult, fetchWithTimeout, json, runHandler } from './http.js';

const CSE_BASE = 'https://www.cse.lk/api/';
const UPSTREAM_TIMEOUT_MS = 9000; // stays under Netlify's 10 s function limit

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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://www.cse.lk',
      Referer: 'https://www.cse.lk/',
      'User-Agent': 'Mozilla/5.0 (CSEPortfolio/3.0)',
      Accept: 'application/json',
    },
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

/** Main entry: params = { endpoint, ...endpointParams } */
export function handleCse(method, params) {
  return runHandler(method, params, async (p) => {
    const endpoint = String(p.endpoint || '');
    if (endpoint === 'marketOverview') return marketOverview();

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
