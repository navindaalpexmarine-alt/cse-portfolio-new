/**
 * Shared HTTP helpers for every serverless function.
 *
 * Every handler in lib/ returns a plain "result" object:
 *   { status, body: string, ttl?, contentType?, private?, cookies?: string[] }
 *
 *   private: true  -> no CORS headers + `Cache-Control: no-store` (accounts / user data)
 *   cookies        -> Set-Cookie values
 *
 * The adapters turn that object into a platform response:
 *   - toResponse()  -> Web Fetch `Response` (Netlify Functions v2)
 *   - sendNode()    -> Node `http.ServerResponse` (Vercel + local dev server)
 *
 * Keeping the logic platform-agnostic means Vercel, Netlify and the local dev
 * server all run byte-for-byte the same code.
 */

const MAX_BODY_BYTES = 700 * 1024;

export function baseHeaders(result) {
  const headers = {
    'Content-Type': result.contentType || 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
  if (result.private) {
    // Account + portfolio responses: never cached, never readable cross-origin.
    headers['Cache-Control'] = 'no-store, private';
    return headers;
  }
  const ttl = Number(result.ttl) || 0;
  // Public market data: CORS open (public, read-only). Browsers always revalidate
  // (max-age=0); the CDN edge keeps a shared copy for `ttl` seconds, turning
  // repeated refreshes into cache hits (keeps you inside free-tier limits).
  headers['Access-Control-Allow-Origin'] = '*';
  headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  headers['Cache-Control'] = ttl > 0
    ? `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`
    : 'no-store';
  return headers;
}

export function json(status, data, ttl = 0) {
  return { status, body: JSON.stringify(data), ttl };
}

/** JSON response for account/user-data endpoints. */
export function privateJson(status, data, cookies) {
  return { status, body: JSON.stringify(data), private: true, cookies };
}

export function errorResult(status, error, detail) {
  return json(status, { error, detail: detail ? String(detail).slice(0, 300) : undefined });
}

/** Query string -> plain object (first value wins). */
export function paramsFromUrl(url) {
  const out = {};
  for (const [k, v] of new URL(url, 'http://localhost').searchParams) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/* ---------- responses ---------- */

/** Web Fetch adapter (Netlify Functions v2). */
export async function toResponse(result) {
  const headers = new Headers(baseHeaders(result));
  for (const c of result.cookies || []) headers.append('Set-Cookie', c);
  return new Response(result.status === 204 ? null : result.body, { status: result.status, headers });
}

/** Node adapter (Vercel Node runtime + scripts/dev-server.mjs). */
export function sendNode(res, result) {
  const headers = baseHeaders(result);
  if (result.cookies?.length) headers['Set-Cookie'] = result.cookies;
  res.writeHead(result.status, headers);
  res.end(result.status === 204 ? undefined : result.body);
}

/* ---------- requests (normalised for account endpoints) ---------- */

function parseBody(raw, type) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw; // already parsed (Vercel)
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { status: 413 });
  if (!/json/i.test(type || '')) return null;
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function clientIp(get) {
  return (get('x-forwarded-for') || '').split(',')[0].trim() || get('x-real-ip') || 'unknown';
}

/** Node IncomingMessage (Vercel / dev server) -> normalised request. */
export async function nodeRequest(req) {
  const get = (h) => req.headers[h] || '';
  let raw;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Vercel pre-parses JSON bodies onto req.body; the dev server does not.
    let parsed;
    try { parsed = req.body; } catch { parsed = undefined; }
    if (parsed !== undefined) raw = parsed;
    else {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { status: 413 });
        chunks.push(c);
      }
      raw = Buffer.concat(chunks);
    }
  }
  return {
    method: req.method,
    headers: req.headers,
    params: paramsFromUrl(req.url),
    body: parseBody(raw, get('content-type')),
    ip: clientIp(get) !== 'unknown' ? clientIp(get) : req.socket?.remoteAddress || 'unknown',
    secure: /https/i.test(get('x-forwarded-proto')) || !!process.env.VERCEL,
  };
}

/** Web Request (Netlify) -> normalised request. */
export async function webRequest(req, context = {}) {
  const get = (h) => req.headers.get(h) || '';
  const raw = req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : null;
  return {
    method: req.method,
    headers: Object.fromEntries(req.headers),
    params: paramsFromUrl(req.url),
    body: parseBody(raw, get('content-type')),
    ip: context.ip || clientIp(get),
    secure: new URL(req.url).protocol === 'https:',
  };
}

/* ---------- wrappers ---------- */

/** Public GET-only handlers (market data). */
export async function runHandler(method, params, handler) {
  if (method === 'OPTIONS') return { status: 204, body: '' };
  if (method !== 'GET' && method !== 'HEAD') {
    return errorResult(405, 'method_not_allowed', 'Use GET');
  }
  try {
    return await handler(params);
  } catch (err) {
    console.error('[api] unhandled', err);
    return errorResult(500, 'internal_error', err?.message || err);
  }
}

/** fetch() with a hard timeout. Node 18.17+ provides AbortSignal.timeout. */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}
