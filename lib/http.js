// Utilitários HTTP: erros, leitura do corpo, cookies e resposta JSON.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
    return text ? JSON.parse(text) : {};
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

export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
