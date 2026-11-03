// Cadeia de certificados ICP-Brasil: os servidores da SEFAZ usam certificados emitidos por ela,
// que não vêm na lista padrão do Node. Baixamos o pacote oficial do ITI, conferimos o SHA-512 e guardamos no banco.
import crypto from 'node:crypto';
import tls from 'node:tls';
import { query } from './db.js';

const ZIP_URL = 'https://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip';
const HASH_URL = 'https://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/hashsha512.txt';
const MAX_AGE = 30 * 24 * 3600 * 1000;

let memory = null;

function fromEnv() {
  const pem = process.env.ICP_BRASIL_CA_PEM;
  return pem ? pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [] : [];
}

async function download() {
  const [zipRes, hashRes] = await Promise.all([fetch(ZIP_URL), fetch(HASH_URL)]);
  if (!zipRes.ok || !hashRes.ok) throw new Error(`ITI respondeu ${zipRes.status}/${hashRes.status}`);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  const expected = ((await hashRes.text()).match(/[0-9a-f]{128}/i) || [])[0]?.toLowerCase();
  const actual = crypto.createHash('sha512').update(zip).digest('hex');
  if (!expected || expected !== actual) throw new Error('SHA-512 do pacote ICP-Brasil não confere');

  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(zip);
  const pems = [];
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !/\.(crt|cer|pem|der)$/i.test(entry.name)) continue;
    try {
      const cert = new crypto.X509Certificate(await entry.async('nodebuffer'));
      if (cert.ca && Date.parse(cert.validTo) > Date.now()) pems.push(cert.toString());
    } catch { /* arquivo que não é certificado */ }
  }
  if (!pems.length) throw new Error('pacote ICP-Brasil sem certificados');
  return pems;
}

// Lista de autoridades confiáveis para falar com a SEFAZ: padrão do Node + ICP-Brasil.
export async function sefazCa() {
  if (memory && Date.now() - memory.at < 6 * 3600 * 1000) return memory.ca;
  let icp = fromEnv();
  if (!icp.length) {
    const [row] = await query("SELECT value FROM settings WHERE skey = 'icp_ca'");
    const cached = row ? JSON.parse(row.value) : null;
    if (cached && Date.now() - cached.at < MAX_AGE) {
      icp = cached.pems;
    } else {
      try {
        icp = await download();
        const value = JSON.stringify({ at: Date.now(), pems: icp });
        await query(
          `INSERT INTO settings (skey, value) VALUES ('icp_ca', $1)
           ON CONFLICT (skey) DO UPDATE SET value = excluded.value`,
          [value],
        );
      } catch (error) {
        console.error('ICP-Brasil', error.message);
        icp = cached?.pems || []; // usa a versão antiga se houver; senão segue só com as autoridades padrão
      }
    }
  }
  memory = { at: Date.now(), ca: [...tls.rootCertificates, ...icp] };
  return memory.ca;
}
