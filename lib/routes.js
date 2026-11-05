import { PROFILE_FIELDS, query } from './db.js';
import {
  checkNewPassword, createSession, endAllSessions, endSession, generatePassword, hashPassword,
  sessionCookie, userFromRequest, verifyPassword,
} from './auth.js';
import { ACTION_LABELS, audit } from './audit.js';
import { cnpjRoot, docKey, isValidDoc } from './doc.js';
import { HttpError, checkSameOrigin, clientIp, readJson, send } from './http.js';
import { CertificateError, readPfx } from './pkcs12.js';
import { ensureReady } from './setup.js';
import { backfillClient, cancelBackfill, queueBackfill, syncClient, syncDue } from './sync.js';
import { newSecret, otpauthUri, verifyTotp } from './totp.js';
import { open, safeEqual, seal } from './vault.js';

const MUTATING = ['POST', 'PATCH', 'DELETE'];
const PUBLIC_COLUMNS = `id, email, active, doc, must_change, last_login, ${PROFILE_FIELDS.join(', ')}`;
const IMPORT_CHUNK = 300;
const DUMMY_HASH = '00000000000000000000000000000000:00'; // gasta tempo parecido para logins inexistentes
const TIPOS = ['NF-e', 'NFC-e', 'CT-e', 'NFS-e'];

/* ---------- utilitários ---------- */

function normEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}

function normDoc(value) {
  const doc = docKey(value);
  if (!isValidDoc(doc)) throw new HttpError(400, 'CNPJ/CPF inválido. Confira os números (o CNPJ pode ter letras a partir de 2026).');
  return doc;
}

function cleanProfile(body) {
  const out = {};
  for (const key of PROFILE_FIELDS) {
    if (key in body) out[key] = String(body[key] ?? '').trim().slice(0, 120);
  }
  if ('uf' in out) out.uf = out.uf.toUpperCase().slice(0, 2);
  return out;
}

function dbError(error) {
  const text = `${error.message} ${error.constraint ?? ''}`;
  if (!/unique|duplicate/i.test(text)) return error;
  return /email/i.test(text)
    ? new HttpError(409, 'Já existe um usuário com esse e-mail.')
    : new HttpError(409, 'Já existe um cliente com esse CNPJ/CPF.');
}

const publicUser = (user) => ({
  id: user.id,
  role: user.role,
  email: user.email,
  nome: user.nome,
  mustChange: Boolean(user.must_change),
  totp: Boolean(user.totp_secret),
});

/* ---------- limitador de tentativas de login (guardado no banco) ---------- */

const LIMITS = [
  { prefix: 'pair', max: 5 },   // mesmo IP + mesmo login
  { prefix: 'acct', max: 10 },  // mesmo login, de qualquer IP
  { prefix: 'ip', max: 30 },    // mesmo IP, tentando vários logins
];
const BLOCK_MS = 15 * 60 * 1000;

function throttleKeys(req, login) {
  const ip = clientIp(req);
  return { pair: `pair|${ip}|${login}`.slice(0, 200), acct: `acct|${login}`.slice(0, 200), ip: `ip|${ip}` };
}

async function checkThrottle(keys) {
  const rows = await query(
    'SELECT until_ts FROM login_attempts WHERE attempt_key IN ($1, $2, $3)',
    [keys.pair, keys.acct, keys.ip],
  );
  if (rows.some((r) => Number(r.until_ts) > Date.now())) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
  }
}

async function registerFailure(keys) {
  for (const { prefix, max } of LIMITS) {
    const key = keys[prefix];
    const [row] = await query('SELECT attempts, until_ts FROM login_attempts WHERE attempt_key = $1', [key]);
    let attempts = (Number(row?.until_ts) > 0 && Number(row.until_ts) < Date.now() ? 0 : row?.attempts ?? 0) + 1;
    let until = 0;
    if (attempts >= max) {
      attempts = 0;
      until = Date.now() + BLOCK_MS;
    }
    await query(
      `INSERT INTO login_attempts (attempt_key, attempts, until_ts) VALUES ($1, $2, $3)
       ON CONFLICT (attempt_key) DO UPDATE SET attempts = excluded.attempts, until_ts = excluded.until_ts`,
      [key, attempts, until],
    );
  }
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

// Cliente cujo relatório/XML o usuário pode ver: ADM escolhe; CLIENTE só o próprio.
const scopedClientId = (user, requested) => (user.role === 'adm' ? Number(requested) : user.id);

/* ---------- handlers: sessão e conta ---------- */

async function login({ req, res, body }) {
  const raw = String(body.login ?? body.email ?? '').trim();
  const password = String(body.password ?? '');
  if (!raw || !password || raw.length > 200 || password.length > 200) throw new HttpError(400, 'Informe login e senha.');
  const byEmail = raw.includes('@');
  const loginKey = byEmail ? raw.toLowerCase() : docKey(raw);
  const keys = throttleKeys(req, loginKey);
  await checkThrottle(keys);

  const [user] = byEmail
    ? await query('SELECT * FROM users WHERE email = $1', [loginKey])
    : await query("SELECT * FROM users WHERE doc = $1 AND role = 'cliente'", [loginKey]);
  const valid = verifyPassword(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !valid) {
    await registerFailure(keys);
    await audit(req, user ? { id: user.id, email: user.email } : { email: loginKey }, 'login_fail');
    throw new HttpError(401, 'Login ou senha inválidos.');
  }
  if (!user.active) throw new HttpError(403, 'Acesso bloqueado. Fale com a SaMe Contabilidade.');

  if (user.totp_secret) {
    if (!body.code) throw new HttpError(401, 'Digite o código do aplicativo autenticador.', { totpRequired: true });
    const counter = verifyTotp(open(user.totp_secret), body.code, Number(user.totp_last));
    if (counter === null) {
      await registerFailure(keys);
      await audit(req, user, 'login_fail', '', 'código 2FA inválido');
      throw new HttpError(401, 'Código inválido ou expirado.', { totpRequired: true });
    }
    await query('UPDATE users SET totp_last = $1 WHERE id = $2', [counter, user.id]);
  }

  await query('DELETE FROM login_attempts WHERE attempt_key = $1 OR attempt_key = $2', [keys.pair, keys.acct]);
  await query('UPDATE users SET last_login = $1 WHERE id = $2', [Date.now(), user.id]);
  res.setHeader('Set-Cookie', await createSession(user, req));
  await audit(req, user, 'login');
  return { user: publicUser(user) };
}

async function logout({ req, res, user }) {
  if (user) await audit(req, user, 'logout');
  await endSession(req);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
}

const me = ({ user }) => publicUser(user);

async function changePassword({ req, user, body }) {
  if (!verifyPassword(String(body.current ?? ''), user.pass_hash)) throw new HttpError(400, 'A senha atual não confere.');
  const next = String(body.next ?? '');
  checkNewPassword(next, user);
  if (verifyPassword(next, user.pass_hash)) throw new HttpError(400, 'A nova senha precisa ser diferente da atual.');
  await query('UPDATE users SET pass_hash = $1, must_change = 0 WHERE id = $2', [hashPassword(next), user.id]);
  await endAllSessions(user.id, user.session_hash); // derruba outros aparelhos
  await audit(req, user, 'password_change');
}

async function logoutAll({ req, res, user }) {
  await endAllSessions(user.id);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  await audit(req, user, 'logout_all');
}

async function totpSetup({ user }) {
  if (user.totp_secret) throw new HttpError(400, 'A verificação em duas etapas já está ativa.');
  const secret = newSecret();
  await query('UPDATE users SET totp_pending = $1 WHERE id = $2', [seal(secret), user.id]);
  return { secret, uri: otpauthUri(secret, user.email) };
}

async function totpEnable({ req, user, body }) {
  if (!user.totp_pending) throw new HttpError(400, 'Gere o QR Code antes de ativar.');
  const secret = open(user.totp_pending);
  const counter = verifyTotp(secret, body.code);
  if (counter === null) throw new HttpError(400, 'Código inválido. Confira o horário do celular e tente de novo.');
  await query('UPDATE users SET totp_secret = $1, totp_pending = NULL, totp_last = $2 WHERE id = $3', [user.totp_pending, counter, user.id]);
  await endAllSessions(user.id, user.session_hash);
  await audit(req, user, 'totp_on');
}

async function totpDisable({ req, user, body }) {
  if (!user.totp_secret) return;
  if (!verifyPassword(String(body.password ?? ''), user.pass_hash)) throw new HttpError(400, 'Senha incorreta.');
  if (verifyTotp(open(user.totp_secret), body.code, Number(user.totp_last)) === null) throw new HttpError(400, 'Código inválido.');
  await query('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last = -1 WHERE id = $1', [user.id]);
  await audit(req, user, 'totp_off');
}

/* ---------- handlers: relatório e XMLs (ADM vê qualquer cliente; CLIENTE só o próprio) ---------- */

async function report({ user, url }) {
  const client = await getClient(scopedClientId(user, url.searchParams.get('client')));
  const profile = { doc: client.doc };
  PROFILE_FIELDS.forEach((key) => { profile[key] = client[key]; });

  const notes = await query(
    `SELECT n.chave, n.date, n.nf, n.tipo, n.op, n.e_cnpj AS "eCnpj", n.e_nome AS "eNome", n.e_uf AS "eUF",
            n.d_doc AS "dCnpj", n.d_nome AS "dNome", n.d_uf AS "dUF", n.val, n.situacao, n.origem,
            COALESCE(x.full_xml, -1) AS "xml"
     FROM notes n LEFT JOIN xmls x ON x.user_id = n.user_id AND x.chave = n.chave
     WHERE n.user_id = $1 ORDER BY n.date, LENGTH(n.nf), n.nf`,
    [client.id],
  );
  const [sync] = await query('SELECT last_run AS "lastRun", enabled FROM sync_state WHERE user_id = $1', [client.id]);
  return { profile, notes, sync: sync ?? null };
}

async function downloadXmls({ req, user, body }) {
  const client = await getClient(scopedClientId(user, body.client));
  const chaves = Array.isArray(body.chaves) ? body.chaves.map((c) => String(c).slice(0, 60)).slice(0, 300) : [];
  if (!chaves.length) return { xmls: [] };
  const placeholders = chaves.map((_, i) => `$${i + 2}`).join(', ');
  const rows = await query(
    `SELECT chave, gz, full_xml AS "full" FROM xmls WHERE user_id = $1 AND chave IN (${placeholders})`,
    [client.id, ...chaves],
  );
  if (body.first) await audit(req, user, 'xml_download', client.nome, `${body.total ?? rows.length} arquivo(s)`);
  return { xmls: rows };
}

/* ---------- handlers: ADM ---------- */

async function listClients() {
  const clients = await query(`
    SELECT ${PUBLIC_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')},
      (SELECT CAST(COUNT(*) AS INTEGER) FROM notes n WHERE n.user_id = u.id) AS notes,
      c.subject AS cert_subject, c.not_after AS cert_until,
      s.enabled AS sync_enabled, s.ciencia AS sync_ciencia, s.last_run AS sync_last, s.last_status AS sync_status, s.last_msg AS sync_msg, s.next_nfe AS sync_next, s.backfill AS sync_backfill, s.backfill_keys AS sync_backfill_keys, s.backfill_done AS sync_backfill_done, s.backfill_next AS sync_backfill_next, s.backfill_since AS sync_backfill_since, s.backfill_calls AS sync_backfill_calls, s.nsu_nfe AS sync_nsu, s.janela_ok AS sync_janela_ok
    FROM users u
    LEFT JOIN certificates c ON c.user_id = u.id
    LEFT JOIN sync_state s ON s.user_id = u.id
    WHERE u.role = 'cliente' ORDER BY LOWER(u.nome)
  `);
  return { clients };
}

async function createClient({ req, user, body }) {
  const email = normEmail(body.email);
  const doc = normDoc(body.doc);
  const profile = Object.fromEntries(PROFILE_FIELDS.map((key) => [key, '']));
  Object.assign(profile, cleanProfile(body));
  if (!profile.nome) throw new HttpError(400, 'Informe a razão social.');

  let password = String(body.password ?? '');
  if (password) checkNewPassword(password, { email, doc });
  else password = generatePassword();

  const columns = ['role', 'email', 'pass_hash', 'active', 'must_change', 'doc', ...PROFILE_FIELDS];
  const values = [
    'cliente', email, hashPassword(password), body.active === false ? 0 : 1, 1, doc,
    ...PROFILE_FIELDS.map((key) => profile[key]),
  ];
  try {
    const [row] = await query(
      `INSERT INTO users (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      values,
    );
    await query('INSERT INTO sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [row.id]);
    await audit(req, user, 'client_create', profile.nome);
    return { client: await clientRow(row.id), password };
  } catch (error) {
    throw dbError(error);
  }
}

async function updateClient({ req, user, params, body }) {
  const id = Number(params[0]);
  const current = await getClient(id);

  const sets = cleanProfile(body);
  if ('doc' in body && docKey(body.doc) !== current.doc) sets.doc = normDoc(body.doc);
  if ('email' in body) sets.email = normEmail(body.email);
  if ('active' in body) sets.active = body.active ? 1 : 0;
  if ('nome' in sets && !sets.nome) throw new HttpError(400, 'Informe a razão social.');

  let password = null;
  if (body.generatePassword) {
    password = generatePassword();
  } else if (body.password) {
    password = String(body.password);
    checkNewPassword(password, { email: sets.email ?? current.email, doc: sets.doc ?? current.doc });
  }
  if (password) {
    sets.pass_hash = hashPassword(password);
    sets.must_change = 1; // o cliente troca no primeiro acesso: só ele conhece a senha definitiva
  }

  const keys = Object.keys(sets); // todas as chaves vêm de listas fixas acima
  if (keys.length) {
    try {
      await query(
        `UPDATE users SET ${keys.map((key, i) => `${key} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
        [...keys.map((key) => sets[key]), id],
      );
    } catch (error) {
      throw dbError(error);
    }
  }
  // Trocar senha/e-mail ou bloquear encerra as sessões abertas desse cliente.
  if (password || sets.active === 0 || (sets.email && sets.email !== current.email)) await endAllSessions(id);

  if (password) await audit(req, user, 'client_password', current.nome);
  if (sets.active === 0 && current.active) await audit(req, user, 'client_block', current.nome);
  if (sets.active === 1 && !current.active) await audit(req, user, 'client_unblock', current.nome);
  if (keys.some((k) => !['pass_hash', 'must_change', 'active'].includes(k))) await audit(req, user, 'client_update', current.nome);
  return { client: await clientRow(id), password };
}

async function deleteClient({ req, user, params }) {
  const id = Number(params[0]);
  const client = await getClient(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
  await audit(req, user, 'client_delete', client.nome, client.doc);
}

async function importNotes({ req, user, params, body }) {
  const client = await getClient(Number(params[0]));
  const list = Array.isArray(body.notes) ? body.notes.slice(0, 2000) : [];
  const result = { novas: 0, repetidas: 0, outros: 0, invalidas: 0 };

  const valid = new Map(); // chave -> campos (remove repetidas dentro do próprio envio)
  const gzByKey = new Map();
  for (const note of list) {
    const emitDoc = docKey(note.eCnpj);
    const destDoc = docKey(note.destDoc);
    // O cliente é o destinatário/tomador (entrada) ou o emitente (saída). O servidor decide, não o navegador.
    let op = null;
    if (destDoc === client.doc) op = 'entrada';
    else if (emitDoc === client.doc) op = 'saida';
    if (!op) {
      result.outros += 1;
      continue;
    }
    const val = Number(note.val);
    if (!TIPOS.includes(note.tipo) || !/^\d{4}-\d{2}-\d{2}$/.test(note.date) || !Number.isFinite(val) || !note.chave) {
      result.invalidas += 1;
      continue;
    }
    const chave = String(note.chave).slice(0, 60);
    valid.set(chave, [
      note.date, String(note.nf ?? '').slice(0, 20), note.tipo, op,
      emitDoc, String(note.eNome ?? '').slice(0, 150), String(note.eUF ?? '').slice(0, 2),
      destDoc, String(note.destNome ?? '').slice(0, 150), String(note.destUF ?? '').slice(0, 2), val,
    ]);
    if (typeof note.gz === 'string' && note.gz.length < 200000 && /^[A-Za-z0-9+/=]+$/.test(note.gz)) gzByKey.set(chave, note.gz);
  }

  const COLUMNS = 13;
  const entries = [...valid.entries()];
  for (let start = 0; start < entries.length; start += IMPORT_CHUNK) {
    const values = [];
    const tuples = entries.slice(start, start + IMPORT_CHUNK).map(([chave, fields], i) => {
      values.push(client.id, chave, ...fields);
      const base = i * COLUMNS;
      return `(${Array.from({ length: COLUMNS }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    const inserted = await query(
      `INSERT INTO notes (user_id, chave, date, nf, tipo, op, e_cnpj, e_nome, e_uf, d_doc, d_nome, d_uf, val)
       VALUES ${tuples.join(', ')} ON CONFLICT (user_id, chave) DO NOTHING RETURNING id`,
      values,
    );
    result.novas += inserted.length;
  }
  result.repetidas = entries.length - result.novas;

  const xmlEntries = [...gzByKey.entries()];
  for (let start = 0; start < xmlEntries.length; start += 200) {
    const values = [];
    const tuples = xmlEntries.slice(start, start + 200).map(([chave, gz], i) => {
      values.push(client.id, chave, gz);
      return `($${i * 3 + 1}, $${i * 3 + 2}, 1, $${i * 3 + 3})`;
    });
    await query(
      `INSERT INTO xmls (user_id, chave, full_xml, gz) VALUES ${tuples.join(', ')}
       ON CONFLICT (user_id, chave) DO UPDATE SET full_xml = 1, gz = excluded.gz`,
      values,
    );
  }
  if (result.novas) await audit(req, user, 'notes_import', client.nome, `${result.novas} nota(s)`);
  return result;
}

async function clearNotes({ req, user, params }) {
  const id = Number(params[0]);
  const client = await getClient(id);
  await query('DELETE FROM notes WHERE user_id = $1', [id]);
  await query('DELETE FROM xmls WHERE user_id = $1', [id]);
  await audit(req, user, 'notes_clear', client.nome);
}

async function uploadCert({ req, user, params, body }) {
  const client = await getClient(Number(params[0]));
  const pfx = Buffer.from(String(body.pfx ?? ''), 'base64');
  if (!pfx.length || pfx.length > 100000) throw new HttpError(400, 'Envie o arquivo .pfx do certificado A1.');
  let cert;
  try {
    cert = readPfx(pfx, String(body.password ?? ''));
  } catch (error) {
    if (error instanceof CertificateError) throw new HttpError(400, error.message);
    throw error;
  }
  if (!cert.doc) throw new HttpError(400, 'Não encontramos CNPJ/CPF no certificado. Use um e-CNPJ ou e-CPF A1 da ICP-Brasil.');
  const sameOwner = client.doc.length === 11 ? cert.doc === client.doc : cnpjRoot(cert.doc) === cnpjRoot(client.doc);
  if (!sameOwner) {
    throw new HttpError(400, `Este certificado é de ${cert.doc}, que não corresponde ao CNPJ/CPF do cliente. A SEFAZ só entrega notas ao dono do certificado (mesma raiz de CNPJ).`);
  }
  if (cert.notAfter < Date.now()) throw new HttpError(400, 'Este certificado está vencido.');

  const sealed = seal({ keyPem: cert.keyPem, certPem: cert.certPem, chainPem: cert.chainPem });
  await query(
    `INSERT INTO certificates (user_id, sealed, subject, cert_doc, not_after, uploaded_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET sealed = excluded.sealed, subject = excluded.subject, cert_doc = excluded.cert_doc,
       not_after = excluded.not_after, uploaded_at = excluded.uploaded_at`,
    [client.id, sealed, cert.subject.slice(0, 200), cert.doc, cert.notAfter, Date.now()],
  );
  await query(
    `INSERT INTO sync_state (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET next_nfe = 0, next_cte = 0, last_status = '', last_msg = ''`,
    [client.id],
  );
  await audit(req, user, 'cert_upload', client.nome, `${cert.subject} (válido até ${new Date(cert.notAfter).toLocaleDateString('pt-BR')})`);
  return { subject: cert.subject, notAfter: cert.notAfter };
}

async function deleteCert({ req, user, params }) {
  const client = await getClient(Number(params[0]));
  await query('DELETE FROM certificates WHERE user_id = $1', [client.id]);
  await audit(req, user, 'cert_delete', client.nome);
}

async function configSync({ req, user, params, body }) {
  const client = await getClient(Number(params[0]));
  await query('INSERT INTO sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [client.id]);
  const sets = [];
  const values = [];
  if ('enabled' in body) { values.push(body.enabled ? 1 : 0); sets.push(`enabled = $${values.length}`); }
  if ('ciencia' in body) { values.push(body.ciencia ? 1 : 0); sets.push(`ciencia = $${values.length}`); }
  if (sets.length) {
    values.push(client.id);
    await query(`UPDATE sync_state SET ${sets.join(', ')} WHERE user_id = $${values.length}`, values);
    await audit(req, user, 'sync_config', client.nome, JSON.stringify(body).slice(0, 100));
  }
}

async function runSync({ req, user, params }) {
  const client = await getClient(Number(params[0]));
  await query('INSERT INTO sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [client.id]);
  const result = await syncClient(client.id, { deadline: Date.now() + 50000 });
  const back = await backfillClient(client.id, { deadline: Date.now() + 40000 });
  if (back?.message) result.message = [result.message, back.message].filter(Boolean).join(' · ');
  await audit(req, user, 'sync_run', client.nome, result.message);
  return result;
}

async function startBackfill({ req, user, params, body }) {
  const client = await getClient(Number(params[0]));
  const [cert] = await query('SELECT not_after FROM certificates WHERE user_id = $1', [client.id]);
  if (!cert || Number(cert.not_after) < Date.now()) throw new HttpError(400, 'Envie um certificado A1 válido antes da busca retroativa.');
  await query('INSERT INTO sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [client.id]);
  const chaves = Array.isArray(body.chaves) ? body.chaves.slice(0, 5000) : [];
  const result = await queueBackfill(client.id, { since: String(body.since ?? ''), chaves, porSequencia: body.porSequencia !== false });
  if (!result.chaves && !result.sequencia) {
    throw new HttpError(400, chaves.length
      ? 'Todas as chaves informadas já têm o XML completo no portal (ou não são de NF-e).'
      : 'Ainda não há busca feita para este cliente. Use "Buscar agora": a primeira busca já traz os últimos 90 dias.');
  }
  await audit(req, user, 'sync_config', client.nome, `busca retroativa desde ${result.since}${result.chaves ? `, ${result.chaves} chave(s)` : ''}`);
  const first = await backfillClient(client.id, { deadline: Date.now() + 45000 });
  const [st] = await query('SELECT backfill_next FROM sync_state WHERE user_id = $1', [client.id]);
  return { ...result, primeira: first, proxima: Number(st?.backfill_next) || 0 };
}

async function stopBackfill({ req, user, params }) {
  const client = await getClient(Number(params[0]));
  await cancelBackfill(client.id);
  await audit(req, user, 'sync_config', client.nome, 'busca retroativa cancelada');
}

async function auditLog({ url }) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);
  const rows = await query(
    'SELECT ts, email, action, target, ip, detail FROM audit_log ORDER BY ts DESC LIMIT $1',
    [limit],
  );
  // Limpeza: guarda 1 ano de histórico.
  await query('DELETE FROM audit_log WHERE ts < $1', [Date.now() - 365 * 24 * 3600 * 1000]);
  await query('DELETE FROM login_attempts WHERE until_ts < $1 AND attempts = 0', [Date.now()]);
  return { rows: rows.map((r) => ({ ...r, label: ACTION_LABELS[r.action] || r.action })) };
}

async function cron({ req, url }) {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  if (!secret || secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) throw new HttpError(401, 'Não autorizado.');
  return syncDue({ budgetMs: 250000, full: url.searchParams.get('modo') !== 'retroativo' });
}

/* ---------- tabela de rotas: [método, padrão, acesso, handler] ---------- */
// acesso: null = público; 'any' = logado; 'adm' = só ADM; 'cron' = agendador (CRON_SECRET)

const routes = [
  ['POST',   /^\/api\/login$/,                          null,  login],
  ['POST',   /^\/api\/logout$/,                         'opt', logout],
  ['GET',    /^\/api\/me$/,                             'any', me],
  ['POST',   /^\/api\/account\/password$/,              'any', changePassword],
  ['POST',   /^\/api\/account\/logout-all$/,            'any', logoutAll],
  ['POST',   /^\/api\/account\/totp-setup$/,            'adm', totpSetup],
  ['POST',   /^\/api\/account\/totp-enable$/,           'adm', totpEnable],
  ['POST',   /^\/api\/account\/totp-disable$/,          'adm', totpDisable],
  ['GET',    /^\/api\/report$/,                         'any', report],
  ['POST',   /^\/api\/xmls$/,                           'any', downloadXmls],
  ['GET',    /^\/api\/admin\/clients$/,                 'adm', listClients],
  ['POST',   /^\/api\/admin\/clients$/,                 'adm', createClient],
  ['PATCH',  /^\/api\/admin\/clients\/(\d+)$/,          'adm', updateClient],
  ['DELETE', /^\/api\/admin\/clients\/(\d+)$/,          'adm', deleteClient],
  ['POST',   /^\/api\/admin\/clients\/(\d+)\/notes$/,   'adm', importNotes],
  ['DELETE', /^\/api\/admin\/clients\/(\d+)\/notes$/,   'adm', clearNotes],
  ['POST',   /^\/api\/admin\/clients\/(\d+)\/cert$/,    'adm', uploadCert],
  ['DELETE', /^\/api\/admin\/clients\/(\d+)\/cert$/,    'adm', deleteCert],
  ['PATCH',  /^\/api\/admin\/clients\/(\d+)\/sync$/,    'adm', configSync],
  ['POST',   /^\/api\/admin\/clients\/(\d+)\/sync$/,    'adm', runSync],
  ['POST',   /^\/api\/admin\/clients\/(\d+)\/backfill$/, 'adm', startBackfill],
  ['DELETE', /^\/api\/admin\/clients\/(\d+)\/backfill$/, 'adm', stopBackfill],
  ['GET',    /^\/api\/admin\/audit$/,                   'adm', auditLog],
  ['GET',    /^\/api\/cron\/sync$/,                     'cron', cron],
];

// Rotas liberadas enquanto o usuário ainda precisa trocar a senha provisória.
const ALLOWED_WHILE_MUST_CHANGE = [me, logout, changePassword, logoutAll];

export async function handleApi(req, res, url) {
  try {
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) throw new HttpError(404, 'Rota não encontrada.');
    const [, pattern, access, handler] = route;

    if (MUTATING.includes(req.method)) checkSameOrigin(req);
    await ensureReady();

    let user = null;
    if (access && access !== 'cron') {
      user = await userFromRequest(req);
      if (!user && access !== 'opt') throw new HttpError(401, 'Sessão encerrada. Entre novamente.');
      if (access === 'adm' && user.role !== 'adm') throw new HttpError(403, 'Acesso restrito ao escritório.');
      if (user?.must_change && !ALLOWED_WHILE_MUST_CHANGE.includes(handler)) {
        throw new HttpError(403, 'Troque a senha provisória para continuar.', { mustChange: true });
      }
    }

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
    send(res, known ? error.status : 500, { error: known ? error.message : 'Erro interno.', ...(known ? error.extra : {}) });
  }
}
