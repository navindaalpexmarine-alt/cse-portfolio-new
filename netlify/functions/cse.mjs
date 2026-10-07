/**
 * Netlify Function (v2): GET /api/cse?endpoint=<name>&...
 * Thin adapter – all logic lives in lib/cse.js (shared with Vercel + dev server).
 */
import { handleCse } from '../../lib/cse.js';
import { paramsFromUrl, toResponse } from '../../lib/http.js';

export default async (req) => toResponse(await handleCse(req.method, paramsFromUrl(req.url)));

export const config = { path: '/api/cse' };
