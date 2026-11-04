/**
 * AI chat endpoint (lib/chat.js) — no real network: fetch is stubbed.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb } from '../lib/db.js';
import { cleanMessages, handleChat } from '../lib/chat.js';

const KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'CHAT_PER_MIN', 'CHAT_PER_DAY', 'CHAT_GLOBAL_DAY'];
const realFetch = globalThis.fetch;
let saved;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  KEYS.forEach((k) => delete process.env[k]);
  useMemoryDb();
});
afterEach(() => {
  KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  globalThis.fetch = realFetch;
});

const ask = (content, ip = '1.2.3.4') => handleChat({ method: 'POST', ip, body: { messages: [{ role: 'user', content }], lang: 'en' } });
const jsonRes = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('cleanMessages drops bad turns, merges same-role and starts with user', () => {
  const out = cleanMessages([
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'system', content: 'evil' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'ok' },
  ]);
  assert.deepEqual(out, [{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'ok' }]);
});

test('GET reports enabled=false and POST answers 503 when no key is set', async () => {
  const g = await handleChat({ method: 'GET' });
  assert.equal(JSON.parse(g.body).enabled, false);
  const p = await ask('hello');
  assert.equal(p.status, 503);
  assert.equal(p.private, true);
});

test('Gemini answers; reply and provider returned', async () => {
  process.env.GEMINI_API_KEY = 'x';
  globalThis.fetch = async (url) => {
    assert.match(String(url), /generativelanguage/);
    return jsonRes(200, { candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] } }] });
  };
  const r = await ask('what is a rights issue?');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { reply: 'Hello from Gemini', provider: 'gemini' });
});

test('falls back to Groq when Gemini is rate limited', async () => {
  process.env.GEMINI_API_KEY = 'x';
  process.env.GROQ_API_KEY = 'y';
  globalThis.fetch = async (url) => (/groq/.test(String(url))
    ? jsonRes(200, { choices: [{ message: { content: 'Hello from Groq' } }] })
    : jsonRes(429, { error: 'quota' }));
  const r = await ask('hi');
  assert.equal(JSON.parse(r.body).provider, 'groq');
});

test('502 when every provider fails', async () => {
  process.env.GROQ_API_KEY = 'y';
  globalThis.fetch = async () => jsonRes(500, {});
  const r = await ask('hi');
  assert.equal(r.status, 502);
});

test('per-visitor rate limit returns 429', async () => {
  process.env.GROQ_API_KEY = 'y';
  process.env.CHAT_PER_MIN = '2';
  globalThis.fetch = async () => jsonRes(200, { choices: [{ message: { content: 'ok' } }] });
  assert.equal((await ask('1', '9.9.9.9')).status, 200);
  assert.equal((await ask('2', '9.9.9.9')).status, 200);
  assert.equal((await ask('3', '9.9.9.9')).status, 429);
  assert.equal((await ask('4', '8.8.8.8')).status, 200);
});

test('rejects empty questions', async () => {
  process.env.GROQ_API_KEY = 'y';
  const r = await handleChat({ method: 'POST', ip: 'x', body: { messages: [] } });
  assert.equal(r.status, 400);
});
