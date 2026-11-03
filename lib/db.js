// Acesso ao banco. Em produção: Postgres (Neon) via DATABASE_URL.
// Nos testes locais (TEST_SQLITE=arquivo) usa um adaptador SQLite com as mesmas consultas.
import { HttpError } from './http.js';

let runner = null;

async function getRunner() {
  if (runner) return runner;

  if (process.env.TEST_SQLITE) {
    const adapter = '../tests/sqlite-driver.js';
    runner = (await import(adapter)).createDriver(process.env.TEST_SQLITE);
  } else {
    const url = process.env.DATABASE_URL;
    if (!url) throw new HttpError(500, 'Defina a variável DATABASE_URL (conexão com o banco Postgres).');
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    runner = { isSqlite: false, query: (text, params = []) => sql.query(text, params) };
  }
  return runner;
}

// Executa uma consulta com parâmetros $1, $2... e devolve as linhas.
export const query = async (text, params = []) => (await getRunner()).query(text, params);
export const usesSqlite = async () => (await getRunner()).isSqlite;

export const PROFILE_FIELDS = ['nome', 'ie', 'lgr', 'nro', 'cpl', 'bairro', 'mun', 'uf', 'cep', 'fone'];
