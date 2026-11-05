// /api/cron/sync — chamado pelo agendador da Vercel.
// ?modo=completo (6h e 18h): busca as notas novas. ?modo=retroativo (demais horas): recupera notas antigas, 18 por hora.
import { handleApi } from '../../lib/routes.js';

export default function handler(req, res) {
  const search = String(req.url || '').includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return handleApi(req, res, new URL(`/api/cron/sync${search}`, 'http://localhost'));
}
