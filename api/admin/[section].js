// /api/admin/audit
import { handleApi } from '../../lib/routes.js';

export default function handler(req, res) {
  return handleApi(req, res, new URL(`/api/admin/${req.query.section}`, 'http://localhost'));
}
