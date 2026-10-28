// Leitura de NF-e (XML) no navegador. O .zip é aberto aqui; o servidor recebe só os dados das notas.
const first = (element, tag) => element?.getElementsByTagNameNS('*', tag)[0];
const text = (element, tag) => first(element, tag)?.textContent.trim() ?? '';

export function parseNfe(xml) {
  const doc = new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;

  const inf = first(doc, 'infNFe');
  if (!inf) return null;

  const ide = first(inf, 'ide');
  const emit = first(inf, 'emit');
  const dest = first(inf, 'dest');
  const issued = text(ide, 'dhEmi') || text(ide, 'dEmi');
  const eCnpj = text(emit, 'CNPJ') || text(emit, 'CPF');
  const nf = text(ide, 'nNF');
  const chave = (inf.getAttribute('Id') || '').replace('NFe', '') || `${eCnpj}-${nf}`;

  return {
    chave,
    date: issued.slice(0, 10),
    nf,
    eCnpj,
    eNome: text(emit, 'xNome'),
    eUF: text(emit, 'UF'),
    val: parseFloat(text(inf, 'vNFTot') || text(inf, 'vNF')) || 0,
    destDoc: text(dest, 'CNPJ') || text(dest, 'CPF'),
  };
}

export async function readFiles(files) {
  const notes = [];
  let bad = 0;
  const add = (xml) => {
    const note = parseNfe(xml);
    if (note) notes.push(note);
    else bad += 1;
  };

  for (const file of files) {
    try {
      if (/\.zip$/i.test(file.name)) {
        const zip = await window.JSZip.loadAsync(file);
        for (const entry of Object.values(zip.files)) {
          if (entry.dir || /__MACOSX/.test(entry.name) || !/\.xml$/i.test(entry.name)) continue;
          add(await entry.async('string'));
        }
      } else if (/\.xml$/i.test(file.name)) {
        add(await file.text());
      }
    } catch {
      bad += 1;
    }
  }
  return { notes, bad };
}
