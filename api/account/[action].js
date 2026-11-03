// /api/account/password | logout-all | totp-setup | totp-enable | totp-disable
import { handleApi } from '../../lib/routes.js';

export default function handler(req, res) {
  return handleApi(req, res, new URL(`/api/account/${req.query.action}`, 'http://localhost'));
}
