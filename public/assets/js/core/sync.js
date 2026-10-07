/**
 * Keeps the signed-in user's portfolio in sync with their account.
 *
 *  - Every local save is uploaded shortly after (debounced).
 *  - Offline? Changes stay in this browser, marked "dirty", and upload when
 *    the connection returns (or on next sign-in).
 *  - Coming back to the tab/window pulls newer changes made on other devices.
 *  - Both devices edited before syncing? The server answers 409 with its copy
 *    and the user chooses which version to keep (nothing is replaced silently).
 */
import * as api from './account.js';
import {
  ACCOUNT_KEYS, clearLocalData, hasLegacyLocalData, load, readRaw, replaceData,
  setAfterSave, setSaveStatus, snapshotData, writeRaw,
} from './store.js';
import { choose, toast } from './ui.js';
import { $ } from './utils.js';

const PUSH_DELAY_MS = 1200;
let user = null;
let timer = null;
let pushing = null;
let again = false;

/* ---------- small persisted metadata ---------- */
function meta() {
  try { return JSON.parse(readRaw(ACCOUNT_KEYS.syncMeta) || '{}'); } catch { return {}; }
}
const setMeta = (patch) => writeRaw(ACCOUNT_KEYS.syncMeta, JSON.stringify({ ...meta(), ...patch }));

export function cachedAccount() {
  try { return JSON.parse(readRaw(ACCOUNT_KEYS.account) || 'null'); } catch { return null; }
}
export const currentUser = () => user;
export const hasUnsyncedChanges = () => !!meta().dirty;

/* ---------- status display ---------- */
const STATUS_TEXT = {
  ok: 'Saved to your account ✓',
  pending: 'Saving to your account…',
  offline: 'Offline — saved on this device, will sync when online',
  error: 'Not synced',
};
function status(kind, detail = '') {
  const text = detail ? `${STATUS_TEXT[kind]} — ${detail}` : STATUS_TEXT[kind];
  const btn = $('#accountBtn');
  if (btn) {
    btn.dataset.sync = kind;
    btn.title = `${user?.email || ''}\n${text}`;
  }
  const s = $('#syncState');
  if (s) s.textContent = text;
  setSaveStatus(text, kind === 'pending');
}

/* ---------- upload ---------- */
function schedule() {
  if (!user) return;
  setMeta({ dirty: true, localUpdatedAt: Date.now() });
  clearTimeout(timer);
  if (!navigator.onLine) { status('offline'); return; }
  status('pending');
  timer = setTimeout(() => push(), PUSH_DELAY_MS);
}

export function push({ force = false } = {}) {
  if (!user) return Promise.resolve();
  if (pushing) { again = true; return pushing; }
  pushing = (async () => {
    const m = meta();
    status('pending');
    try {
      const r = await api.putData({
        data: snapshotData(),
        baseUpdatedAt: m.baseUpdatedAt || 0,
        clientUpdatedAt: m.localUpdatedAt || Date.now(),
        force,
      });
      // Only clear "dirty" if nothing changed while the upload was in flight.
      setMeta({ baseUpdatedAt: r.updatedAt, dirty: meta().localUpdatedAt !== m.localUpdatedAt });
      status('ok');
    } catch (e) {
      if (e.status === 409 && e.data) {
        // Both this device and another one changed the portfolio since the last
        // sync. The portfolio is one document, so let the user pick which to keep
        // (default if dismissed: the most recent edit).
        const server = e.data;
        const localNewer = (m.localUpdatedAt || 0) > (server.clientUpdatedAt || 0);
        const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown time');
        const pick = await choose({
          title: 'Portfolio changed on another device',
          message: `Another device saved changes at ${when(server.clientUpdatedAt)}.\nThis device has changes from ${when(m.localUpdatedAt)}.\n\nWhich version do you want to keep? The other one will be replaced.`,
          choices: [
            { value: 'server', label: "Use other device's", kind: localNewer ? 'ghost' : 'primary' },
            { value: 'local', label: "Keep this device's", kind: localNewer ? 'primary' : 'ghost' },
          ],
        });
        if ((pick || (localNewer ? 'local' : 'server')) === 'local') {
          setMeta({ baseUpdatedAt: server.updatedAt }); // rebase, then upload again
          again = true;
        } else {
          replaceData(server.data);
          setMeta({ baseUpdatedAt: server.updatedAt, localUpdatedAt: server.clientUpdatedAt, dirty: false });
          status('ok');
          toast('Loaded the version from your other device');
        }
      } else if (e.code === 'offline') {
        status('offline');
      } else if (e.status === 401) {
        status('error', 'session expired');
        toast('Your session expired — please sign in again. Your changes are kept.', { error: true, ms: 5000 });
        setTimeout(() => location.reload(), 2500);
      } else {
        status('error', e.message);
      }
    } finally {
      pushing = null;
      if (again) { again = false; push(); }
    }
  })();
  return pushing;
}

/** Pulls changes made on another device (called when the tab becomes visible). */
export async function pull() {
  if (!user || pushing || meta().dirty || !navigator.onLine) return;
  try {
    const remote = await api.getData();
    if (remote.data && remote.updatedAt > (meta().baseUpdatedAt || 0)) {
      replaceData(remote.data);
      setMeta({ baseUpdatedAt: remote.updatedAt, localUpdatedAt: remote.clientUpdatedAt, dirty: false });
      toast('Updated with changes from your other device');
    }
    status('ok');
  } catch (e) {
    if (e.code === 'offline') status('offline');
  }
}

/** Last-chance upload when the page is hidden/closed. */
export function flush() {
  if (!user || !meta().dirty) return;
  clearTimeout(timer);
  const m = meta();
  api.putDataKeepalive({ data: snapshotData(), baseUpdatedAt: m.baseUpdatedAt || 0, clientUpdatedAt: m.localUpdatedAt || Date.now() });
}

/* ---------- session start ---------- */

function rememberUser(u) {
  user = { id: u.id, email: u.email, name: u.name || '' };
  writeRaw(ACCOUNT_KEYS.account, JSON.stringify(user));
  setAfterSave(schedule);
}

/**
 * Prepares local data for `u` before the app boots:
 * account data wins, unsynced offline edits are uploaded, and data saved in
 * this browser before accounts existed can be imported once.
 */
export async function startSession(u, { offline = false } = {}) {
  const cached = cachedAccount();
  if (cached && cached.id !== u.id) clearLocalData(); // different person on this device
  const legacy = !cached && hasLegacyLocalData();
  const sameUserCache = cached?.id === u.id;
  rememberUser(u);

  if (offline) { status('offline'); return; }

  const remote = await api.getData();
  const m = meta();

  if (sameUserCache && m.dirty) {
    load();               // keep the offline edits in memory…
    await push();         // …and upload them (409 -> newer wins)
    return;
  }

  if (legacy) {
    const hasRemote = !!remote.data;
    const pick = await choose({
      title: hasRemote ? 'Portfolio found in this browser' : 'Import your existing portfolio?',
      message: hasRemote
        ? 'Your account already has a saved portfolio, and this browser also has one from before you signed in.\nWhich one do you want to keep?'
        : 'This browser has a portfolio saved before you had an account.\nImport it into your account so it is saved online and on all your devices?',
      choices: hasRemote
        ? [{ value: 'browser', label: "Use this browser's", kind: 'ghost' }, { value: 'account', label: 'Keep account data', kind: 'primary' }]
        : [{ value: 'skip', label: 'Start empty', kind: 'ghost' }, { value: 'browser', label: 'Import', kind: 'primary' }],
    });
    if (pick === 'browser') {
      load();
      setMeta({ baseUpdatedAt: remote.updatedAt || 0, localUpdatedAt: Date.now(), dirty: true });
      await push({ force: true });
      toast('Portfolio imported into your account ✓');
      return;
    }
  }

  if (remote.data) {
    replaceData(remote.data, { notify: false });
    setMeta({ baseUpdatedAt: remote.updatedAt, localUpdatedAt: remote.clientUpdatedAt, dirty: false });
  } else {
    replaceData({}, { notify: false });
    setMeta({ baseUpdatedAt: 0, localUpdatedAt: 0, dirty: false });
  }
  status('ok');
}

/** Upload pending changes, end the session and wipe this browser's copy. */
export async function signOut() {
  if (meta().dirty) { try { await push(); } catch { /* best effort */ } }
  try { await api.logout(); } catch { /* still sign out locally */ }
  user = null;
  setAfterSave(null);
  clearLocalData();
  location.reload();
}

/** After the account was deleted on the server. */
export function forgetLocal() {
  user = null;
  setAfterSave(null);
  clearLocalData();
}

window.addEventListener('online', () => { if (user && meta().dirty) push(); });

// Returning to this window (e.g. after using the phone) picks up changes made
// elsewhere, so simultaneous edits – and the conflict question – stay rare.
let lastFocusPull = 0;
window.addEventListener('focus', () => {
  if (Date.now() - lastFocusPull < 15000) return;
  lastFocusPull = Date.now();
  pull();
});
