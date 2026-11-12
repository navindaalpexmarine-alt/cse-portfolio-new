/**
 * Vercel Serverless Function: /api/feedback?action=send|list|mark|delete
 * Visitor reviews and suggestions; the owner reads them on the Users page.
 * Thin adapter – logic lives in lib/feedback.js.
 */
import { handleFeedback } from '../lib/feedback.js';
import { nodeRequest, privateJson, sendNode } from '../lib/http.js';

export default async function handler(req, res) {
  let request;
  try { request = await nodeRequest(req); } catch (err) {
    return sendNode(res, privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
  sendNode(res, await handleFeedback(request));
}
