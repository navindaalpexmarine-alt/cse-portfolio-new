/**
 * AI answers for the help chatbot — FREE tiers first.
 *
 *   POST /api/chat   { messages: [{role:'user'|'assistant', content}], context?: string, lang?: string }
 *   GET  /api/chat   -> { enabled: boolean }   (lets the browser know whether AI is set up)
 *
 * Providers are tried in this order, using whichever API keys exist:
 *   1. Google Gemini   GEMINI_API_KEY   (free tier, no card — get it at aistudio.google.com)
 *   2. Groq            GROQ_API_KEY     (free tier, no card — console.groq.com)
 *   3. Anthropic       ANTHROPIC_API_KEY (paid, optional)
 * If one is over its limit or down, the next one answers.
 *
 * Optional env: GEMINI_MODEL, GROQ_MODEL, ANTHROPIC_MODEL,
 *               CHAT_PER_MIN (default 6), CHAT_PER_DAY (default 60) per visitor,
 *               CHAT_GLOBAL_DAY (default 900) for the whole site, to stay inside free quotas.
 */
import { getDb } from './db.js';
import { fetchWithTimeout, privateJson } from './http.js';

const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_MSG_CHARS = 1500;
const MAX_CONTEXT_CHARS = 3500;
const MAX_TURNS = 10;

const SYSTEM = `You are the help assistant inside "CSE Portfolio", a free web app for Colombo Stock Exchange (CSE, Sri Lanka) investors.
App tabs: Portfolio (holdings, B.E.S = break-even sell price after commission, SELL/NEAR/WAIT signals), Calculator (buy/sell with commission), Dividends, Charts, History (transactions, realized P/L), News, Fundamentals, Technical. Guides are in the footer. Signing in only syncs data across devices. Keyboard: 1-8 tabs, R refresh prices, / search, T theme.
Signals: SELL = price >= B.E.S, NEAR = within 1% below B.E.S, WAIT = below that.
Rules:
- Answer in the language/style requested in "Reply language" (English, Sinhala, Sinhala-English mix/Singlish, or Tamil). Match the user's style.
- Be short and clear: at most about 120 words. Plain text; you may use **bold** and simple "• " bullets. No tables, no headings.
- NEVER tell the user to buy or sell a specific share and never predict prices. If asked, say it is not investment advice and suggest a licensed investment adviser or their broker; you may explain neutral facts and how to evaluate.
- Use only numbers that appear in the app context. If a current figure is not given, say you don't have it and point to the right tab or cse.lk. Do not invent prices, dividends, dates or company facts.
- General finance/education questions (what is a rights issue, how CDS works, how dividends are taxed in general terms) are fine — keep them general and suggest confirming with official sources for exact current rules.
- If the question has nothing to do with investing or the app, answer very briefly and politely steer back.`;

/* ---------- small helpers ---------- */
const envInt = (name, def) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

function providers() {
  const list = [];
  if (process.env.GEMINI_API_KEY) list.push({ name: 'gemini', call: callGemini });
  if (process.env.GROQ_API_KEY) list.push({ name: 'groq', call: callGroq });
  if (process.env.ANTHROPIC_API_KEY) list.push({ name: 'anthropic', call: callAnthropic });
  return list;
}

/** Keeps only valid turns, merges same-role neighbours, starts with a user turn. */
export function cleanMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list.slice(-MAX_TURNS) : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, MAX_MSG_CHARS).trim();
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n${content}`.slice(-MAX_MSG_CHARS * 2);
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const LANGS = { en: 'English', si: 'Sinhala (සිංහල)', mix: 'Sinhala-English mix (Singlish), like the user', ta: 'Tamil (தமிழ்)' };

function systemPrompt(context, lang) {
  const parts = [SYSTEM, `Reply language: ${LANGS[lang] || 'same as the user'}.`];
  if (context) parts.push(`App context (live data from the user's screen; may be partial):\n${context}`);
  return parts.join('\n\n');
}

class UpstreamError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/* ---------- providers ---------- */
/** Reads a short error reason from an upstream response (for the Vercel logs). */
async function reason(res) {
  try {
    const d = await res.json();
    return String(d?.error?.message || d?.error || '').slice(0, 200);
  } catch { return ''; }
}

const GEMINI_MODELS = () => [...new Set([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'].filter(Boolean))];

async function callGemini(system, messages) {
  let lastErr;
  // Try the configured model first, then fall back if Google renamed/retired it (404/400).
  for (const model of GEMINI_MODELS()) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    }, UPSTREAM_TIMEOUT_MS);
    if (!res.ok) {
      lastErr = new UpstreamError(`gemini ${model} ${res.status} ${await reason(res)}`, res.status);
      if (res.status === 404 || res.status === 400) continue; // unknown model → try the next one
      throw lastErr; // 401/403 (bad key), 429 (quota), 5xx → stop here
    }
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text).join('').trim();
    if (!text) throw new UpstreamError(`gemini ${model} empty (${data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'no text'})`, 502);
    return text;
  }
  throw lastErr || new UpstreamError('gemini failed', 502);
}

async function callGroq(system, messages) {
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.4,
    max_tokens: 1024,
  };
  if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';
  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
  }, UPSTREAM_TIMEOUT_MS);
  if (!res.ok) throw new UpstreamError(`groq ${res.status} ${await reason(res)}`, res.status);
  const data = await res.json();
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new UpstreamError('groq empty', 502);
  return text;
}

async function callAnthropic(system, messages) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      max_tokens: 600,
      system,
      messages,
    }),
  }, UPSTREAM_TIMEOUT_MS);
  if (!res.ok) throw new UpstreamError(`anthropic ${res.status} ${await reason(res)}`, res.status);
  const data = await res.json();
  const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new UpstreamError('anthropic empty', 502);
  return text;
}

/* ---------- rate limits (Upstash when available, memory otherwise) ---------- */
const memCounters = new Map();
async function bump(key, windowSec) {
  try {
    return await getDb().incr(`rl:chat:${key}`, windowSec);
  } catch {
    const now = Date.now();
    const c = memCounters.get(key);
    if (!c || c.exp < now) {
      memCounters.set(key, { n: 1, exp: now + windowSec * 1000 });
      return 1;
    }
    c.n += 1;
    return c.n;
  }
}

async function overLimit(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const [perMin, perDay, global] = await Promise.all([
    bump(`m:${ip}`, 60),
    bump(`d:${day}:${ip}`, 86400),
    bump(`g:${day}`, 86400),
  ]);
  if (perMin > envInt('CHAT_PER_MIN', 6)) return 'minute';
  if (perDay > envInt('CHAT_PER_DAY', 60)) return 'day';
  if (global > envInt('CHAT_GLOBAL_DAY', 900)) return 'site';
  return null;
}

/* ---------- main entry ---------- */
/** request = normalised request from lib/http.js (method, body, ip) */
export async function handleChat(request) {
  const list = providers();
  if (request.method === 'GET') return privateJson(200, { enabled: list.length > 0 });
  if (request.method !== 'POST') return privateJson(405, { error: 'method_not_allowed' });
  if (!list.length) return privateJson(503, { error: 'not_configured', message: 'AI is not set up on this site.' });

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const messages = cleanMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return privateJson(400, { error: 'bad_request', message: 'No question.' });
  }

  const limited = await overLimit(request.ip || 'unknown');
  if (limited) return privateJson(429, { error: 'rate_limited', scope: limited });

  const context = typeof body.context === 'string' ? body.context.slice(0, MAX_CONTEXT_CHARS) : '';
  const lang = typeof body.lang === 'string' ? body.lang.slice(0, 8) : '';
  const system = systemPrompt(context, lang);

  for (const p of list) {
    try {
      const reply = (await p.call(system, messages)).slice(0, 4000);
      return privateJson(200, { reply, provider: p.name });
    } catch (err) {
      console.warn(`[chat] ${p.name} failed:`, err?.message || err);
    }
  }
  return privateJson(502, { error: 'upstream_failed', message: 'AI is busy right now. Please try again later.' });
}
