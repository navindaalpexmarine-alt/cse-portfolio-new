/**
 * Accounts: registration, sign-in, sessions, password change, recovery-code
 * reset and account deletion.
 *
 * Security model
 *  - Passwords and recovery codes: scrypt (N=2^14, r=8, p=1) with a random salt,
 *    compared in constant time. Plain text is never stored or logged.
 *  - Sessions: random 256-bit token in an HttpOnly, SameSite=Lax (Secure on HTTPS)
 *    cookie. Only its SHA-256 is stored server-side, so a database leak does not
 *    leak usable sessions. Sign-out deletes it immediately.
 *  - CSRF: every state-changing request must carry `X-Requested-With: cse-portfolio`
 *    (a custom header forces a CORS preflight, which these endpoints never approve).
 *  - Brute force: attempts are rate-limited per IP and per e-mail address.
 *  - Unknown e-mail and wrong password return the same error and take the same time.
 *
 * Keys:  user:email:<email> -> id   ·   user:<id> -> JSON   ·   sess:<sha256> -> id
 */
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DbNotConfigured, getDb } from './db.js';
import { privateJson } from './http.js';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'cse_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/* ---------- errors ---------- */

export class ApiFail extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new ApiFail(status, code, message); };

/* ---------- hashing ---------- */

export async function hashSecret(secret, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : randomBytes(16);
  const key = await scrypt(String(secret).normalize('NFKC'), salt, 64, SCRYPT);
  return { salt: salt.toString('base64'), hash: key.toString('base64') };
}

export async function verifySecret(secret, salt, hash) {
  const { hash: candidate } = await hashSecret(secret, salt);
  const a = Buffer.from(candidate, 'base64');
  const b = Buffer.from(hash, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function newRecoveryCode() {
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return chars.match(/.{5}/g).join('-'); // XXXXX-XXXXX-XXXXX-XXXXX
}
const normalizeRecovery = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------- validation ---------- */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) fail(400, 'invalid_email', 'Please enter a valid e-mail address.');
  return e;
}
function checkPassword(v) {
  const p = String(v || '');
  if (p.length < 8) fail(400, 'weak_password', 'Password must be at least 8 characters.');
  if (p.length > 200) fail(400, 'weak_password', 'Password is too long (max 200 characters).');
  return p;
}
const cleanName = (v) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);

/* ---------- rate limiting ---------- */

async function limit(key, max, windowSec) {
  const n = await getDb().incr(`rl:${key}`, windowSec);
  if (n > max) fail(429, 'rate_limited', `Too many attempts. Please wait ${Math.ceil(windowSec / 60)} minutes and try again.`);
}

/* ---------- users ---------- */

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name || '', createdAt: u.createdAt });

async function loadUser(id) {
  const raw = id ? await getDb().get(`user:${id}`) : null;
  return raw ? JSON.parse(raw) : null;
}
const saveUser = (u) => getDb().set(`user:${u.id}`, JSON.stringify(u));

/* ---------- sessions ---------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(value, maxAge, secure) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

async function createSession(userId, req) {
  const token = randomBytes(32).toString('base64url');
  await getDb().set(`sess:${sha256(token)}`, userId, { ex: SESSION_TTL });
  return cookie(token, SESSION_TTL, req.secure);
}
const clearCookie = (req) => cookie('', 0, req.secure);

/** Returns the signed-in user (or null). */
export async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const id = await getDb().get(`sess:${sha256(token)}`);
  return id ? loadUser(id) : null;
}

export async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) fail(401, 'unauthorized', 'Please sign in.');
  return user;
}

/* ---------- request wrapper for private endpoints ---------- */

export async function runPrivate(req, allowed, handler) {
  try {
    if (!allowed.includes(req.method)) fail(405, 'method_not_allowed', 'Method not allowed.');
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'cse-portfolio') {
      fail(403, 'csrf', 'Request blocked.');
    }
    return await handler();
  } catch (err) {
    if (err instanceof ApiFail) return privateJson(err.status, { error: err.code, message: err.message });
    if (err instanceof DbNotConfigured) return privateJson(503, { error: err.code, message: err.message });
    if (err?.status === 413 || err?.status === 400) return privateJson(err.status, { error: 'bad_request', message: err.message });
    console.error('[auth] unhandled', err);
    return privateJson(500, { error: 'internal_error', message: 'Something went wrong. Please try again.' });
  }
}

/* ---------- actions ---------- */

async function register(req) {
  const b = req.body || {};
  const email = cleanEmail(b.email);
  const password = checkPassword(b.password);
  await limit(`reg:${req.ip}`, 10, 3600);

  const id = randomUUID();
  // NX = only if absent: makes duplicate sign-ups impossible even under races.
  if (!(await getDb().set(`user:email:${email}`, id, { nx: true }))) {
    fail(409, 'email_taken', 'An account with this e-mail already exists. Sign in instead.');
  }
  const recoveryCode = newRecoveryCode();
  const pw = await hashSecret(password);
  const rc = await hashSecret(normalizeRecovery(recoveryCode));
  const user = { id, email, name: cleanName(b.name), salt: pw.salt, hash: pw.hash, rSalt: rc.salt, rHash: rc.hash, createdAt: Date.now() };
  await saveUser(user);
  return privateJson(201, { user: publicUser(user), recoveryCode }, [await createSession(id, req)]);
}

// Hash of a random string: compared against when the e-mail is unknown, so
// "no such user" and "wrong password" take the same time.
let dummy;
async function login(req) {
  const b = req.body || {};
  const email = cleanEmail(b.email);
  const password = String(b.password || '');
  await limit(`login-ip:${req.ip}`, 30, 900);
  await limit(`login:${email}`, 10, 900);

  const user = await loadUser(await getDb().get(`user:email:${email}`));
  dummy ||= await hashSecret(randomBytes(16).toString('hex'));
  const ok = await verifySecret(password, user?.salt || dummy.salt, user?.hash || dummy.hash);
  if (!user || !ok) fail(401, 'invalid_credentials', 'Incorrect e-mail or password.');
  await getDb().del(`rl:login:${email}`);
  return privateJson(200, { user: publicUser(user) }, [await createSession(user.id, req)]);
}

async function logout(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await getDb().del(`sess:${sha256(token)}`);
  return privateJson(200, { ok: true }, [clearCookie(req)]);
}

/** Who is signed in? `{ user: null }` (not an error) when nobody is. */
async function me(req) {
  getDb(); // throws DbNotConfigured up front, so the sign-in page can explain it
  const user = await currentUser(req);
  return privateJson(200, { user: user ? publicUser(user) : null });
}

async function changePassword(req) {
  const user = await requireUser(req);
  const b = req.body || {};
  await limit(`pw:${user.id}`, 10, 900);
  if (!(await verifySecret(String(b.current || ''), user.salt, user.hash))) fail(401, 'invalid_credentials', 'Current password is incorrect.');
  const pw = await hashSecret(checkPassword(b.next));
  await saveUser({ ...user, salt: pw.salt, hash: pw.hash });
  return privateJson(200, { ok: true });
}

async function newRecovery(req) {
  const user = await requireUser(req);
  const b = req.body || {};
  await limit(`pw:${user.id}`, 10, 900);
  if (!(await verifySecret(String(b.password || ''), user.salt, user.hash))) fail(401, 'invalid_credentials', 'Password is incorrect.');
  const recoveryCode = newRecoveryCode();
  const rc = await hashSecret(normalizeRecovery(recoveryCode));
  await saveUser({ ...user, rSalt: rc.salt, rHash: rc.hash });
  return privateJson(200, { recoveryCode });
}

/** Forgot password: e-mail + recovery code -> new password (and a fresh code). */
async function reset(req) {
  const b = req.body || {};
  const email = cleanEmail(b.email);
  const password = checkPassword(b.password);
  await limit(`reset-ip:${req.ip}`, 10, 3600);
  await limit(`reset:${email}`, 5, 3600);

  const user = await loadUser(await getDb().get(`user:email:${email}`));
  dummy ||= await hashSecret(randomBytes(16).toString('hex'));
  const ok = await verifySecret(normalizeRecovery(b.code), user?.rSalt || dummy.salt, user?.rHash || dummy.hash);
  if (!user || !ok) fail(401, 'invalid_recovery', 'E-mail or recovery code is incorrect.');

  const recoveryCode = newRecoveryCode();
  const pw = await hashSecret(password);
  const rc = await hashSecret(normalizeRecovery(recoveryCode));
  await saveUser({ ...user, salt: pw.salt, hash: pw.hash, rSalt: rc.salt, rHash: rc.hash });
  return privateJson(200, { user: publicUser(user), recoveryCode }, [await createSession(user.id, req)]);
}

async function deleteAccount(req) {
  const user = await requireUser(req);
  const b = req.body || {};
  await limit(`pw:${user.id}`, 10, 900);
  if (!(await verifySecret(String(b.password || ''), user.salt, user.hash))) fail(401, 'invalid_credentials', 'Password is incorrect.');
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  await getDb().del(`user:${user.id}`, `user:email:${user.email}`, `data:${user.id}`, ...(token ? [`sess:${sha256(token)}`] : []));
  return privateJson(200, { ok: true }, [clearCookie(req)]);
}

const ACTIONS = {
  register: ['POST', register],
  login: ['POST', login],
  logout: ['POST', logout],
  me: ['GET', me],
  'change-password': ['POST', changePassword],
  'recovery-code': ['POST', newRecovery],
  reset: ['POST', reset],
  delete: ['POST', deleteAccount],
};

/** Entry: /api/auth?action=<name> */
export function handleAuth(req) {
  const entry = ACTIONS[req.params.action];
  if (!entry) return privateJson(404, { error: 'not_found', message: 'Unknown action.' });
  const [method, fn] = entry;
  return runPrivate(req, [method], () => fn(req));
}
