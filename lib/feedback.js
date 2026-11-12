/**
 * Visitor feedback: reviews, suggestions and problem reports.
 *  - Anyone can send (signed in or guest). Rate-limited per IP and per account.
 *  - Only the site owner (ADMIN_EMAILS) can list, mark read or delete.
 *  - Never shown publicly.
 *
 * Redis keys:
 *   fb:<id>       JSON { id, kind, rating, message, email, name, userId, page, ua, at, read }
 *   fb:all        sorted set of ids (score = time)
 *   fb:unread     set of unread ids
 */
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { ApiFail, currentUser, isAdmin, requireUser, runPrivate } from './auth.js';
import { privateJson } from './http.js';

const KINDS = ['suggestion', 'problem', 'review'];
const MAX_MSG = 1500;
const KEEP = 1000; // newest items kept
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function limit(key, max, windowSec) {
  const n = await getDb().incr(`rl:${key}`, windowSec);
  if (n > max) throw new ApiFail(429, 'rate_limited', 'Thanks! You have sent a lot of feedback recently. Please try again later.');
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

async function send(req) {
  const b = req.body || {};
  if (b.website) return privateJson(200, { ok: true }); // honeypot: bots fill hidden fields
  const kind = KINDS.includes(b.kind) ? b.kind : 'suggestion';
  const message = clean(b.message, MAX_MSG);
  if (message.length < 3) throw new ApiFail(400, 'empty', 'Please write a few words.');
  const r = Number(b.rating);
  const rating = Number.isInteger(r) && r >= 1 && r <= 5 ? r : null;
  const user = await currentUser(req).catch(() => null);
  let email = clean(b.email, 120).toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw new ApiFail(400, 'bad_email', 'That email address does not look right.');
  if (user && !email) email = user.email;

  await limit(`fb-ip:${req.ip}`, 6, 3600);
  if (user) await limit(`fb-user:${user.id}`, 15, 86400);

  const db = getDb();
  const item = {
    id: randomUUID(), kind, rating, message, email,
    name: clean(user?.name || b.name, 60),
    userId: user?.id || null,
    page: clean(b.page, 40),
    ua: clean(req.headers?.['user-agent'], 160),
    at: Date.now(),
    read: false,
  };
  await db.set(`fb:${item.id}`, JSON.stringify(item));
  await db.zadd('fb:all', item.at, item.id);
  await db.sadd('fb:unread', item.id);
  // Keep storage bounded: drop the oldest beyond KEEP.
  const ids = await db.zrangebyscore('fb:all', 0, '+inf');
  if (ids.length > KEEP) {
    const old = ids.slice(0, ids.length - KEEP);
    await db.del(...old.map((id) => `fb:${id}`));
    await db.zrem('fb:all', ...old);
    await db.srem('fb:unread', ...old);
  }
  return privateJson(200, { ok: true });
}

async function owner(req) {
  const user = await requireUser(req);
  if (!isAdmin(user)) throw new ApiFail(403, 'forbidden', 'Only the site owner can do this.');
  return user;
}

async function list(req) {
  await owner(req);
  const db = getDb();
  const ids = (await db.zrangebyscore('fb:all', 0, '+inf')).reverse().slice(0, 300);
  const raw = ids.length ? await db.mget(...ids.map((id) => `fb:${id}`)) : [];
  const unread = new Set(await db.smembers('fb:unread'));
  const items = raw.map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } })
    .filter(Boolean)
    .map((it) => ({ ...it, read: !unread.has(it.id) }));
  const rated = items.filter((i) => i.rating);
  return privateJson(200, {
    ok: true,
    items,
    unread: items.filter((i) => !i.read).length,
    avgRating: rated.length ? Math.round((rated.reduce((s, i) => s + i.rating, 0) / rated.length) * 10) / 10 : null,
    ratings: rated.length,
  });
}

async function mark(req) {
  await owner(req);
  const db = getDb();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [String(req.body?.id || '')];
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!valid.length) throw new ApiFail(400, 'bad_id', 'Nothing to update.');
  if (req.body?.read === false) await db.sadd('fb:unread', ...valid); else await db.srem('fb:unread', ...valid);
  return privateJson(200, { ok: true });
}

async function remove(req) {
  await owner(req);
  const id = String(req.body?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiFail(400, 'bad_id', 'Nothing to delete.');
  const db = getDb();
  await db.zrem('fb:all', id);
  await db.del(`fb:${id}`);
  await db.srem('fb:unread', id);
  return privateJson(200, { ok: true });
}

/** Entry: /api/feedback?action=send|list|mark|delete */
export async function handleFeedback(req) {
  const action = req.params?.action;
  if (action === 'send') return runPrivate(req, ['POST'], () => send(req));
  if (action === 'list') return runPrivate(req, ['GET'], () => list(req));
  if (action === 'mark') return runPrivate(req, ['POST'], () => mark(req));
  if (action === 'delete') return runPrivate(req, ['POST'], () => remove(req));
  return privateJson(404, { error: 'not_found', message: 'Unknown action.' });
}
