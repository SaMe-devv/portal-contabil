// Tabelas do banco (criadas automaticamente no primeiro acesso).
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
      id      ${id},
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      chave   TEXT NOT NULL,
      date    TEXT NOT NULL,
      nf      TEXT NOT NULL,
      e_cnpj  TEXT NOT NULL,
      e_nome  TEXT NOT NULL,
      e_uf    TEXT NOT NULL DEFAULT '',
      val     DOUBLE PRECISION NOT NULL,
      UNIQUE (user_id, chave)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_notes_user_date ON notes (user_id, date)',
    `CREATE TABLE IF NOT EXISTS login_attempts (
      attempt_key TEXT PRIMARY KEY,
      attempts    INTEGER NOT NULL DEFAULT 0,
      until_ts    DOUBLE PRECISION NOT NULL DEFAULT 0
    )`,
  ];
}
