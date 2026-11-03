// Tabelas do banco (criadas automaticamente no primeiro acesso).
// Colunas acrescentadas depois: bancos Postgres já existentes recebem por ALTER TABLE.
const MIGRATIONS = [
  "ALTER TABLE notes ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'NF-e'",
  "ALTER TABLE notes ADD COLUMN IF NOT EXISTS op TEXT NOT NULL DEFAULT 'entrada'",
  "ALTER TABLE notes ADD COLUMN IF NOT EXISTS d_doc TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN IF NOT EXISTS d_nome TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN IF NOT EXISTS d_uf TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN IF NOT EXISTS situacao TEXT NOT NULL DEFAULT 'autorizada'",
  "ALTER TABLE notes ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'manual'",
  'ALTER TABLE notes ADD COLUMN IF NOT EXISTS manif TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last BIGINT NOT NULL DEFAULT -1',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login DOUBLE PRECISION',
];

export function schema(sqlite) {
  const id = sqlite
    ? 'INTEGER PRIMARY KEY AUTOINCREMENT'
    : 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY';

  return [
    `CREATE TABLE IF NOT EXISTS users (
      id            ${id},
      role          TEXT NOT NULL CHECK (role IN ('adm', 'cliente')),
      email         TEXT NOT NULL UNIQUE,
      pass_hash     TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      token_version INTEGER NOT NULL DEFAULT 0,
      must_change   INTEGER NOT NULL DEFAULT 0,
      totp_secret   TEXT,
      totp_pending  TEXT,
      totp_last     BIGINT NOT NULL DEFAULT -1,
      last_login    DOUBLE PRECISION,
      doc           TEXT UNIQUE,
      nome          TEXT NOT NULL DEFAULT '',
      ie            TEXT NOT NULL DEFAULT '',
      lgr           TEXT NOT NULL DEFAULT '',
      nro           TEXT NOT NULL DEFAULT '',
      cpl           TEXT NOT NULL DEFAULT '',
      bairro        TEXT NOT NULL DEFAULT '',
      mun           TEXT NOT NULL DEFAULT '',
      uf            TEXT NOT NULL DEFAULT '',
      cep           TEXT NOT NULL DEFAULT '',
      fone          TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
      id       ${id},
      user_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      chave    TEXT NOT NULL,
      date     TEXT NOT NULL,
      nf       TEXT NOT NULL,
      tipo     TEXT NOT NULL DEFAULT 'NF-e',
      op       TEXT NOT NULL DEFAULT 'entrada',
      e_cnpj   TEXT NOT NULL,
      e_nome   TEXT NOT NULL,
      e_uf     TEXT NOT NULL DEFAULT '',
      d_doc    TEXT NOT NULL DEFAULT '',
      d_nome   TEXT NOT NULL DEFAULT '',
      d_uf     TEXT NOT NULL DEFAULT '',
      val      DOUBLE PRECISION NOT NULL,
      situacao TEXT NOT NULL DEFAULT 'autorizada',
      origem   TEXT NOT NULL DEFAULT 'manual',
      manif    TEXT,
      UNIQUE (user_id, chave)
    )`,
    ...(sqlite ? [] : MIGRATIONS),
    'CREATE INDEX IF NOT EXISTS idx_notes_user_date ON notes (user_id, date)',
    // XML de cada nota, guardado compactado (gzip em base64). full = 0 quando a SEFAZ só entregou o resumo.
    `CREATE TABLE IF NOT EXISTS xmls (
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      chave   TEXT NOT NULL,
      full_xml INTEGER NOT NULL DEFAULT 1,
      gz      TEXT NOT NULL,
      PRIMARY KEY (user_id, chave)
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at DOUBLE PRECISION NOT NULL,
      last_seen  DOUBLE PRECISION NOT NULL,
      expires_at DOUBLE PRECISION NOT NULL,
      ip         TEXT NOT NULL DEFAULT '',
      ua         TEXT NOT NULL DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)',
    `CREATE TABLE IF NOT EXISTS login_attempts (
      attempt_key TEXT PRIMARY KEY,
      attempts    INTEGER NOT NULL DEFAULT 0,
      until_ts    DOUBLE PRECISION NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id      ${id},
      ts      DOUBLE PRECISION NOT NULL,
      user_id INTEGER,
      email   TEXT NOT NULL DEFAULT '',
      action  TEXT NOT NULL,
      target  TEXT NOT NULL DEFAULT '',
      ip      TEXT NOT NULL DEFAULT '',
      detail  TEXT NOT NULL DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts)',
    // Certificado A1 do cliente (chave privada e certificado), sempre criptografado.
    `CREATE TABLE IF NOT EXISTS certificates (
      user_id     INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
      sealed      TEXT NOT NULL,
      subject     TEXT NOT NULL DEFAULT '',
      cert_doc    TEXT NOT NULL DEFAULT '',
      not_after   DOUBLE PRECISION NOT NULL,
      uploaded_at DOUBLE PRECISION NOT NULL
    )`,
    // Estado da busca automática na SEFAZ, por cliente.
    `CREATE TABLE IF NOT EXISTS sync_state (
      user_id     INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
      enabled     INTEGER NOT NULL DEFAULT 1,
      ciencia     INTEGER NOT NULL DEFAULT 0,
      nsu_nfe     TEXT NOT NULL DEFAULT '000000000000000',
      nsu_cte     TEXT NOT NULL DEFAULT '000000000000000',
      next_nfe    DOUBLE PRECISION NOT NULL DEFAULT 0,
      next_cte    DOUBLE PRECISION NOT NULL DEFAULT 0,
      lock_until  DOUBLE PRECISION NOT NULL DEFAULT 0,
      last_run    DOUBLE PRECISION,
      last_status TEXT NOT NULL DEFAULT '',
      last_msg    TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      skey  TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ];
}
