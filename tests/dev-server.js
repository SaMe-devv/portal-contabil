// Servidor local de teste: serve /public com os mesmos cabeçalhos do vercel.json e encaminha /api/* para as funções.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/[...path].js';
import listHandler from '../api/admin/clients/index.js';
import itemHandler from '../api/admin/clients/[id].js';
import subHandler from '../api/admin/clients/[id]/[sub].js';
import accountHandler from '../api/account/[action].js';
import sectionHandler from '../api/admin/[section].js';
import cronHandler from '../api/cron/sync.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.md': 'text/plain', '.png': 'image/png',
};

function applyHeaders(res, pathname) {
  for (const rule of config.headers) {
    const source = rule.source.replace('/((?!api/).*)', '^/(?!api/).*$').replace('/(.*)', '^/.*$');
    if (!new RegExp(source).test(pathname)) continue;
    for (const { key, value } of rule.headers) {
      if (key === 'Strict-Transport-Security') continue; // localhost é http
      res.setHeader(key, value.replace('; upgrade-insecure-requests', ''));
    }
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  applyHeaders(res, url.pathname);
  let m;
  if (url.pathname === '/api/admin/clients') return listHandler(req, res);
  if ((m = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)\/([^/]+)$/))) {
    req.query = { id: m[1], sub: m[2] };
    return subHandler(req, res);
  }
  if ((m = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)$/))) {
    req.query = { id: m[1] };
    return itemHandler(req, res);
  }
  if ((m = url.pathname.match(/^\/api\/account\/([^/]+)$/))) {
    req.query = { action: m[1] };
    return accountHandler(req, res);
  }
  if ((m = url.pathname.match(/^\/api\/admin\/([^/]+)$/))) {
    req.query = { section: m[1] };
    return sectionHandler(req, res);
  }
  if (url.pathname === '/api/cron/sync') return cronHandler(req, res);
  if (url.pathname.startsWith('/api/')) return handler(req, res);
  const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  fs.readFile(file, (error, data) => {
    if (error || !file.startsWith(publicDir)) return res.writeHead(404).end('404');
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(data);
  });
}).listen(Number(process.env.PORT) || 3100);
