// Prepara o banco na primeira requisição de cada instância: cria tabelas e o primeiro ADM.
import { query, usesSqlite } from './db.js';
import { schema } from './schema.js';
import { hashPassword } from './auth.js';
import { HttpError } from './http.js';

let ready = null;

async function init() {
  for (const statement of schema(await usesSqlite())) await query(statement);

  const [admin] = await query("SELECT id FROM users WHERE role = 'adm' LIMIT 1");
  if (admin) return;

  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || password.length < 8) {
    throw new HttpError(500, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD (mínimo de 8 caracteres) para criar o primeiro ADM.');
  }
  await query(
    "INSERT INTO users (role, email, pass_hash, nome) VALUES ('adm', $1, $2, 'Administrador')",
    [email, hashPassword(password)],
  );
}

export function ensureReady() {
  if (!ready) {
    ready = init().catch((error) => {
      ready = null; // tenta de novo na próxima requisição
      throw error;
    });
  }
  return ready;
}
