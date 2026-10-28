// Servidor local de teste: serve /public e encaminha /api/* para a mesma função da Vercel.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/[...path].js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handler(req, res);
  const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
  fs.readFile(file, (error, data) => {
    if (error || !file.startsWith(publicDir)) return res.writeHead(404).end('404');
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'text/plain'}; charset=utf-8` });
    res.end(data);
  });
}).listen(Number(process.env.PORT) || 3100);
