/**
 * Vercel Serverless Function: /api/market
 * Public market close archive (/market, /market/YYYY-MM-DD, /market-sitemap.xml via rewrites in vercel.json)
 * and the owner's daily note (action=note). Thin adapter – logic lives in lib/market.js.
 */
import { handleMarket } from '../lib/market.js';
import { nodeRequest, privateJson, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  let request;
  try { request = await nodeRequest(req); } catch (err) {
    return sendNode(res, privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
  request.path = String(req.url || '').split('?')[0];
  sendNode(res, await handleMarket(request));
}
