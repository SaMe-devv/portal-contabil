// Funções de apoio compartilhadas pelas páginas.
export const $ = (selector, root = document) => root.querySelector(selector);

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const digits = (value) => String(value ?? '').replace(/\D/g, '');

export const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export const percent = (value) => `${value.toLocaleString('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})}%`;

export const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export function fmtDoc(value) {
  const d = digits(value);
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return value ?? '';
}
