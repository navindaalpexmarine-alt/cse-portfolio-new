/**
 * Netlify Function (v2): /api/chat
 * Thin adapter – all logic lives in lib/chat.js (shared with Vercel + dev server).
 */
import { handleChat } from '../../lib/chat.js';
import { privateJson, toResponse, webRequest } from '../../lib/http.js';

export default async (req, context) => {
  try {
    return toResponse(await handleChat(await webRequest(req, context)));
  } catch (err) {
    return toResponse(privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
};

export const config = { path: '/api/chat' };
