// Adaptador SQLite usado só nos testes locais: aceita as mesmas consultas ($1, $2...) do Postgres.
import { DatabaseSync } from 'node:sqlite';

export function createDriver(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    isSqlite: true,
    async query(text, params = []) {
      const statement = db.prepare(text.replace(/\$(\d+)/g, '?$1'));
      if (/^\s*(SELECT|WITH)/i.test(text) || /RETURNING/i.test(text)) return statement.all(...params).map((row) => ({ ...row }));
      statement.run(...params);
      return [];
    },
  };
}
