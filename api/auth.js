/**
 * Vercel Serverless Function: /api/auth?action=register|login|logout|me|change-password|recovery-code|reset|delete
 * Thin adapter – all logic lives in lib/auth.js (shared with Netlify + dev server).
 */
import { handleAuth } from '../lib/auth.js';
import { nodeRequest, privateJson, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  let request;
  try { request = await nodeRequest(req); } catch (err) {
    return sendNode(res, privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
  sendNode(res, await handleAuth(request));
}
