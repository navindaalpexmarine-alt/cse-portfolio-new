/**
 * Settings dialog: account (sync, password, recovery code, sign out, delete),
 * connection check, auto-refresh, notifications, backup/restore, clear.
 */
import { commit, exportBackup, importBackup, resetAll, state } from '../core/store.js';
import { testApi } from '../core/api.js';
import * as account from '../core/account.js';
import * as sync from '../core/sync.js';
import { startAutoRefresh } from '../core/prices.js';
import { $, download, esc, todayISO } from '../core/utils.js';
import { alertDialog, confirmDialog, promptForm, setBusy, showRecoveryCode, toast } from '../core/ui.js';

const dlg = () => $('#settingsDialog');
const TEST_HINT = 'Checks that live CSE prices and news are reachable.';

function fill() {
  const s = state.settings;
  const u = sync.currentUser();
  $('#acctEmail').textContent = u ? (u.name ? `${u.name} (${u.email})` : u.email) : '—';
  $('#setRefresh').value = String(s.refreshSec);
  $('#setMarketHours').checked = !!s.marketHoursOnly;
  $('#setNotify').checked = !!s.notify && 'Notification' in window && Notification.permission === 'granted';
  $('#setNotify').disabled = !('Notification' in window);
  $('#testApiResult').textContent = TEST_HINT;
}

export function openSettings() {
  fill();
  dlg().showModal();
}

/** Runs an account action, showing server errors in a dialog. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    await alertDialog('Could not complete that', err.message || String(err));
    return null;
  }
}

function initAccount() {
  $('#syncNowBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true);
    if (sync.hasUnsyncedChanges()) await sync.push();
    else await sync.pull();
    setBusy(btn, false);
  });

  $('#changePwBtn').addEventListener('click', async () => {
    const v = await promptForm({
      title: 'Change password',
      fields: [
        { name: 'current', label: 'Current password', autocomplete: 'current-password' },
        { name: 'next', label: 'New password (min 8 characters)', autocomplete: 'new-password', minlength: 8 },
        { name: 'again', label: 'Repeat new password', autocomplete: 'new-password', minlength: 8 },
      ],
      submitLabel: 'Change password',
    });
    if (!v) return;
    if (v.next !== v.again) { await alertDialog('Passwords do not match', 'Please type the same new password twice.'); return; }
    if (await guarded(() => account.changePassword(v.current, v.next))) toast('Password changed ✓');
  });

  $('#newCodeBtn').addEventListener('click', async () => {
    const v = await promptForm({
      title: 'New recovery code',
      message: 'Creates a new recovery code. Your old code will stop working.',
      fields: [{ name: 'password', label: 'Your password', autocomplete: 'current-password' }],
      submitLabel: 'Create new code',
    });
    if (!v) return;
    const r = await guarded(() => account.newRecoveryCode(v.password));
    if (r) await showRecoveryCode(r.recoveryCode, sync.currentUser()?.email);
  });

  $('#signOutBtn').addEventListener('click', async () => {
    const pending = sync.hasUnsyncedChanges();
    const ok = await confirmDialog('Sign out?', pending
      ? 'Some changes have not reached your account yet. They will be uploaded first if you are online.\nThis device\'s copy is removed after signing out.'
      : 'Your portfolio stays safe in your account. This device\'s copy is removed after signing out.', { confirmLabel: 'Sign out' });
    if (ok) await sync.signOut();
  });

  $('#deleteAcctBtn').addEventListener('click', async () => {
    const v = await promptForm({
      title: 'Delete account permanently?',
      message: 'This deletes your login and your saved portfolio, dividends, transactions and history from the server. It cannot be undone.\nDownload a backup first if you may need the data.',
      fields: [{ name: 'password', label: 'Type your password to confirm', autocomplete: 'current-password' }],
      submitLabel: 'Delete my account',
      danger: true,
    });
    if (!v) return;
    if (await guarded(() => account.deleteAccount(v.password))) {
      sync.forgetLocal();
      await alertDialog('Account deleted', 'Your account and all its data have been removed.');
      location.reload();
    }
  });
}

export function initSettings() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) openSettings();
  });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#accountBtn').addEventListener('click', openSettings);
  initAccount();

  $('#testApiBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = $('#testApiResult');
    setBusy(btn, true);
    out.textContent = 'Checking…';
    try {
      const r = await testApi();
      out.innerHTML = `<span class="t-pos">✓ Connected</span> · CSE: ${esc(r.status)} · ${r.ms} ms`;
    } catch (err) {
      out.innerHTML = `<span class="t-neg">✗ ${esc(err.message)}</span>`;
    } finally {
      setBusy(btn, false);
    }
  });

  $('#setRefresh').addEventListener('change', (e) => {
    state.settings.refreshSec = Number(e.target.value) || 0;
    commit('settings');
    startAutoRefresh();
  });
  $('#setMarketHours').addEventListener('change', (e) => {
    state.settings.marketHoursOnly = e.target.checked;
    commit('settings');
  });
  $('#setNotify').addEventListener('change', async (e) => {
    const box = e.target;
    if (box.checked) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        box.checked = false;
        toast('Notifications blocked — allow them in your browser site settings', { error: true });
      }
    }
    state.settings.notify = box.checked;
    commit('settings');
  });

  /* backup / restore / clear */
  $('#backupExportBtn').addEventListener('click', () => {
    download(`cse-portfolio-backup_${todayISO()}.json`, JSON.stringify(exportBackup(), null, 2), 'application/json');
    toast('Backup downloaded ✓');
  });
  $('#backupImportBtn').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Backup file is too large (max 5 MB).');
      const obj = JSON.parse(await file.text());
      const n = obj?.data?.holdings?.length ?? 0;
      if (!(await confirmDialog('Restore this backup?', `It contains ${n} holding(s) from ${obj?.exportedAt ? new Date(obj.exportedAt).toLocaleString() : 'an unknown date'}.\nThe portfolio in your account will be replaced.`, { confirmLabel: 'Restore' }))) return;
      importBackup(obj); // saves locally and uploads to the account
      fill();
      startAutoRefresh();
      toast('Backup restored ✓');
    } catch (err) {
      await alertDialog('Could not restore backup', err.message || String(err));
    }
  });
  $('#resetBtn').addEventListener('click', async () => {
    if (!(await confirmDialog('Clear your portfolio?', 'Deletes every holding, dividend event, transaction and history snapshot from your account (your login stays).\nDownload a backup first if you may need it.', { confirmLabel: 'Clear everything', danger: true }))) return;
    resetAll();
    toast('Portfolio cleared');
  });
}
