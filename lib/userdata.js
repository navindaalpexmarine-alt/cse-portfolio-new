/**
 * Per-user portfolio storage: GET / PUT /api/data  (sign-in required).
 *
 * The whole portfolio (holdings, dividends, transactions, history, settings) is
 * one JSON document per user:  data:<userId> -> { updatedAt, clientUpdatedAt, data }
 *
 * Multi-device safety: a PUT carries `baseUpdatedAt` (the server version the
 * client last saw). If the server copy changed since then (another device
 * saved), the PUT is rejected with 409 + the server copy, and the client
 * keeps whichever edit is newer (`clientUpdatedAt`) – nothing is overwritten
 * silently.
 */
import { getDb } from './db.js';
import { privateJson } from './http.js';
import { ApiFail, requireUser, runPrivate } from './auth.js';

const MAX_DOC_BYTES = 512 * 1024;
const LIMITS = { holdings: 1000, divEvents: 2000, transactions: 20000, valueSnaps: 1000 };
const ALLOWED = ['holdings', 'divEvents', 'transactions', 'valueSnaps', 'alertSeen', 'commissionRate', 'settings'];

/** Structural validation; the browser sanitises field values again on load. */
export function validateData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ApiFail(400, 'invalid_data', 'Portfolio data must be an object.');
  const clean = {};
  for (const key of ALLOWED) if (key in d) clean[key] = d[key];
  for (const [key, max] of Object.entries(LIMITS)) {
    if (clean[key] == null) continue;
    if (!Array.isArray(clean[key])) throw new ApiFail(400, 'invalid_data', `"${key}" must be a list.`);
    if (clean[key].length > max) throw new ApiFail(413, 'too_large', `Too many ${key} (max ${max}).`);
  }
  for (const key of ['alertSeen', 'settings']) {
    if (clean[key] != null && (typeof clean[key] !== 'object' || Array.isArray(clean[key]))) delete clean[key];
  }
  if (clean.commissionRate != null && !Number.isFinite(Number(clean.commissionRate))) delete clean.commissionRate;
  const text = JSON.stringify(clean);
  if (text.length > MAX_DOC_BYTES) throw new ApiFail(413, 'too_large', 'Portfolio is too large to save (max 512 KB).');
  return clean;
}

async function read(userId) {
  const raw = await getDb().get(`data:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

export function handleData(req) {
  return runPrivate(req, ['GET', 'PUT'], async () => {
    const user = await requireUser(req);
    const stored = await read(user.id);

    if (req.method === 'GET') {
      return privateJson(200, stored || { updatedAt: 0, clientUpdatedAt: 0, data: null });
    }

    const b = req.body || {};
    const data = validateData(b.data);
    const base = Number(b.baseUpdatedAt) || 0;
    if (stored && !b.force && stored.updatedAt !== base) {
      return privateJson(409, { error: 'conflict', message: 'Changed on another device.', ...stored });
    }
    const doc = {
      updatedAt: Math.max(Date.now(), (stored?.updatedAt || 0) + 1), // strictly increasing version
      clientUpdatedAt: Number(b.clientUpdatedAt) || Date.now(),
      data,
    };
    await getDb().set(`data:${user.id}`, JSON.stringify(doc));
    return privateJson(200, { updatedAt: doc.updatedAt });
  });
}
