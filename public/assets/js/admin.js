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

function digestCell(u) {
  if (u.digestBy === 'user') return '<span class="t-muted" title="They turned it off in Settings or unsubscribed">Off · their choice</span>';
  const on = u.digest;
  return `<button type="button" class="btn ${on ? '' : 'ghost'}" data-digest-id="${esc(u.id)}" data-on="${on ? '1' : '0'}"
    aria-pressed="${on}" style="min-width:86px;padding:6px 12px">${on ? '<span class="t-pos">●</span> On' : '○ Off'}</button>`;
}

async function toggleDigest(btn) {
  const id = btn.dataset.digestId;
  const on = btn.dataset.on !== '1';
  btn.disabled = true;
  try {
    const res = await fetch('api/auth?action=digest-admin', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cse-portfolio' },
      body: JSON.stringify({ id, on }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { $('#adminStatus').textContent = data.message || `Could not change it (${res.status}).`; return; }
    const u = users.find((x) => x.id === id);
    await load(); // refreshes the table and the "Daily email on" count
    $('#adminStatus').textContent = `Daily email ${on ? 'on' : 'off'} for ${u?.email || 'this account'}.`;
  } finally {
    btn.disabled = false;
  }
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
      <td>${digestCell(u)}</td></tr>`;
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
    renderTraffic(data.traffic);
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

function renderTraffic(t) {
  if (!t) { $('#trafficSummary').innerHTML = ''; return; }
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  $('#trafficSummary').innerHTML = [
    card('<span class="t-pos">●</span> Live now', n(t.liveNow), `${n(t.liveSignedIn)} signed in · ${n(t.liveGuests)} guests`),
    card('Visitors today', n(t.visitorsToday), `${n(t.visitsToday)} visits`),
    card('Last 7 days', n(t.visitors7d), 'unique visitors'),
    card('Last 30 days', n(t.visitors30d), 'unique visitors'),
    card('All time', n(t.visitorsAllTime), `${n(t.visitsAllTime)} visits`),
  ].join('');
  const max = Math.max(1, ...t.daily.map((d) => d.visits));
  $('#trafficChart').innerHTML = t.daily.map((d) => `
    <div title="${esc(d.day)}: ${d.visitors} visitors, ${d.visits} visits" style="flex:1;height:100%;display:flex;align-items:flex-end;position:relative">
      <div style="position:absolute;bottom:0;left:0;right:0;height:${(d.visits / max) * 100}%;background:var(--gold-wash);border:1px solid var(--gold);border-radius:4px 4px 0 0"></div>
      <div style="position:relative;width:100%;height:${(d.visitors / max) * 100}%;background:var(--gold);border-radius:4px 4px 0 0;min-height:${d.visitors ? 2 : 0}px"></div>
    </div>`).join('');
  $('#trafficDays').innerHTML = t.daily.map((d, i) => `<div class="hint" style="flex:1;text-align:center;margin:0;font-size:11px">${i % 2 === 1 || i === 13 ? esc(d.day.slice(8)) : ''}</div>`).join('');
}

$('#adminSearch').addEventListener('input', render);
$('#adminRows').addEventListener('click', (e) => { const b = e.target.closest('[data-digest-id]'); if (b) toggleDigest(b); });
// keep "Live now" fresh while the page is open
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000);
$('#adminRefresh').addEventListener('click', load);
load();
