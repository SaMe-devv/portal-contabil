// Leitura simples de XML fiscal no servidor (sem dependências). Ignora prefixos de namespace.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export const unescapeXml = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? m;
});

export const escapeXml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Conteúdo interno do primeiro <tag>...</tag> (ou '' se não houver).
export function block(xml, tag) {
  if (!xml) return '';
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`);
  const m = re.exec(xml);
  return m ? m[1] : '';
}

// Texto do primeiro elemento encontrado entre as tags informadas (primeira que existir).
export function text(xml, ...tags) {
  for (const tag of tags) {
    const inner = block(xml, tag);
    if (inner) return unescapeXml(inner.replace(/<[^>]+>/g, '').trim());
  }
  return '';
}

// Atributo da primeira ocorrência de <tag ...>.
export function attr(xml, tag, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\s[^>]*\\b${name}="([^"]*)"`).exec(xml || '');
  return m ? unescapeXml(m[1]) : '';
}

// Todas as ocorrências de <tag atributos>conteúdo</tag>.
export function all(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml || ''))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
    out.push({ attrs, inner: m[2] });
  }
  return out;
}
