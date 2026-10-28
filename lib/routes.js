import { PROFILE_FIELDS, query } from './db.js';
import {
  SESSION_SECONDS, createToken, generatePassword, hashPassword,
  sessionCookie, userFromRequest, verifyPassword,
} from './auth.js';
import { HttpError, clientIp, readJson, send } from './http.js';
import { ensureReady } from './setup.js';

const MUTATING = ['POST', 'PATCH', 'DELETE'];
const PUBLIC_COLUMNS = `id, email, active, doc, ${PROFILE_FIELDS.join(', ')}`;
const IMPORT_CHUNK = 400;
const DUMMY_HASH = 'aa:bb'; // gasta tempo parecido para e-mails inexistentes

/* ---------- utilitários ---------- */

const digits = (value) => String(value ?? '').replace(/\D/g, '');

function normEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}

function normDoc(value) {
  const doc = digits(value);
  if (doc.length !== 11 && doc.length !== 14) throw new HttpError(400, 'Informe um CNPJ (14 dígitos) ou CPF (11 dígitos).');
  return doc;
}

function checkPassword(password) {
  if (password.length < 8) throw new HttpError(400, 'A senha deve ter pelo menos 8 caracteres.');
}

function cleanProfile(body) {
  const out = {};
  for (const key of PROFILE_FIELDS) {
    if (key in body) out[key] = String(body[key] ?? '').trim().slice(0, 120);
  }
  return out;
}

function dbError(error) {
  const text = `${error.message} ${error.constraint ?? ''}`;
  if (!/unique|duplicate/i.test(text)) return error;
  return /email/i.test(text)
    ? new HttpError(409, 'Já existe um usuário com esse e-mail.')
    : new HttpError(409, 'Já existe um cliente com esse CNPJ/CPF.');
}

/* ---------- limitador de tentativas de login (guardado no banco) ---------- */

async function checkThrottle(key) {
  const [row] = await query('SELECT until_ts FROM login_attempts WHERE attempt_key = $1', [key]);
  if (row && row.until_ts > Date.now()) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
}

async function registerFailure(key) {
  const [row] = await query('SELECT attempts FROM login_attempts WHERE attempt_key = $1', [key]);
  let attempts = (row?.attempts ?? 0) + 1;
  let until = 0;
  if (attempts >= 5) {
    attempts = 0;
    until = Date.now() + 15 * 60 * 1000;
  }
  await query(
    `INSERT INTO login_attempts (attempt_key, attempts, until_ts) VALUES ($1, $2, $3)
     ON CONFLICT (attempt_key) DO UPDATE SET attempts = excluded.attempts, until_ts = excluded.until_ts`,
    [key, attempts, until],
  );
}

/* ---------- consultas ---------- */

async function getClient(id) {
  const [client] = await query("SELECT * FROM users WHERE id = $1 AND role = 'cliente'", [id]);
  if (!client) throw new HttpError(404, 'Cliente não encontrado.');
  return client;
}

async function clientRow(id) {
  const [row] = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return row;
}

/* ---------- handlers: sessão ---------- */

async function login({ req, res, body }) {
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const key = `${clientIp(req)}|${email}`.slice(0, 200);
  await checkThrottle(key);

  const [user] = await query('SELECT * FROM users WHERE email = $1', [email]);
  const valid = verifyPassword(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !valid) {
    await registerFailure(key);
    throw new HttpError(401, 'E-mail ou senha inválidos.');
  }
  if (!user.active) throw new HttpError(403, 'Acesso bloqueado. Fale com a sua contabilidade.');

  await query('DELETE FROM login_attempts WHERE attempt_key = $1', [key]);
  res.setHeader('Set-Cookie', sessionCookie(createToken(user), SESSION_SECONDS));
  return { user: { id: user.id, role: user.role, email: user.email, nome: user.nome } };
}

function logout({ res }) {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
}

const me = ({ user }) => ({ id: user.id, role: user.role, email: user.email, nome: user.nome });

/* ---------- handlers: relatório (ADM vê qualquer cliente; CLIENTE só o próprio) ---------- */

async function report({ user, url }) {
  const id = user.role === 'adm' ? Number(url.searchParams.get('client')) : user.id;
  const client = await getClient(id);
  const profile = { doc: client.doc };
  PROFILE_FIELDS.forEach((key) => { profile[key] = client[key]; });

  const notes = await query(
    `SELECT chave, date, nf, e_cnpj AS "eCnpj", e_nome AS "eNome", e_uf AS "eUF", val
     FROM notes WHERE user_id = $1 ORDER BY date, LENGTH(nf), nf`,
    [client.id],
  );
  return { profile, notes };
}

/* ---------- handlers: ADM ---------- */

async function listClients() {
  const clients = await query(`
    SELECT ${PUBLIC_COLUMNS},
      (SELECT CAST(COUNT(*) AS INTEGER) FROM notes n WHERE n.user_id = users.id) AS notes
    FROM users WHERE role = 'cliente' ORDER BY LOWER(nome)
  `);
  return { clients };
}

async function createClient({ body }) {
  const email = normEmail(body.email);
  const doc = normDoc(body.doc);
  const profile = Object.fromEntries(PROFILE_FIELDS.map((key) => [key, '']));
  Object.assign(profile, cleanProfile(body));
  if (!profile.nome) throw new HttpError(400, 'Informe a razão social.');

  let password = String(body.password ?? '');
  if (password) checkPassword(password);
  else password = generatePassword();

  const columns = ['role', 'email', 'pass_hash', 'active', 'doc', ...PROFILE_FIELDS];
  const values = [
    'cliente', email, hashPassword(password), body.active === false ? 0 : 1, doc,
    ...PROFILE_FIELDS.map((key) => profile[key]),
  ];
  try {
    const [row] = await query(
      `INSERT INTO users (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      values,
    );
    return { client: await clientRow(row.id), password };
  } catch (error) {
    throw dbError(error);
  }
}

async function updateClient({ params, body }) {
  const id = Number(params[0]);
  const current = await getClient(id);

  const sets = cleanProfile(body);
  if ('doc' in body) sets.doc = normDoc(body.doc);
  if ('email' in body) sets.email = normEmail(body.email);
  if ('active' in body) sets.active = body.active ? 1 : 0;
  if ('nome' in sets && !sets.nome) throw new HttpError(400, 'Informe a razão social.');

  let password = null;
  if (body.generatePassword) {
    password = generatePassword();
  } else if (body.password) {
    password = String(body.password);
    checkPassword(password);
  }
  if (password) sets.pass_hash = hashPassword(password);

  // Trocar senha/e-mail ou bloquear invalida as sessões abertas desse cliente.
  const mustLogout = Boolean(password) || sets.active === 0 || (sets.email && sets.email !== current.email);

  const keys = Object.keys(sets); // todas as chaves vêm de listas fixas acima
  const assignments = keys.map((key, i) => `${key} = $${i + 1}`);
  if (mustLogout) assignments.push('token_version = token_version + 1');
  if (assignments.length) {
    try {
      await query(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = $${keys.length + 1}`,
        [...keys.map((key) => sets[key]), id],
      );
    } catch (error) {
      throw dbError(error);
    }
  }
  return { client: await clientRow(id), password };
}

async function deleteClient({ params }) {
  const id = Number(params[0]);
  await getClient(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
}

async function importNotes({ params, body }) {
  const client = await getClient(Number(params[0]));
  const list = Array.isArray(body.notes) ? body.notes : [];
  const result = { novas: 0, repetidas: 0, outros: 0, invalidas: 0 };

  const valid = new Map(); // chave -> nota (remove repetidas dentro do próprio envio)
  for (const note of list) {
    if (digits(note.destDoc) !== client.doc) {
      result.outros += 1; // nota emitida para outro CNPJ/CPF
      continue;
    }
    const val = Number(note.val);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(note.date) || !Number.isFinite(val) || !note.chave) {
      result.invalidas += 1;
      continue;
    }
    valid.set(String(note.chave).slice(0, 60), [
      String(note.nf ?? '').slice(0, 20), digits(note.eCnpj), String(note.eNome ?? '').slice(0, 150),
      String(note.eUF ?? '').slice(0, 2), val, note.date,
    ]);
  }

  const entries = [...valid.entries()];
  for (let start = 0; start < entries.length; start += IMPORT_CHUNK) {
    const values = [];
    const tuples = entries.slice(start, start + IMPORT_CHUNK).map(([chave, [nf, eCnpj, eNome, eUF, val, date]], i) => {
      values.push(client.id, chave, date, nf, eCnpj, eNome, eUF, val);
      const base = i * 8;
      return `(${Array.from({ length: 8 }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    const inserted = await query(
      `INSERT INTO notes (user_id, chave, date, nf, e_cnpj, e_nome, e_uf, val) VALUES ${tuples.join(', ')}
       ON CONFLICT (user_id, chave) DO NOTHING RETURNING id`,
      values,
    );
    result.novas += inserted.length;
  }
  result.repetidas = entries.length - result.novas;
  return result;
}

async function clearNotes({ params }) {
  const id = Number(params[0]);
  await getClient(id);
  await query('DELETE FROM notes WHERE user_id = $1', [id]);
}

/* ---------- tabela de rotas: [método, padrão, acesso, handler] ---------- */

const routes = [
  ['POST',   /^\/api\/login$/,                          null,  login],
  ['POST',   /^\/api\/logout$/,                         null,  logout],
  ['GET',    /^\/api\/me$/,                             'any', me],
  ['GET',    /^\/api\/report$/,                         'any', report],
  ['GET',    /^\/api\/admin\/clients$/,                 'adm', listClients],
  ['POST',   /^\/api\/admin\/clients$/,                 'adm', createClient],
  ['PATCH',  /^\/api\/admin\/clients\/(\d+)$/,          'adm', updateClient],
  ['DELETE', /^\/api\/admin\/clients\/(\d+)$/,          'adm', deleteClient],
  ['POST',   /^\/api\/admin\/clients\/(\d+)\/notes$/,   'adm', importNotes],
  ['DELETE', /^\/api\/admin\/clients\/(\d+)\/notes$/,   'adm', clearNotes],
];

export async function handleApi(req, res, url) {
  try {
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) throw new HttpError(404, 'Rota não encontrada.');
    const [, pattern, access, handler] = route;

    await ensureReady();

    const user = access ? await userFromRequest(req) : null;
    if (access && !user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
    if (access === 'adm' && user.role !== 'adm') throw new HttpError(403, 'Acesso restrito ao ADM.');

    let body = {};
    if (MUTATING.includes(req.method)) {
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        throw new HttpError(415, 'Use Content-Type: application/json.');
      }
      body = await readJson(req);
    }

    const params = url.pathname.match(pattern).slice(1);
    const result = await handler({ req, res, url, user, body, params });
    send(res, 200, result ?? { ok: true });
  } catch (error) {
    const known = error instanceof HttpError;
    if (!known) console.error(error);
    send(res, known ? error.status : 500, { error: known ? error.message : 'Erro interno.' });
  }
}
