// Criptografia de dados sensíveis guardados no banco (certificados A1, senhas de certificado, segredos de 2FA).
// AES-256-GCM com chave vinda de ENCRYPTION_KEY (ou derivada de SESSION_SECRET quando ENCRYPTION_KEY não existe).
import crypto from 'node:crypto';
import { HttpError } from './http.js';

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  const explicit = process.env.ENCRYPTION_KEY;
  const base = explicit || process.env.SESSION_SECRET;
  if (!base || base.length < 32) {
    throw new HttpError(500, 'Defina ENCRYPTION_KEY (mínimo de 32 caracteres) nas variáveis de ambiente.');
  }
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', base, 'portal-contabil', explicit ? 'vault-v1' : 'vault-from-session-v1', 32));
  return cachedKey;
}

export function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

export function open(sealed) {
  const [version, iv, tag, data] = String(sealed || '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new HttpError(500, 'Dado criptografado inválido.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new HttpError(500, 'Não foi possível abrir o dado criptografado. A ENCRYPTION_KEY foi trocada?');
  }
}

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
