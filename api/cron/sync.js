// /api/cron/sync — chamado pelo agendador da Vercel (06h e 18h, horário de Brasília).
import { handleApi } from '../../lib/routes.js';

export default function handler(req, res) {
  return handleApi(req, res, new URL('/api/cron/sync', 'http://localhost'));
}
