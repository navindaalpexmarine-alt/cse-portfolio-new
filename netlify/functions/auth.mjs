/**
 * Netlify Function (v2): /api/auth?action=...
 * Thin adapter – all logic lives in lib/auth.js (shared with Vercel + dev server).
 */
import { handleAuth } from '../../lib/auth.js';
import { privateJson, toResponse, webRequest } from '../../lib/http.js';

export default async (req, context) => {
  try {
    return toResponse(await handleAuth(await webRequest(req, context)));
  } catch (err) {
    return toResponse(privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
};

export const config = { path: '/api/auth' };
