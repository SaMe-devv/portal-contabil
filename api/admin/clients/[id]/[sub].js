// /api/admin/clients/:id/notes | cert | sync
import { handleApi } from '../../../../lib/routes.js';

export default function handler(req, res) {
  return handleApi(req, res, new URL(`/api/admin/clients/${req.query.id}/${req.query.sub}`, 'http://localhost'));
}
