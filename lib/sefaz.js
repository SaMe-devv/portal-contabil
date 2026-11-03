// Comunicação com os web services nacionais da SEFAZ usando o certificado A1 do cliente:
// - Distribuição DF-e da NF-e (NT 2014.002) e do CT-e (NT 2015.002): baixa notas em que o cliente é interessado.
// - Recepção de Evento (Ambiente Nacional): manifestação "Ciência da Operação", que libera o XML completo da NF-e.
import crypto from 'node:crypto';
import https from 'node:https';
import zlib from 'node:zlib';
import { sefazCa } from './icp.js';
import { all, block, escapeXml, text } from './xml.js';

export const UF_CODES = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27,
  SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53,
};
export const UF_BY_CODE = Object.fromEntries(Object.entries(UF_CODES).map(([uf, code]) => [String(code), uf]));

const ambiente = () => (process.env.SEFAZ_AMBIENTE === '2' ? 2 : 1);

const URLS = {
  nfeDist: ['https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'],
  cteDist: ['https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx', 'https://hom1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx'],
  evento: ['https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'],
};
const ENV_OVERRIDE = { nfeDist: 'SEFAZ_URL_NFE_DIST', cteDist: 'SEFAZ_URL_CTE_DIST', evento: 'SEFAZ_URL_EVENTO' };
const url = (service) => process.env[ENV_OVERRIDE[service]] || URLS[service][ambiente() - 1];

export class SefazError extends Error {
  constructor(message, cStat = '') {
    super(message);
    this.cStat = cStat;
  }
}

/* ---------- transporte SOAP 1.2 com certificado do cliente ---------- */

async function soap(service, action, bodyXml, cred) {
  const envelope = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
    + `<soap12:Body>${bodyXml}</soap12:Body></soap12:Envelope>`;
  const target = new URL(url(service));
  const ca = await sefazCa();
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      key: cred.keyPem,
      cert: [cred.certPem, ...(cred.chainPem || [])].join('\n'),
      ca,
      minVersion: 'TLSv1.2',
      timeout: 30000,
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`,
        'Content-Length': Buffer.byteLength(envelope),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 500 && !/<(?:\w+:)?cStat>/.test(body)) {
          reject(new SefazError(`SEFAZ indisponível (HTTP ${res.statusCode}).`));
        } else {
          resolve(body);
        }
      });
    });
    req.on('timeout', () => req.destroy(new SefazError('SEFAZ não respondeu a tempo.')));
    req.on('error', (error) => {
      if (error instanceof SefazError) return reject(error);
      if (/certificate|self.signed|issuer/i.test(error.message)) {
        return reject(new SefazError(`Falha na conexão segura com a SEFAZ (${error.code || error.message}). Veja "Cadeia ICP-Brasil" no LEIAME.`));
      }
      return reject(new SefazError(`Falha de conexão com a SEFAZ (${error.code || error.message}).`));
    });
    req.end(envelope);
  });
}

/* ---------- Distribuição DF-e ---------- */

function parseDist(xml) {
  const ret = block(xml, 'retDistDFeInt') || xml;
  return {
    cStat: text(ret, 'cStat'),
    xMotivo: text(ret, 'xMotivo'),
    ultNSU: text(ret, 'ultNSU'),
    maxNSU: text(ret, 'maxNSU'),
    docs: all(ret, 'docZip').map(({ attrs, inner }) => {
      const gz = inner.trim();
      return { nsu: attrs.NSU || '', schema: attrs.schema || '', gz, xml: zlib.gunzipSync(Buffer.from(gz, 'base64')).toString('utf8') };
    }),
  };
}

const docTag = (doc) => (doc.length === 11 ? `<CPF>${doc}</CPF>` : `<CNPJ>${doc}</CNPJ>`);

export async function distNfe(cred, { doc, uf, ultNSU }) {
  const cUF = UF_CODES[uf] ? `<cUFAutor>${UF_CODES[uf]}</cUFAutor>` : '';
  const body = '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>'
    + `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${ambiente()}</tpAmb>${cUF}${docTag(doc)}`
    + `<distNSU><ultNSU>${String(ultNSU).padStart(15, '0')}</ultNSU></distNSU></distDFeInt>`
    + '</nfeDadosMsg></nfeDistDFeInteresse>';
  return parseDist(await soap('nfeDist', 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse', body, cred));
}

export async function distCte(cred, { doc, uf, ultNSU }) {
  const cUF = UF_CODES[uf] ? `<cUFAutor>${UF_CODES[uf]}</cUFAutor>` : '';
  const body = '<cteDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe"><cteDadosMsg>'
    + `<distDFeInt xmlns="http://www.portalfiscal.inf.br/cte" versao="1.00"><tpAmb>${ambiente()}</tpAmb>${cUF}${docTag(doc)}`
    + `<distNSU><ultNSU>${String(ultNSU).padStart(15, '0')}</ultNSU></distNSU></distDFeInt>`
    + '</cteDadosMsg></cteDistDFeInteresse>';
  return parseDist(await soap('cteDist', 'http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe/cteDistDFeInteresse', body, cred));
}

/* ---------- Ciência da Operação (evento 210210), assinada com o certificado do cliente ---------- */

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

// Assina infEvento (XMLDSig enveloped, RSA-SHA1, C14N), como exige o layout da NF-e.
export function signInfEvento(infEventoCanonical, id, cred) {
  const digest = crypto.createHash('sha1').update(infEventoCanonical, 'utf8').digest('base64');
  const signedInfo = '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">'
    + `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>`
    + '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>'
    + `<Reference URI="#${id}"><Transforms>`
    + '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>'
    + `<Transform Algorithm="${C14N}"></Transform></Transforms>`
    + '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>'
    + `<DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const signature = crypto.sign('RSA-SHA1', Buffer.from(signedInfo, 'utf8'), cred.keyPem).toString('base64');
  const x509 = cred.certPem.replace(/-----[^-]+-----|\s/g, '');
  return `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<SignatureValue>${signature}</SignatureValue>`
    + `<KeyInfo><X509Data><X509Certificate>${x509}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

const brTime = (now = new Date()) => {
  const local = new Date(now.getTime() - 3 * 3600 * 1000); // horário de Brasília (sem horário de verão desde 2019)
  return `${local.toISOString().slice(0, 19)}-03:00`;
};

export function buildCiencia(cred, { doc, chave, now }) {
  const id = `ID210210${chave}01`;
  const inner = `<cOrgao>91</cOrgao><tpAmb>${ambiente()}</tpAmb>${docTag(doc)}<chNFe>${chave}</chNFe>`
    + `<dhEvento>${brTime(now)}</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>`
    + '<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento>';
  // Forma canônica: o namespace herdado de envEvento aparece no próprio infEvento.
  const canonical = `<infEvento xmlns="http://www.portalfiscal.inf.br/nfe" Id="${id}">${inner}</infEvento>`;
  const signature = signInfEvento(canonical, id, cred);
  return `<evento versao="1.00"><infEvento Id="${id}">${inner}</infEvento>${signature}</evento>`;
}

// Envia até 20 ciências por lote. Devolve { chave: { ok, cStat, xMotivo } }.
export async function sendCiencias(cred, { doc, chaves }) {
  const eventos = chaves.map((chave) => buildCiencia(cred, { doc, chave }));
  const lote = String(Date.now()).slice(-15);
  const body = '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">'
    + `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>${lote}</idLote>${eventos.join('')}</envEvento>`
    + '</nfeDadosMsg>';
  const xml = await soap('evento', 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento', body, cred);
  const lot = block(xml, 'retEnvEvento') || xml;
  const loteStat = text(lot, 'cStat');
  if (loteStat !== '128') throw new SefazError(`Evento recusado: ${loteStat} ${escapeXml(text(lot, 'xMotivo'))}`, loteStat);
  const result = {};
  for (const { inner } of all(lot, 'retEvento')) {
    const cStat = text(inner, 'cStat');
    result[text(inner, 'chNFe')] = { ok: ['135', '136', '573'].includes(cStat), cStat, xMotivo: text(inner, 'xMotivo') };
  }
  return result;
}
