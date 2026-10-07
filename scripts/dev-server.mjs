#!/usr/bin/env node
/**
 * Zero-dependency local dev server (Node 18.17+).
 *
 *   npm run dev            -> http://127.0.0.1:8765
 *   PORT=3000 npm run dev  -> custom port
 *
 * Serves ./public and runs the SAME /api handlers that Vercel and Netlify run,
 * so "works locally" means "works deployed". Locally, accounts and portfolios
 * are stored in .data/dev-db.json (the deployed site uses Upstash Redis).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleCse } from '../lib/cse.js';
import { handleNews } from '../lib/news.js';
import { handleAuth } from '../lib/auth.js';
import { handleData } from '../lib/userdata.js';
import { nodeRequest, paramsFromUrl, privateJson, sendNode } from '../lib/http.js';

const ROOT = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  // Resolve inside ROOT only – blocks ../ path traversal.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = resolve(ROOT, rel || 'index.html');
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    const body = await readFile(join(ROOT, '404.html')).catch(() => 'Not found');
    res.writeHead(404, { 'Content-Type': MIME['.html'] }).end(body);
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (pathname === '/api/cse') sendNode(res, await handleCse(req.method, paramsFromUrl(req.url)));
    else if (pathname === '/api/news') sendNode(res, await handleNews(req.method, paramsFromUrl(req.url)));
    else if (pathname === '/api/auth' || pathname === '/api/data') {
      let request;
      try { request = await nodeRequest(req); } catch (err) {
        sendNode(res, privateJson(err.status || 400, { error: 'bad_request', message: err.message }));
        return;
      }
      sendNode(res, await (pathname === '/api/auth' ? handleAuth(request) : handleData(request)));
    }
    else await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end('Server error');
  }
  if (pathname.startsWith('/api/')) {
    console.log(`[api] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started} ms)`);
  }
});

server.listen(PORT, HOST, () => {
  console.log('='.repeat(52));
  console.log(`  CSE Portfolio  ->  http://${HOST}:${PORT}/`);
  console.log(`  Serving        :  ${ROOT}`);
  console.log('  Stop           :  Ctrl+C');
  console.log('='.repeat(52));
});
