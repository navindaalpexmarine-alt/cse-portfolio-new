/**
 * Anonymous visitor counts for the owner's Users page.
 *
 *   POST /api/auth?action=visit  { id, kind: 'visit' | 'beat', signedIn }
 *     visit = the app was opened (once per browser tab session)
 *     beat  = the app is still open and visible (every 2 minutes)
 *
 * `id` is a random ID the browser makes for itself (localStorage). No names,
 * e-mails or IP addresses are stored with it.
 *
 * Keys:  stats:visits (all time)   stats:visits:<day>     – visit counters
 *        stats:uv  stats:uv:<day>                          – unique visitors (HyperLogLog)
 *        stats:live                                        – sorted set id -> last seen (ms)
 */
import { getDb } from './db.js';
import { privateJson } from './http.js';

const LIVE_MS = 3 * 60_000;      // "Live now" = seen in the last 3 minutes
const DAY_TTL = 120 * 86400;     // keep daily keys ~4 months
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

/** Sri Lanka calendar day, e.g. "2026-11-06". */
export const statDay = (t = Date.now()) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);

export async function recordVisit(req) {
  const b = req.body || {};
  const id = String(b.id || '');
  if (!ID_RE.test(id)) return privateJson(400, { error: 'bad_request', message: 'Bad visitor id.' });
  const db = getDb();
  const now = Date.now();
  const member = `${b.signedIn ? 'u' : 'g'}:${id}`;
  if (b.kind === 'visit') {
    // light abuse guard: at most 60 counted visits per IP per hour
    const n = await db.incr(`rl:visit:${req.ip}`, 3600);
    if (n <= 60) {
      const day = statDay(now);
      await Promise.all([
        db.incr('stats:visits'),
        db.incr(`stats:visits:${day}`, DAY_TTL),
        db.pfadd('stats:uv', id),
        db.pfadd(`stats:uv:${day}`, id).then(() => db.expire(`stats:uv:${day}`, DAY_TTL)),
      ]);
    }
  }
  await db.zadd('stats:live', now, member);
  return privateJson(200, { ok: true });
}

/** Totals for the owner page. */
export async function trafficSummary(now = Date.now()) {
  const db = getDb();
  await db.zremrangebyscore('stats:live', '-inf', now - LIVE_MS);
  const live = await db.zrangebyscore('stats:live', now - LIVE_MS, '+inf');
  const days = Array.from({ length: 14 }, (_, i) => statDay(now - (13 - i) * 86400_000));
  const [visitsAll, uvAll, visitsByDay, uvByDay, uv7, uv30] = await Promise.all([
    db.get('stats:visits'),
    db.pfcount('stats:uv'),
    db.mget(...days.map((d) => `stats:visits:${d}`)),
    Promise.all(days.map((d) => db.pfcount(`stats:uv:${d}`))),
    db.pfcount(...days.slice(-7).map((d) => `stats:uv:${d}`)),
    db.pfcount(...Array.from({ length: 30 }, (_, i) => `stats:uv:${statDay(now - i * 86400_000)}`)),
  ]);
  const liveIds = new Set(live.map((m) => m.slice(2)));
  const liveSignedIn = new Set(live.filter((m) => m.startsWith('u:')).map((m) => m.slice(2)));
  return {
    liveNow: liveIds.size,
    liveSignedIn: liveSignedIn.size,
    liveGuests: [...liveIds].filter((id) => !liveSignedIn.has(id)).length,
    visitorsToday: uvByDay[uvByDay.length - 1],
    visitsToday: Number(visitsByDay[visitsByDay.length - 1]) || 0,
    visitors7d: uv7,
    visitors30d: uv30,
    visitorsAllTime: uvAll,
    visitsAllTime: Number(visitsAll) || 0,
    daily: days.map((d, i) => ({ day: d, visits: Number(visitsByDay[i]) || 0, visitors: uvByDay[i] })),
  };
}
