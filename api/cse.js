/**
 * Vercel Serverless Function: GET /api/cse?endpoint=<name>&...
 * Thin adapter – all logic lives in lib/cse.js (shared with Netlify + dev server).
 */
import { handleCse } from '../lib/cse.js';
import { paramsFromUrl, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  sendNode(res, await handleCse(req.method, paramsFromUrl(req.url)));
}
