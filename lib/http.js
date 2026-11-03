// Utilitários HTTP: erros, leitura do corpo, cookies, IP do visitante, origem e resposta JSON.
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MAX_BODY = 4 * 1024 * 1024; // a Vercel limita o corpo da requisição a ~4,5 MB

export async function readJson(req) {
  // A Vercel já entrega o JSON interpretado em req.body; fora dela lemos o stream.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return parse(req.body.toString('utf8'));
    return typeof req.body === 'string' ? parse(req.body) : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Envio grande demais.');
    chunks.push(chunk);
  }
  return chunks.length ? parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function parse(text) {
  try {
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

export function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return cookies;
}

// Na Vercel, x-vercel-forwarded-for / x-real-ip são definidos pela própria plataforma (o visitante não consegue forjar).
export function clientIp(req) {
  const h = req.headers;
  const raw = h['x-vercel-forwarded-for'] || h['x-real-ip'] || h['x-forwarded-for'] || req.socket?.remoteAddress || '';
  return String(raw).split(',')[0].trim().slice(0, 64);
}

export const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 200);

// Bloqueia requisições que alteram dados vindas de outro site (defesa extra contra CSRF, além do SameSite=Strict).
export function checkSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'Origem não permitida.');
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Origem não permitida.');
  }
  const expected = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (host !== expected) throw new HttpError(403, 'Origem não permitida.');
}

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
