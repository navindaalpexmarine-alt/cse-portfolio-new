/**
 * Tiny key-value store used for accounts, sessions and portfolio data.
 *
 * Production (Vercel): Upstash Redis over its REST API – zero npm dependencies.
 *   Connect it in Vercel → Storage → "Upstash for Redis"; Vercel injects either
 *   KV_REST_API_URL / KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / _TOKEN.
 *
 * Local dev (npm run dev): an in-memory store persisted to .data/dev-db.json,
 *   so accounts work offline with no setup. Never used on Vercel.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export class DbNotConfigured extends Error {
  constructor() {
    super('Database not configured. In Vercel open Storage → Connect "Upstash for Redis" to this project, then redeploy.');
    this.code = 'db_not_configured';
  }
}

/* ---------- Upstash Redis (REST) ---------- */
function upstash(url, token) {
  async function cmd(...args) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Database error: ${data.error || res.status}`);
    return data.result;
  }
  return {
    get: (k) => cmd('GET', k),
    async set(k, v, { ex, nx } = {}) {
      const args = ['SET', k, v];
      if (ex) args.push('EX', ex);
      if (nx) args.push('NX');
      return (await cmd(...args)) === 'OK';
    },
    del: (...keys) => cmd('DEL', ...keys),
    sadd: (k, ...m) => cmd('SADD', k, ...m),
    srem: (k, ...m) => cmd('SREM', k, ...m),
    smembers: async (k) => (await cmd('SMEMBERS', k)) || [],
    mget: async (...keys) => (keys.length ? (await cmd('MGET', ...keys)) || [] : []),
    /** All keys matching a glob pattern (SCAN, never KEYS). */
    async scan(pattern) {
      const out = [];
      let cursor = '0';
      for (let i = 0; i < 200; i++) {
        const [next, keys] = await cmd('SCAN', cursor, 'MATCH', pattern, 'COUNT', 500);
        out.push(...keys);
        cursor = String(next);
        if (cursor === '0') break;
      }
      return out;
    },
    pfadd: (k, ...m) => cmd('PFADD', k, ...m),
    pfcount: async (...keys) => Number(await cmd('PFCOUNT', ...keys)) || 0,
    zadd: (k, score, member) => cmd('ZADD', k, score, member),
    zremrangebyscore: (k, min, max) => cmd('ZREMRANGEBYSCORE', k, min, max),
    zrem: (k, ...m) => (m.length ? cmd('ZREM', k, ...m) : 0),
    zrangebyscore: async (k, min, max) => (await cmd('ZRANGEBYSCORE', k, min, max)) || [],
    expire: (k, sec) => cmd('EXPIRE', k, sec),
    async incr(k, ex) {
      const n = await cmd('INCR', k);
      if (n === 1 && ex) await cmd('EXPIRE', k, ex);
      return n;
    },
  };
}

/* ---------- in-memory (optionally file-backed) ---------- */
const num = (v) => (v === '-inf' ? -Infinity : v === '+inf' || v === 'inf' ? Infinity : Number(v));

function memory(file) {
  const map = new Map(); // key -> { v: string, exp: ms epoch | 0 }
  let loaded = !file;
  let timer;
  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      for (const [k, e] of Object.entries(JSON.parse(await readFile(file, 'utf8')))) map.set(k, e);
    } catch { /* first run */ }
  }
  function persist() {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(Object.fromEntries(map)));
    }, 50);
  }
  const alive = (k) => {
    const e = map.get(k);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { map.delete(k); return null; }
    return e;
  };
  return {
    async get(k) { await load(); return alive(k)?.v ?? null; },
    async set(k, v, { ex, nx } = {}) {
      await load();
      if (nx && alive(k)) return false;
      map.set(k, { v: String(v), exp: ex ? Date.now() + ex * 1000 : 0 });
      persist();
      return true;
    },
    async del(...keys) { await load(); keys.forEach((k) => map.delete(k)); persist(); return keys.length; },
    async sadd(k, ...m) {
      await load();
      const set = new Set(JSON.parse(alive(k)?.v || '[]'));
      const before = set.size;
      m.forEach((x) => set.add(String(x)));
      map.set(k, { v: JSON.stringify([...set]), exp: 0 });
      persist();
      return set.size - before;
    },
    async srem(k, ...m) {
      await load();
      const set = new Set(JSON.parse(alive(k)?.v || '[]'));
      const before = set.size;
      m.forEach((x) => set.delete(String(x)));
      map.set(k, { v: JSON.stringify([...set]), exp: 0 });
      persist();
      return before - set.size;
    },
    async smembers(k) { await load(); return JSON.parse(alive(k)?.v || '[]'); },
    async mget(...keys) { await load(); return keys.map((k) => alive(k)?.v ?? null); },
    async scan(pattern) {
      await load();
      const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return [...map.keys()].filter((k) => alive(k) && re.test(k));
    },
    // HyperLogLog stand-in (exact set) and sorted sets, for visitor stats
    async pfadd(k, ...m) {
      await load();
      const e = alive(k);
      const set = new Set(JSON.parse(e?.v || '[]'));
      const before = set.size;
      m.forEach((x) => set.add(String(x)));
      map.set(k, { v: JSON.stringify([...set]), exp: e?.exp || 0 });
      persist();
      return set.size > before ? 1 : 0;
    },
    async pfcount(...keys) {
      await load();
      const u = new Set();
      keys.forEach((k) => JSON.parse(alive(k)?.v || '[]').forEach((x) => u.add(x)));
      return u.size;
    },
    async zadd(k, score, member) {
      await load();
      const e = alive(k);
      const z = JSON.parse(e?.v || '{}');
      const isNew = !(member in z);
      z[member] = Number(score);
      map.set(k, { v: JSON.stringify(z), exp: e?.exp || 0 });
      persist();
      return isNew ? 1 : 0;
    },
    async zrem(k, ...m) {
      await load();
      const e = alive(k); if (!e) return 0;
      const z = JSON.parse(e.v); let n = 0;
      for (const x of m) if (x in z) { delete z[x]; n++; }
      map.set(k, { v: JSON.stringify(z), exp: e.exp });
      persist();
      return n;
    },
    async zremrangebyscore(k, min, max) {
      await load();
      const e = alive(k); if (!e) return 0;
      const z = JSON.parse(e.v); const lo = num(min), hi = num(max); let n = 0;
      for (const [m, sc] of Object.entries(z)) if (sc >= lo && sc <= hi) { delete z[m]; n++; }
      map.set(k, { v: JSON.stringify(z), exp: e.exp });
      persist();
      return n;
    },
    async zrangebyscore(k, min, max) {
      await load();
      const z = JSON.parse(alive(k)?.v || '{}'); const lo = num(min), hi = num(max);
      return Object.entries(z).filter(([, sc]) => sc >= lo && sc <= hi).sort((a, b) => a[1] - b[1]).map(([m]) => m);
    },
    async expire(k, sec) {
      await load();
      const e = alive(k); if (!e) return 0;
      e.exp = Date.now() + sec * 1000; persist(); return 1;
    },
    async incr(k, ex) {
      await load();
      const e = alive(k);
      const n = (e ? Number(e.v) : 0) + 1;
      map.set(k, { v: String(n), exp: e?.exp || (ex ? Date.now() + ex * 1000 : 0) });
      persist();
      return n;
    },
  };
}

let instance = null;

export function getDb() {
  if (instance) return instance;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return (instance = upstash(url, token));
  // On a real deployment, silently using memory would lose everyone's data – fail loudly instead.
  if (process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) throw new DbNotConfigured();
  const file = process.env.CSE_DEV_DB_FILE || fileURLToPath(new URL('../.data/dev-db.json', import.meta.url));
  return (instance = memory(file));
}

/** Tests: fresh, non-persistent store. */
export function useMemoryDb() {
  instance = memory(null);
  return instance;
}
