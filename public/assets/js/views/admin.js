/**
 * Owner-only Users page (admin.html): lists accounts from GET /api/auth?action=users.
 * The server checks the ADMIN_EMAILS env var; this page only shows what it returns.
 */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let users = [];

function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `${d} day${d > 1 ? 's' : ''} ago` : new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

function card(label, value, sub = '') {
  return `<div class="card"><div class="t-muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.06em">${label}</div>
    <div style="font:700 26px var(--font-mono);margin-top:6px">${value}</div>${sub ? `<div class="hint" style="margin-top:2px">${sub}</div>` : ''}</div>`;
}

function render() {
  const q = ($('#adminSearch').value || '').trim().toLowerCase();
  const list = q ? users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q)) : users;
  const now = Date.now();
  $('#adminRows').innerHTML = list.length ? list.map((u) => {
    const online = u.lastSeen && now - u.lastSeen < 15 * 60_000;
    return `<tr>
      <td style="text-align:left"><b>${esc(u.name || '—')}</b></td>
      <td style="text-align:left">${esc(u.email)}</td>
      <td style="text-align:left">${day(u.createdAt)}</td>
      <td style="text-align:left">${online ? '<span class="t-pos">● Active now</span>' : esc(ago(u.lastSeen))}</td>
      <td>${u.digest ? '<span class="t-pos">On</span>' : '<span class="t-muted">Off</span>'}</td></tr>`;
  }).join('') : `<tr><td colspan="5" class="t-muted" style="padding:18px">${q ? 'No match.' : 'No accounts yet.'}</td></tr>`;
}

async function load() {
  const status = $('#adminStatus');
  status.textContent = 'Loading…';
  try {
    const res = await fetch('api/auth?action=users', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { status.innerHTML = 'Please <a href="./">sign in</a> first, then open this page again.'; return; }
    if (!res.ok) { status.textContent = data.message || `Could not load (${res.status}).`; return; }
    users = data.users || [];
    $('#adminSummary').innerHTML = [
      card('Accounts', data.total),
      card('Active now', data.activeNow, 'last 15 minutes'),
      card('Active today', data.active24h, 'last 24 hours'),
      card('Active this week', data.active7d, 'last 7 days'),
      card('Daily email on', data.digest),
    ].join('');
    status.textContent = `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    render();
  } catch {
    status.textContent = 'Cannot reach the server. Check your connection.';
  }
}

$('#adminSearch').addEventListener('input', render);
$('#adminRefresh').addEventListener('click', load);
load();
