// /api/admin/clients (listar e cadastrar clientes)
import { handleApi } from '../../../lib/routes.js';

export default function handler(req, res) {
  return handleApi(req, res, new URL('/api/admin/clients', 'http://localhost'));
}
