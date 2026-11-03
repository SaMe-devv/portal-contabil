// /api/admin/clients/:id (editar e excluir cliente)
import { handleApi } from '../../../lib/routes.js';

export default function handler(req, res) {
  return handleApi(req, res, new URL(`/api/admin/clients/${req.query.id}`, 'http://localhost'));
}
