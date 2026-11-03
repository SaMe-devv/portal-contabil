// Registro de atividades (quem fez o quê, quando e de onde). Útil para LGPD e para investigar acessos.
import { query } from './db.js';
import { clientIp } from './http.js';

export async function audit(req, user, action, target = '', detail = '') {
  try {
    await query(
      'INSERT INTO audit_log (ts, user_id, email, action, target, ip, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [Date.now(), user?.id ?? null, String(user?.email ?? '').slice(0, 200), action, String(target).slice(0, 200), req ? clientIp(req) : '', String(detail).slice(0, 500)],
    );
  } catch (error) {
    console.error('audit', error); // o registro nunca deve derrubar a operação principal
  }
}

export const ACTION_LABELS = {
  login: 'Entrou no portal',
  login_fail: 'Tentativa de login recusada',
  login_blocked: 'Login bloqueado por excesso de tentativas',
  logout: 'Saiu do portal',
  logout_all: 'Encerrou todas as sessões',
  password_change: 'Trocou a própria senha',
  totp_on: 'Ativou a verificação em duas etapas',
  totp_off: 'Desativou a verificação em duas etapas',
  client_create: 'Cadastrou cliente',
  client_update: 'Alterou cliente',
  client_password: 'Gerou/definiu senha do cliente',
  client_block: 'Bloqueou acesso do cliente',
  client_unblock: 'Liberou acesso do cliente',
  client_delete: 'Excluiu cliente',
  notes_import: 'Importou XMLs',
  notes_clear: 'Apagou histórico de notas',
  cert_upload: 'Enviou certificado A1',
  cert_delete: 'Removeu certificado A1',
  sync_config: 'Alterou busca automática',
  sync_run: 'Buscou notas na SEFAZ',
  xml_download: 'Baixou XMLs',
  report_view: 'Abriu relatório',
};
