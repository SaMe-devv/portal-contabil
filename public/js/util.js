// Funções de apoio compartilhadas pelas páginas.
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const digits = (value) => String(value ?? '').replace(/\D/g, '');
// CPF/CNPJ normalizado (o CNPJ alfanumérico tem letras nas 12 primeiras posições).
export const docKey = (value) => String(value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

export const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
export const int = new Intl.NumberFormat('pt-BR');

export const percent = (value) => `${value.toLocaleString('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})}%`;

export const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export function fmtDateTime(ms) {
  if (!ms) return '';
  return new Date(Number(ms)).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDoc(value) {
  const d = docKey(value);
  if (d.length === 14) return d.replace(/(\w{2})(\w{3})(\w{3})(\w{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return value ?? '';
}

export const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="img/icons.svg#${name}"/></svg>`;
