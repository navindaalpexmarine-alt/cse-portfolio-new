/**
 * Vercel Serverless Function: /api/chat  (AI answers for the help chatbot)
 * Thin adapter – all logic lives in lib/chat.js (shared with Netlify + dev server).
 */
import { handleChat } from '../lib/chat.js';
import { nodeRequest, privateJson, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  let request;
  try { request = await nodeRequest(req); } catch (err) {
    return sendNode(res, privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
  sendNode(res, await handleChat(request));
}
