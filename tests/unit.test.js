// Testes rápidos: rode com "npm test" (Node 22).
import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidCnpj, isValidCpf, docKey } from '../lib/doc.js';
import { currentCode, newSecret, verifyTotp } from '../lib/totp.js';
import { _test } from '../lib/pkcs12.js';
import { attr, block, text } from '../lib/xml.js';

test('CPF e CNPJ (inclusive alfanumérico)', () => {
  assert.ok(isValidCnpj('11.222.333/0001-81'));
  assert.ok(!isValidCnpj('11.222.333/0001-82'));
  assert.ok(isValidCnpj('12.ABC.345/01DE-35')); // exemplo oficial da Receita
  assert.ok(isValidCpf('529.982.247-25'));
  assert.ok(!isValidCpf('111.111.111-11'));
  assert.equal(docKey('12.abc.345/01de-35'), '12ABC34501DE35');
});

test('TOTP aceita o código atual e recusa reuso', () => {
  const secret = newSecret();
  const code = currentCode(secret);
  const counter = verifyTotp(secret, code);
  assert.notEqual(counter, null);
  assert.equal(verifyTotp(secret, code, counter), null);
  assert.equal(verifyTotp(secret, '000000'.replace(/./g, (d, i) => String((Number(code[i]) + 1) % 10))), null);
});

test('RC2 (certificados A1 antigos) confere com o OpenSSL', () => {
  const cipher = Buffer.from('511a3d0aebca506f3bed2401aed2e7f867a8aa29ed091cba', 'hex');
  const plain = _test.rc2CbcDecrypt(Buffer.from('0102030405', 'hex'), 40, Buffer.from('0001020304050607', 'hex'), cipher);
  assert.equal(plain.toString(), 'hello world 12345');
});

test('leitura de XML fiscal no servidor', () => {
  const xml = '<nfeProc><NFe><infNFe Id="NFe123"><emit><CNPJ>1</CNPJ><xNome>A &amp; B</xNome></emit></infNFe></NFe></nfeProc>';
  assert.equal(attr(xml, 'infNFe', 'Id'), 'NFe123');
  assert.equal(text(block(xml, 'emit'), 'xNome'), 'A & B');
});
