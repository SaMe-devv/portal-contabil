// CPF e CNPJ (inclusive o CNPJ alfanumérico, em vigor a partir de julho de 2026).

// Normaliza: maiúsculas, só letras e números.
export const docKey = (value) => String(value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

const charValue = (ch) => ch.charCodeAt(0) - 48; // regra oficial: valor ASCII menos 48 (0-9 => 0-9, A => 17 ...)

function cnpjDigit(base) {
  const weights = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = [...base].reduce((acc, ch, i) => acc + charValue(ch) * weights[i], 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidCnpj(value) {
  const v = docKey(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(v) || /^(\d)\1{13}$/.test(v)) return false;
  const d1 = cnpjDigit(v.slice(0, 12));
  const d2 = cnpjDigit(v.slice(0, 12) + d1);
  return v.endsWith(`${d1}${d2}`);
}

export function isValidCpf(value) {
  const v = docKey(value);
  if (!/^\d{11}$/.test(v) || /^(\d)\1{10}$/.test(v)) return false;
  const calc = (len) => {
    const sum = [...v.slice(0, len)].reduce((acc, ch, i) => acc + Number(ch) * (len + 1 - i), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === Number(v[9]) && calc(10) === Number(v[10]);
}

export const isValidDoc = (value) => isValidCpf(value) || isValidCnpj(value);

// Raiz do CNPJ (8 primeiros caracteres): certificados de matriz valem para as filiais na Distribuição DF-e.
export const cnpjRoot = (value) => docKey(value).slice(0, 8);
