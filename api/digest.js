/**
 * Vercel Serverless Function: /api/digest?action=run|test|unsubscribe
 * Daily e-mail summary. `run` is called by Vercel Cron (see vercel.json "crons").
 * Thin adapter – all logic lives in lib/digest.js (shared with Netlify + dev server).
 */
import { handleDigest } from '../lib/digest.js';
import { nodeRequest, privateJson, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  let request;
  try { request = await nodeRequest(req); } catch (err) {
    return sendNode(res, privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
  sendNode(res, await handleDigest(request));
}
