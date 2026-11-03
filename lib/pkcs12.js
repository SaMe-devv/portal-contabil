// Leitura de certificado A1 (.pfx / .p12) sem dependências externas.
// Suporta os formatos antigos (3DES e RC2, comuns em certificados ICP-Brasil) e o atual (PBES2/AES).
import crypto from 'node:crypto';

/* ---------- ASN.1 (DER/BER, inclusive comprimento indefinido) ---------- */

function readNode(buf, pos) {
  const start = pos;
  const first = buf[pos++];
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b;
    do { b = buf[pos++]; tag = (tag << 7) | (b & 0x7f); } while (b & 0x80);
  }
  let len = buf[pos++];
  let indefinite = false;
  if (len === 0x80) {
    indefinite = true;
  } else if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) throw new Error('ASN.1: comprimento inválido');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  const node = { cls, tag, constructed, start, contentStart: pos, children: null };
  if (constructed) {
    node.children = [];
    if (indefinite) {
      while (!(buf[pos] === 0 && buf[pos + 1] === 0)) {
        const child = readNode(buf, pos);
        node.children.push(child);
        pos = child.end;
      }
      node.contentEnd = pos;
      node.end = pos + 2;
    } else {
      const end = pos + len;
      while (pos < end) {
        const child = readNode(buf, pos);
        node.children.push(child);
        pos = child.end;
      }
      node.contentEnd = end;
      node.end = end;
    }
  } else {
    if (indefinite) throw new Error('ASN.1: primitivo com comprimento indefinido');
    node.contentEnd = pos + len;
    node.end = pos + len;
    if (node.end > buf.length) throw new Error('ASN.1: arquivo truncado');
  }
  node.buf = buf;
  return node;
}

const parse = (buf) => readNode(buf, 0);
const content = (node) => node.buf.subarray(node.contentStart, node.contentEnd);

// OCTET STRING primitivo ou construído (BER).
function octets(node) {
  if (!node.constructed) return content(node);
  return Buffer.concat(node.children.map(octets));
}

function oid(node) {
  const bytes = content(node);
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(value); value = 0; }
  }
  return parts.join('.');
}

const int = (node) => content(node).reduce((acc, b) => acc * 256 + b, 0);
const explicit = (node) => node.children[0]; // [n] EXPLICIT: o conteúdo é o primeiro filho

/* ---------- RC2 (RFC 2268), necessário para certificados antigos ---------- */

const PITABLE = Buffer.from(
  'd978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb6266fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052eef784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731'
  + '2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad',
  'hex',
);

function rc2Keys(key, effectiveBits) {
  const L = Buffer.alloc(128);
  key.copy(L);
  const T = key.length;
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 255];
  const T8 = Math.ceil(effectiveBits / 8);
  const TM = 255 % (2 ** (8 + effectiveBits - 8 * T8));
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}

function rc2DecryptBlock(K, block) {
  const R = [block.readUInt16LE(0), block.readUInt16LE(2), block.readUInt16LE(4), block.readUInt16LE(6)];
  const S = [1, 2, 3, 5];
  let j = 63;
  const unmix = () => {
    for (let i = 3; i >= 0; i--) {
      R[i] = ((R[i] >>> S[i]) | (R[i] << (16 - S[i]))) & 0xffff;
      R[i] = (R[i] - K[j] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3])) & 0xffff;
      j--;
    }
  };
  const unmash = () => { for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
  for (let r = 0; r < 5; r++) unmix();
  unmash();
  for (let r = 0; r < 6; r++) unmix();
  unmash();
  for (let r = 0; r < 5; r++) unmix();
  const out = Buffer.alloc(8);
  R.forEach((w, i) => out.writeUInt16LE(w, i * 2));
  return out;
}

function rc2CbcDecrypt(key, effectiveBits, iv, data) {
  if (data.length % 8) throw new Error('RC2: tamanho inválido');
  const K = rc2Keys(key, effectiveBits);
  const out = Buffer.alloc(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 8) {
    const block = data.subarray(off, off + 8);
    const plain = rc2DecryptBlock(K, block);
    for (let i = 0; i < 8; i++) out[off + i] = plain[i] ^ prev[i];
    prev = block;
  }
  return unpad(out);
}

function unpad(buf) {
  const n = buf[buf.length - 1];
  if (n < 1 || n > 16 || n > buf.length) throw new Error('padding');
  for (let i = buf.length - n; i < buf.length; i++) if (buf[i] !== n) throw new Error('padding');
  return buf.subarray(0, buf.length - n);
}

/* ---------- derivação de chave PKCS#12 (RFC 7292, apêndice B) ---------- */

const bmpPassword = (password) => {
  const out = Buffer.alloc((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++) out.writeUInt16BE(password.charCodeAt(i), i * 2);
  return out;
};

function pkcs12Kdf(password, salt, id, iterations, n) {
  const u = 20; const v = 64;
  const D = Buffer.alloc(v, id);
  const fill = (src) => {
    if (!src.length) return Buffer.alloc(0);
    const len = v * Math.ceil(src.length / v);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = src[i % src.length];
    return out;
  };
  const I = Buffer.concat([fill(salt), fill(bmpPassword(password))]);
  const result = [];
  for (let produced = 0; produced < n; produced += u) {
    let A = crypto.createHash('sha1').update(D).update(I).digest();
    for (let r = 1; r < iterations; r++) A = crypto.createHash('sha1').update(A).digest();
    result.push(A);
    const B = fill(A);
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(result).subarray(0, n);
}

/* ---------- algoritmos de cifragem ---------- */

const PBE = {
  '1.2.840.113549.1.12.1.3': { cipher: 'des-ede3-cbc', key: 24 }, // pbeWithSHAAnd3-KeyTripleDES-CBC
  '1.2.840.113549.1.12.1.4': { cipher: 'des-ede-cbc', key: 16 }, // pbeWithSHAAnd2-KeyTripleDES-CBC
  '1.2.840.113549.1.12.1.5': { rc2: 128, key: 16 }, // pbeWithSHAAnd128BitRC2-CBC
  '1.2.840.113549.1.12.1.6': { rc2: 40, key: 5 }, // pbeWithSHAAnd40BitRC2-CBC
};
const PRF = {
  '1.2.840.113549.2.7': 'sha1', '1.2.840.113549.2.9': 'sha256', '1.2.840.113549.2.10': 'sha384', '1.2.840.113549.2.11': 'sha512',
};
const CIPHERS = {
  '2.16.840.1.101.3.4.1.2': ['aes-128-cbc', 16], '2.16.840.1.101.3.4.1.22': ['aes-192-cbc', 24],
  '2.16.840.1.101.3.4.1.42': ['aes-256-cbc', 32], '1.2.840.113549.3.7': ['des-ede3-cbc', 24],
};

function decipher(name, key, iv, data) {
  const d = crypto.createDecipheriv(name, key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

// algNode = AlgorithmIdentifier; devolve os bytes decifrados.
function decrypt(algNode, data, password) {
  const algOid = oid(algNode.children[0]);
  const params = algNode.children[1];
  const pbe = PBE[algOid];
  if (pbe) {
    const salt = content(params.children[0]);
    const iterations = int(params.children[1]);
    const key = pkcs12Kdf(password, salt, 1, iterations, pbe.key);
    const iv = pkcs12Kdf(password, salt, 2, iterations, 8);
    return pbe.rc2 ? rc2CbcDecrypt(key, pbe.rc2, iv, data) : decipher(pbe.cipher, key, iv, data);
  }
  if (algOid === '1.2.840.113549.1.5.13') { // PBES2
    const [kdf, scheme] = params.children;
    if (oid(kdf.children[0]) !== '1.2.840.113549.1.5.12') throw new Error('KDF não suportado');
    const kp = kdf.children[1].children;
    const salt = content(kp[0]);
    const iterations = int(kp[1]);
    const prfNode = kp.find((n, i) => i >= 2 && n.constructed);
    const digest = prfNode ? PRF[oid(prfNode.children[0])] : 'sha1';
    const cipher = CIPHERS[oid(scheme.children[0])];
    if (!digest || !cipher) throw new Error('Cifra não suportada');
    const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, cipher[1], digest);
    return decipher(cipher[0], key, content(scheme.children[1]), data);
  }
  throw new Error(`Algoritmo não suportado (${algOid})`);
}

/* ---------- estrutura do PFX ---------- */

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509: '1.2.840.113549.1.9.22.1',
};

function readBags(safeContentsDer, password, out) {
  for (const bag of parse(safeContentsDer).children) {
    const type = oid(bag.children[0]);
    const value = explicit(bag.children[1]);
    if (type === OID.keyBag) {
      out.keys.push(crypto.createPrivateKey({ key: value.buf.subarray(value.start, value.end), format: 'der', type: 'pkcs8' }));
    } else if (type === OID.shroudedKeyBag) {
      const [alg, enc] = value.children;
      const der = decrypt(alg, octets(enc), password);
      out.keys.push(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
    } else if (type === OID.certBag) {
      if (oid(value.children[0]) === OID.x509) out.certs.push(new crypto.X509Certificate(octets(explicit(value.children[1]))));
    }
  }
}

export class CertificateError extends Error {}

// Confere a senha pelo MAC do arquivo (quando é SHA-1, o caso de quase todos os A1).
function checkMac(macData, authContent, password) {
  if (!macData) return;
  const digestInfo = macData.children[0];
  if (oid(digestInfo.children[0].children[0]) !== '1.3.14.3.2.26') return;
  const expected = content(digestInfo.children[1]);
  const salt = content(macData.children[1]);
  const iterations = macData.children[2] ? int(macData.children[2]) : 1;
  const key = pkcs12Kdf(password, salt, 3, iterations, 20);
  const actual = crypto.createHmac('sha1', key).update(authContent).digest();
  if (!crypto.timingSafeEqual(actual, expected)) throw new CertificateError('Senha do certificado incorreta.');
}

// Devolve { keyPem, certPem, chainPem, subject, doc, notBefore, notAfter }.
export function readPfx(pfx, password) {
  let root;
  try {
    root = parse(Buffer.from(pfx));
  } catch {
    throw new CertificateError('Arquivo inválido: envie o certificado A1 no formato .pfx ou .p12.');
  }
  if (!root.constructed || !root.children || root.children.length < 2 || !root.children[1].constructed) {
    throw new CertificateError('Arquivo inválido: envie o certificado A1 no formato .pfx ou .p12.');
  }
  const out = { keys: [], certs: [] };
  try {
    const authSafe = root.children[1];
    if (oid(authSafe.children[0]) !== OID.data) throw new Error('authSafe');
    const authContent = octets(explicit(authSafe.children[1]));
    checkMac(root.children[2], authContent, password);
    const infos = parse(authContent);
    for (const info of infos.children) {
      const type = oid(info.children[0]);
      if (type === OID.data) {
        readBags(octets(explicit(info.children[1])), password, out);
      } else if (type === OID.encryptedData) {
        const encInfo = explicit(info.children[1]).children[1];
        const [, alg, encContent] = encInfo.children;
        readBags(decrypt(alg, octets(encContent), password), password, out);
      }
    }
  } catch (error) {
    if (error instanceof CertificateError) throw error;
    if (/padding|bad decrypt|wrong final block/i.test(error.message)) throw new CertificateError('Senha do certificado incorreta.');
    throw new CertificateError(`Não foi possível ler o certificado (${error.message}).`);
  }

  const key = out.keys[0];
  const cert = key && out.certs.find((c) => c.checkPrivateKey(key));
  if (!cert) throw new CertificateError('O arquivo não contém a chave privada junto com o certificado. Exporte o A1 com a chave privada.');

  const subject = cert.subject;
  const cn = (/CN=([^\n]+)/.exec(subject) || [])[1] || '';
  const doc = ((/:([0-9A-Z]{14}|\d{11})\s*$/.exec(cn) || [])[1]) || '';
  return {
    keyPem: key.export({ type: 'pkcs8', format: 'pem' }),
    certPem: cert.toString(),
    chainPem: out.certs.filter((c) => c !== cert).map((c) => c.toString()),
    subject: cn || subject,
    doc,
    notBefore: Date.parse(cert.validFrom),
    notAfter: Date.parse(cert.validTo),
  };
}

export const _test = { rc2CbcDecrypt, pkcs12Kdf };
