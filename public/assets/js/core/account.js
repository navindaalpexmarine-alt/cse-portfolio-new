/**
 * Browser client for the account + portfolio endpoints (/api/auth, /api/data).
 * The session lives in an HttpOnly cookie, so JavaScript never sees the token.
 */

export class AccountError extends Error {
  constructor(code, message, status = 0, data = null) {
    super(message);
    this.code = code;     // server error code, or 'offline' | 'unavailable'
    this.status = status; // HTTP status (0 = no response)
    this.data = data;     // full response body (e.g. the server copy on 409)
  }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'cse-portfolio' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AccountError('offline', navigator.onLine ? 'Cannot reach the server. Check your connection.' : 'You are offline.');
  }
  if (!(res.headers.get('content-type') || '').includes('json')) {
    throw new AccountError('unavailable', 'The account service is not available on this host.', res.status);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AccountError(data.error || 'error', data.message || `Request failed (${res.status})`, res.status, data);
  return data;
}

const auth = (action, body) => call('POST', `api/auth?action=${action}`, body);

export const me = () => call('GET', 'api/auth?action=me');
export const register = (email, password, name) => auth('register', { email, password, name });
export const login = (email, password) => auth('login', { email, password });
export const logout = () => auth('logout', {});
export const changePassword = (current, next) => auth('change-password', { current, next });
export const newRecoveryCode = (password) => auth('recovery-code', { password });
export const resetWithRecovery = (email, code, password) => auth('reset', { email, code, password });
export const deleteAccount = (password) => auth('delete', { password });

export const getData = () => call('GET', 'api/data');
export const putData = (payload) => call('PUT', 'api/data', payload);

/** Best-effort upload while the page is closing (keepalive survives navigation). */
export function putDataKeepalive(payload) {
  const body = JSON.stringify(payload);
  if (body.length > 60000) return false; // browsers cap keepalive bodies at 64 KB
  try {
    fetch('api/data', {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cse-portfolio' },
      body,
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
