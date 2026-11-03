// Única função serverless: recebe tudo que chega em /api/* e repassa ao roteador.
import { handleApi } from '../lib/routes.js';

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  return handleApi(req, res, url);
}
