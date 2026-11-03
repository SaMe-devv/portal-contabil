// /api/admin/clients/:id/notes (importar e apagar notas do cliente)
import { handleApi } from '../../../../lib/routes.js';

export default function handler(req, res) {
  return handleApi(req, res, new URL(`/api/admin/clients/${req.query.id}/notes`, 'http://localhost'));
}
