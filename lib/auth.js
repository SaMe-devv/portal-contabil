// Senhas (scrypt) e sessões guardadas no banco (podem ser encerradas a qualquer momento).
import crypto from 'node:crypto';
import { HttpError, clientIp, parseCookies, userAgent } from './http.js';
import { query } from './db.js';
import { sha256 } from './vault.js';

export const SESSION_ABSOLUTE = 12 * 3600 * 1000; // sessão dura no máximo 12 h
export const SESSION_IDLE = { adm: 60 * 60 * 1000, cliente: 2 * 3600 * 1000 }; // encerra após inatividade
const TOUCH_EVERY = 5 * 60 * 1000;

/* ---------- senhas ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = (password, salt) => crypto.scryptSync(password, salt, 64, SCRYPT);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${scrypt(password, salt).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scrypt(String(password), Buffer.from(salt, 'hex'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Senha provisória legível (sem 0/O, 1/l): 4 grupos de 4 caracteres.
export function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  const raw = [...bytes].map((b) => chars[b % chars.length]).join('');
  return raw.match(/.{4}/g).join('-');
}

const COMMON = ['12345678', '123456789', '1234567890', 'senha123', 'senha1234', 'password', 'qwerty123', 'abc12345', '11111111', 'mudar123', 'contabilidade'];

export function checkNewPassword(password, user = {}) {
  const value = String(password || '');
  if (value.length < 10) throw new HttpError(400, 'A senha deve ter pelo menos 10 caracteres.');
  if (value.length > 200) throw new HttpError(400, 'Senha longa demais.');
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw new HttpError(400, 'Use letras e números na senha.');
  const lower = value.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) throw new HttpError(400, 'Essa senha é muito comum. Escolha outra.');
  const local = String(user.email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) throw new HttpError(400, 'A senha não pode conter o seu e-mail.');
  if (user.doc && value.replace(/\W/g, '').toUpperCase().includes(String(user.doc).slice(0, 8))) {
    throw new HttpError(400, 'A senha não pode conter o CPF/CNPJ.');
  }
}

/* ---------- sessões ---------- */

const secureCookie = () => process.env.COOKIE_INSECURE !== '1';
const cookieName = () => (secureCookie() ? '__Host-sid' : 'sid');

export function sessionCookie(token, maxAgeSeconds) {
  const secure = secureCookie() ? '; Secure' : '';
  return `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

export async function createSession(user, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await query(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, ip, ua)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sha256(token), user.id, now, now, now + SESSION_ABSOLUTE, clientIp(req), userAgent(req)],
  );
  // Limpeza oportunista de sessões vencidas.
  await query('DELETE FROM sessions WHERE expires_at < $1', [now]);
  return sessionCookie(token, SESSION_ABSOLUTE / 1000);
}

const tokenFrom = (req) => parseCookies(req)[cookieName()] || '';

// Usuário da sessão, ou null se a sessão não existir, tiver vencido (tempo total ou inatividade) ou o acesso estiver bloqueado.
export async function userFromRequest(req) {
  const token = tokenFrom(req);
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const [row] = await query(
    `SELECT s.last_seen AS s_last, s.expires_at AS s_exp, u.*
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [hash],
  );
  if (!row) return null;
  const now = Date.now();
  const idle = SESSION_IDLE[row.role] ?? SESSION_IDLE.cliente;
  if (row.s_exp < now || now - row.s_last > idle || !row.active) {
    await query('DELETE FROM sessions WHERE token_hash = $1', [hash]);
    return null;
  }
  if (now - row.s_last > TOUCH_EVERY) await query('UPDATE sessions SET last_seen = $1 WHERE token_hash = $2', [now, hash]);
  row.session_hash = hash;
  return row;
}

export async function endSession(req) {
  const token = tokenFrom(req);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

// Encerra todas as sessões do usuário (opcionalmente mantendo a atual).
export async function endAllSessions(userId, keepHash = null) {
  if (keepHash) await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, keepHash]);
  else await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}
