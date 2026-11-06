/**
 * Anonymous visitor count for the site owner ("Live now", "Visitors today", "All time").
 * The browser keeps a random ID in localStorage; nothing personal is sent with it.
 * 'visit' once per tab session, then a 'beat' every 2 minutes while the app is on screen.
 */
import * as sync from './sync.js';

const KEY = 'cse_vid';
const BEAT_MS = 120_000;
let lastBeat = 0;

function visitorId() {
  try {
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    return null; // storage blocked: just don't count
  }
}

function send(kind) {
  const id = visitorId();
  if (!id) return;
  lastBeat = Date.now();
  fetch('api/auth?action=visit', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cse-portfolio' },
    body: JSON.stringify({ id, kind, signedIn: !!sync.currentUser() }),
  }).catch(() => {});
}

export function startVisits() {
  if (navigator.webdriver) return; // automated browsers/bots are not visitors
  let counted = false;
  try { counted = sessionStorage.getItem('cse_visit') === '1'; sessionStorage.setItem('cse_visit', '1'); } catch { /* ignore */ }
  send(counted ? 'beat' : 'visit');
  setInterval(() => { if (document.visibilityState === 'visible') send('beat'); }, BEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastBeat > 60_000) send('beat');
  });
}
