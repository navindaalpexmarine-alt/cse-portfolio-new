/**
 * Netlify Function (v2): GET / PUT /api/data
 * Thin adapter – all logic lives in lib/userdata.js (shared with Vercel + dev server).
 */
import { handleData } from '../../lib/userdata.js';
import { privateJson, toResponse, webRequest } from '../../lib/http.js';

export default async (req, context) => {
  try {
    return toResponse(await handleData(await webRequest(req, context)));
  } catch (err) {
    return toResponse(privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
  }
};

export const config = { path: '/api/data' };
