// Leitura de documentos fiscais (XML) no navegador: NF-e, NFC-e, CT-e e NFS-e.
// O .zip é aberto aqui; o servidor recebe só os dados essenciais de cada nota.
const first = (element, ...tags) => {
  for (const tag of tags) {
    const node = element?.getElementsByTagNameNS('*', tag)[0];
    if (node) return node;
  }
  return null;
};
const text = (element, ...tags) => first(element, ...tags)?.textContent.trim() ?? '';

const REASONS = {
  invalid: 'XML inválido ou corrompido',
  mdfe: 'MDF-e (manifesto de transporte, sem valor de compra ou venda)',
  notDoc: 'documento não reconhecido (esperado: NF-e, NFC-e, CT-e ou NFS-e; eventos e cancelamentos são ignorados)',
};

const FULL_PROFILE = (el, uf) => ({
  nome: text(el, 'xNome'), ie: text(el, 'IE'), lgr: text(el, 'xLgr'), nro: text(el, 'nro'), cpl: text(el, 'xCpl'),
  bairro: text(el, 'xBairro'), mun: text(el, 'xMun'), uf, cep: text(el, 'CEP'), fone: text(el, 'fone'),
});

// Lê uma parte da nota (emitente, destinatário, tomador...).
function party(el, { fullProfile = true } = {}) {
  if (!el) return { doc: '', nome: '', uf: '', profile: {} };
  const nome = text(el, 'xNome', 'RazaoSocial');
  const uf = text(el, 'UF', 'Uf');
  return {
    doc: text(el, 'CNPJ', 'Cnpj', 'CPF', 'Cpf'),
    nome,
    uf,
    profile: fullProfile ? FULL_PROFILE(el, uf) : { nome, uf },
  };
}

const isoDate = (value) => {
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(value);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : value.slice(0, 10);
};

// Formato interno único para todos os tipos de nota.
function build({ tipo, chave, date, nf, val, emit, dest }) {
  return {
    note: {
      tipo,
      chave,
      date: isoDate(date),
      nf,
      val: parseFloat(val) || 0,
      eCnpj: emit.doc,
      eNome: emit.nome,
      eUF: emit.uf,
      destDoc: dest.doc,
      destNome: dest.nome,
      destUF: dest.uf,
      // Perfis usados só para pré-preencher o cadastro do cliente (não são enviados ao servidor).
      emitProfile: emit.profile,
      destProfile: dest.profile,
    },
  };
}

function parseNfe(inf) {
  const ide = first(inf, 'ide');
  const emit = party(first(inf, 'emit'));
  const dest = party(first(inf, 'dest'));
  return build({
    tipo: text(ide, 'mod') === '65' ? 'NFC-e' : 'NF-e',
    chave: (inf.getAttribute('Id') || '').replace('NFe', '') || `${emit.doc}-${text(ide, 'nNF')}`,
    date: text(ide, 'dhEmi', 'dEmi'),
    nf: text(ide, 'nNF'),
    val: text(inf, 'vNFTot') || text(inf, 'vNF'),
    emit,
    dest,
  });
}

// CT-e / CT-e OS: o "destinatário" é o tomador do serviço (quem paga o frete).
function parseCte(inf) {
  const ide = first(inf, 'ide');
  const emit = party(first(inf, 'emit'));
  let tomador = party(null);
  const toma4 = first(ide, 'toma4');
  const toma3 = first(ide, 'toma3', 'toma03');
  if (toma4) {
    tomador = party(toma4);
  } else if (toma3) {
    const role = { 0: 'rem', 1: 'exped', 2: 'receb', 3: 'dest' }[text(toma3, 'toma')];
    tomador = party(role ? first(inf, role) : null);
  } else if (first(inf, 'toma')) {
    tomador = party(first(inf, 'toma')); // CT-e OS
  }
  return build({
    tipo: 'CT-e',
    chave: (inf.getAttribute('Id') || '').replace('CTe', '') || `${emit.doc}-${text(ide, 'nCT')}`,
    date: text(ide, 'dhEmi'),
    nf: text(ide, 'nCT'),
    val: text(inf, 'vTPrest'),
    emit,
    dest: tomador,
  });
}

// NFS-e padrão nacional.
function parseNfseNacional(inf) {
  const dps = first(inf, 'infDPS');
  const emit = party(first(inf, 'emit'));
  const toma = party(first(dps || inf, 'toma'));
  const number = text(inf, 'nNFSe');
  return build({
    tipo: 'NFS-e',
    chave: inf.getAttribute('Id') || `${emit.doc}-${number}`,
    date: text(dps, 'dhEmi') || text(inf, 'dhProc'),
    nf: number,
    val: text(dps, 'vServ') || text(inf, 'vLiq'),
    emit,
    dest: toma,
  });
}

// NFS-e no padrão ABRASF (usado por muitos municípios).
function parseNfseAbrasf(inf) {
  const emit = party(first(inf, 'PrestadorServico', 'Prestador'), { fullProfile: false });
  const toma = party(first(inf, 'TomadorServico', 'Tomador'), { fullProfile: false });
  const number = text(inf, 'Numero');
  return build({
    tipo: 'NFS-e',
    chave: `${emit.doc}-${number}-${text(inf, 'CodigoVerificacao')}`,
    date: text(inf, 'DataEmissao'),
    nf: number,
    val: text(inf, 'ValorServicos') || text(inf, 'ValorLiquidoNfse'),
    emit,
    dest: toma,
  });
}

// Devolve { note } em caso de sucesso ou { error } com o motivo.
export function parseDocument(xml) {
  const doc = new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return { error: 'invalid' };

  const nfe = first(doc, 'infNFe');
  if (nfe) return parseNfe(nfe);
  const cte = first(doc, 'infCte', 'infCTe');
  if (cte) return parseCte(cte);
  const nfseNacional = first(doc, 'infNFSe');
  if (nfseNacional) return parseNfseNacional(nfseNacional);
  const nfseAbrasf = first(doc, 'InfNfse', 'InfNFSe');
  if (nfseAbrasf) return parseNfseAbrasf(nfseAbrasf);
  if (first(doc, 'infMDFe')) return { error: 'mdfe' };
  return { error: 'notDoc' };
}

// Lê .zip e .xml. Devolve as notas e a lista de arquivos ignorados com o motivo.
export async function readFiles(files) {
  const notes = [];
  const ignored = [];
  const add = (name, xml) => {
    const { note, error } = parseDocument(xml);
    if (note) notes.push(note);
    else ignored.push({ name, reason: REASONS[error] });
  };

  for (const file of files) {
    try {
      if (/\.zip$/i.test(file.name)) {
        if (!window.JSZip) throw new Error('JSZip não carregou');
        const zip = await window.JSZip.loadAsync(file);
        for (const entry of Object.values(zip.files)) {
          if (entry.dir || /__MACOSX/.test(entry.name)) continue;
          if (!/\.xml$/i.test(entry.name)) {
            ignored.push({ name: entry.name, reason: 'não é um arquivo .xml' });
            continue;
          }
          add(entry.name, await entry.async('string'));
        }
      } else if (/\.xml$/i.test(file.name)) {
        add(file.name, await file.text());
      } else {
        ignored.push({ name: file.name, reason: 'formato não aceito (use .zip ou .xml)' });
      }
    } catch (error) {
      ignored.push({ name: file.name, reason: `não foi possível abrir (${error.message})` });
    }
  }
  return { notes, ignored };
}

// Campos que seguem para o servidor (sem os perfis de cadastro).
export const toWire = ({ emitProfile, destProfile, ...wire }) => wire;

export function summarizeIgnored(ignored) {
  const byReason = new Map();
  for (const { name, reason } of ignored) {
    const item = byReason.get(reason) || { count: 0, example: name };
    item.count += 1;
    byReason.set(reason, item);
  }
  return [...byReason].map(([reason, { count, example }]) => `${count} arquivo(s): ${reason} (ex.: ${example})`);
}
