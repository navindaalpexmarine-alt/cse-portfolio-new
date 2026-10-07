/**
 * Vercel Serverless Function: GET /api/news?kind=google|trusted|company&...
 * Thin adapter – all logic lives in lib/news.js (shared with Netlify + dev server).
 */
import { handleNews } from '../lib/news.js';
import { paramsFromUrl, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  sendNode(res, await handleNews(req.method, paramsFromUrl(req.url)));
}
