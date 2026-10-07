/**
 * Vercel Serverless Function: GET / PUT /api/data  – the signed-in user's portfolio.
 * Thin adapter – all logic lives in lib/userdata.js (shared with Netlify + dev server).
 */
import { handleData } from '../lib/userdata.js';
import { nodeRequest, privateJson, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  let request;
  try { request = await nodeRequest(req); } catch (err) {
    return sendNode(res, privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
  sendNode(res, await handleData(request));
}
