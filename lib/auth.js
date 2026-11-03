// Senhas (scrypt) e sessão por cookie assinado. O bloqueio é conferido no banco a cada requisição.
import crypto from 'node:crypto';
import { HttpError, parseCookies } from './http.js';
import { query } from './db.js';

export const SESSION_SECONDS = 12 * 3600;

const scrypt = (password, salt) => crypto.scryptSync(password, salt, 64);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${scrypt(password, salt).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scrypt(password, Buffer.from(salt, 'hex'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export const generatePassword = () => crypto.randomBytes(9).toString('base64url');

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new HttpError(500, 'Defina SESSION_SECRET (mínimo de 32 caracteres) nas variáveis de ambiente.');
  }
  return value;
}

const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

export function createToken(user) {
  const payload = { uid: user.id, tv: user.token_version, exp: Date.now() + SESSION_SECONDS * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// Usuário da sessão, ou null se a sessão for inválida, expirada, invalidada ou o acesso estiver bloqueado.
export async function userFromRequest(req) {
  const payload = readToken(parseCookies(req).sid);
  if (!payload) return null;
  const [user] = await query('SELECT * FROM users WHERE id = $1', [payload.uid]);
  if (!user || !user.active || user.token_version !== payload.tv) return null;
  return user;
}

export function sessionCookie(token, maxAgeSeconds) {
  const secure = process.env.COOKIE_INSECURE === '1' ? '' : '; Secure';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}
