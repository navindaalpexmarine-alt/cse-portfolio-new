/**
 * Front-end client for the serverless proxy.
 *
 *   GET /api/cse?endpoint=tradeSummary
 *   GET /api/news?kind=trusted&q=...
 *
 * Always same-origin: on Vercel the functions in /api are served by the same
 * deployment as the website (and by scripts/dev-server.mjs locally).
 */
import { emit, state } from './store.js';

export class ApiError extends Error {
  constructor(message, kind = 'upstream') {
    super(message);
    this.kind = kind; // 'network' | 'unavailable' | 'upstream'
  }
}

function timeoutSignal(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function setLive(value) {
  if (state.live !== value) {
    state.live = value;
    emit('live');
  }
}

export function apiUrl(path, params = {}) {
  const url = new URL(path, document.baseURI);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.href;
}

async function getJson(path, params, { timeout = 25000, quiet = false } = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path, params), {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(timeout),
    });
  } catch {
    throw new ApiError(navigator.onLine ? 'Network error — API unreachable' : 'You are offline', 'network');
  }
  // An HTML 404 page for /api/* means the functions aren't deployed (e.g. a plain file server).
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    if (!quiet) setLive('down');
    throw new ApiError('Live data API is not available on this host', 'unavailable');
  }
  let data;
  try { data = await res.json(); } catch { throw new ApiError('Invalid JSON from API'); }
  if (!quiet) setLive('ok'); // the proxy itself answered
  if (!res.ok || data?.error) throw new ApiError(data?.detail || data?.error || `HTTP ${res.status}`);
  return data;
}

/** Calls a whitelisted CSE endpoint through the proxy. */
export const cse = (endpoint, params = {}) => getJson('api/cse', { endpoint, ...params });

/** News: kind = 'google' | 'trusted' | 'company'. Fan-out queries can be slow. */
export const news = (kind, params = {}) => getJson('api/news', { kind, ...params }, { timeout: 30000 });

/** Settings "Check connection": round-trips to the CSE through the proxy. */
export async function testApi() {
  const started = performance.now();
  const data = await getJson('api/cse', { endpoint: 'marketStatus' }, { timeout: 15000, quiet: true });
  return { ms: Math.round(performance.now() - started), status: data?.status || 'OK' };
}
