/**
 * Accounts + per-user data tests (in-memory database, no network).
 * Run with:  npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb } from '../lib/db.js';
import { handleAuth } from '../lib/auth.js';
import { handleData } from '../lib/userdata.js';

beforeEach(() => useMemoryDb());

const CSRF = { 'x-requested-with': 'cse-portfolio', 'content-type': 'application/json' };
let ipSeq = 0;
function req(method, params, body, cookie, extraHeaders = {}) {
  return {
    method, params, body: body ?? null, ip: `10.0.0.${ipSeq}`, secure: true,
    headers: { ...(method === 'GET' ? {} : CSRF), ...(cookie ? { cookie } : {}), ...extraHeaders },
  };
}
const auth = (action, body, cookie, method = 'POST') => handleAuth(req(method, { action }, body, cookie));
const parse = (r) => JSON.parse(r.body);
const sessionCookie = (r) => r.cookies?.[0]?.split(';')[0];

async function signUp(email = 'navinda@example.com', password = 'correct horse 1') {
  ipSeq++;
  const r = await auth('register', { email, password, name: 'Navinda' });
  assert.equal(r.status, 201, r.body);
  return { r, cookie: sessionCookie(r), body: parse(r) };
}

test('register returns a session cookie, user and a one-time recovery code', async () => {
  const { r, body } = await signUp();
  assert.match(r.cookies[0], /^cse_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.equal(body.user.email, 'navinda@example.com');
  assert.match(body.recoveryCode, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.equal(body.user.hash, undefined, 'hash must never leave the server');
  assert.equal(r.private, true);
});

test('validation: bad e-mail, short password, duplicate account', async () => {
  assert.equal((await auth('register', { email: 'nope', password: 'longenough' })).status, 400);
  assert.equal((await auth('register', { email: 'a@b.lk', password: 'short' })).status, 400);
  await signUp('dup@example.com');
  const again = await auth('register', { email: 'DUP@example.com', password: 'whatever123' });
  assert.equal(again.status, 409);
});

test('login: wrong password and unknown e-mail give the same error; right password works', async () => {
  await signUp('user@example.com', 'right-password');
  const wrong = await auth('login', { email: 'user@example.com', password: 'wrong-password' });
  const unknown = await auth('login', { email: 'ghost@example.com', password: 'whatever' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(parse(wrong), parse(unknown));
  const ok = await auth('login', { email: 'User@Example.com', password: 'right-password' });
  assert.equal(ok.status, 200);
  assert.ok(sessionCookie(ok));
});

test('me / logout: session works, then is revoked', async () => {
  const { cookie } = await signUp();
  assert.equal(parse(await auth('me', null, cookie, 'GET')).user.email, 'navinda@example.com');
  assert.equal((await auth('logout', null, cookie)).status, 200);
  assert.equal(parse(await auth('me', null, cookie, 'GET')).user, null);
  assert.equal(parse(await auth('me', null, 'cse_session=forged', 'GET')).user, null);
});

test('CSRF: state-changing requests without the custom header are blocked', async () => {
  const r = await handleAuth({ method: 'POST', params: { action: 'login' }, body: {}, ip: 'x', secure: true, headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 403);
});

test('brute force: login attempts are rate-limited per e-mail', async () => {
  await signUp('target@example.com', 'right-password');
  let last;
  for (let i = 0; i < 11; i++) {
    ipSeq++;
    last = await auth('login', { email: 'target@example.com', password: `guess-${i}` });
  }
  assert.equal(last.status, 429);
});

test('recovery code resets the password and is rotated', async () => {
  const { body } = await signUp('forgot@example.com', 'old-password');
  const bad = await auth('reset', { email: 'forgot@example.com', code: 'AAAAA-AAAAA-AAAAA-AAAAA', password: 'new-password' });
  assert.equal(bad.status, 401);
  const ok = await auth('reset', { email: 'forgot@example.com', code: body.recoveryCode.toLowerCase().replace(/-/g, ' '), password: 'new-password' });
  assert.equal(ok.status, 200);
  assert.notEqual(parse(ok).recoveryCode, body.recoveryCode);
  assert.equal((await auth('login', { email: 'forgot@example.com', password: 'old-password' })).status, 401);
  assert.equal((await auth('login', { email: 'forgot@example.com', password: 'new-password' })).status, 200);
  // the old code no longer works
  assert.equal((await auth('reset', { email: 'forgot@example.com', code: body.recoveryCode, password: 'x-password' })).status, 401);
});

test('change password requires the current password', async () => {
  const { cookie } = await signUp('cp@example.com', 'first-password');
  assert.equal((await auth('change-password', { current: 'nope-nope', next: 'second-password' }, cookie)).status, 401);
  assert.equal((await auth('change-password', { current: 'first-password', next: 'second-password' }, cookie)).status, 200);
  assert.equal((await auth('login', { email: 'cp@example.com', password: 'second-password' })).status, 200);
});

test('portfolio data: private per user, saved and loaded', async () => {
  const a = await signUp('a@example.com');
  const b = await signUp('b@example.com');
  assert.equal((await handleData(req('GET', {}, null))).status, 401, 'anonymous blocked');

  const empty = parse(await handleData(req('GET', {}, null, a.cookie)));
  assert.equal(empty.data, null);

  const holdings = [{ name: 'SAMP.N0000', balance: 3, avgPrice: 141.57 }];
  const put = await handleData(req('PUT', {}, { data: { holdings, commissionRate: 1.12, junk: 'dropped' }, baseUpdatedAt: 0, clientUpdatedAt: 1 }, a.cookie));
  assert.equal(put.status, 200, put.body);

  const got = parse(await handleData(req('GET', {}, null, a.cookie)));
  assert.deepEqual(got.data.holdings, holdings);
  assert.equal(got.data.junk, undefined);
  assert.equal(parse(await handleData(req('GET', {}, null, b.cookie))).data, null, 'user B cannot see user A');
});

test('portfolio data: stale write from another device gets 409 with the server copy', async () => {
  const { cookie } = await signUp();
  const first = parse(await handleData(req('PUT', {}, { data: { holdings: [] }, baseUpdatedAt: 0 }, cookie)));
  await handleData(req('PUT', {}, { data: { holdings: [{ name: 'JKH.N0000' }] }, baseUpdatedAt: first.updatedAt }, cookie));
  const stale = await handleData(req('PUT', {}, { data: { holdings: [] }, baseUpdatedAt: first.updatedAt }, cookie));
  assert.equal(stale.status, 409);
  assert.equal(parse(stale).data.holdings[0].name, 'JKH.N0000');
  const forced = await handleData(req('PUT', {}, { data: { holdings: [] }, baseUpdatedAt: first.updatedAt, force: true }, cookie));
  assert.equal(forced.status, 200);
});

test('deployed without a database: clear 503 instead of silently losing data', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `import { handleAuth } from './lib/auth.js';
    const r = await handleAuth({ method: 'GET', params: { action: 'me' }, headers: {}, body: null, ip: 'x', secure: true });
    console.log(JSON.stringify({ status: r.status, error: JSON.parse(r.body).error }));`;
  const env = { ...process.env, VERCEL: '1' };
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'].forEach((k) => delete env[k]);
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.deepEqual(JSON.parse(out.stdout.trim()), { status: 503, error: 'db_not_configured' });
});

test('delete account removes login and data', async () => {
  const { cookie } = await signUp('bye@example.com', 'bye-password');
  await handleData(req('PUT', {}, { data: { holdings: [] }, baseUpdatedAt: 0 }, cookie));
  assert.equal((await auth('delete', { password: 'wrong-pass' }, cookie)).status, 401);
  assert.equal((await auth('delete', { password: 'bye-password' }, cookie)).status, 200);
  assert.equal((await auth('login', { email: 'bye@example.com', password: 'bye-password' })).status, 401);
  // e-mail can be registered again
  ipSeq++;
  assert.equal((await auth('register', { email: 'bye@example.com', password: 'new-password' })).status, 201);
});
