/**
 * Netlify Function (v2): GET /api/news?kind=google|trusted|company&...
 * Thin adapter – all logic lives in lib/news.js (shared with Vercel + dev server).
 */
import { handleNews } from '../../lib/news.js';
import { paramsFromUrl, toResponse } from '../../lib/http.js';

export default async (req) => toResponse(await handleNews(req.method, paramsFromUrl(req.url)));

export const config = { path: '/api/news' };
