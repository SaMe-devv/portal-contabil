// Busca automática de notas na SEFAZ (Distribuição DF-e), cliente a cliente.
import { query } from './db.js';
import { docKey } from './doc.js';
import { open } from './vault.js';
import { SefazError, UF_BY_CODE, distCte, distNfe, sendCiencias } from './sefaz.js';
import { attr, block, text } from './xml.js';

const HOUR = 3600 * 1000;
const MAX_PAGES = 40; // 50 documentos por página
const LOCK_MS = 6 * 60 * 1000;

const isoDate = (v) => {
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(v || '');
  return br ? `${br[3]}-${br[2]}-${br[1]}` : String(v || '').slice(0, 10);
};
const ufFromKey = (chave) => UF_BY_CODE[String(chave).slice(0, 2)] || '';
const nfFromKey = (chave) => String(Number(String(chave).slice(25, 34)) || '');
const SITUACAO = { 1: 'autorizada', 2: 'denegada', 3: 'cancelada' };

/* ---------- gravação ---------- */

async function upsertNote(client, n, { full }) {
  const values = [
    client.id, n.chave, n.date, n.nf, n.tipo, n.op, n.eDoc, n.eNome.slice(0, 150), n.eUF,
    n.dDoc, n.dNome.slice(0, 150), n.dUF, n.val, n.situacao, 'sefaz', n.manif ?? null,
  ];
  const sql = `INSERT INTO notes (user_id, chave, date, nf, tipo, op, e_cnpj, e_nome, e_uf, d_doc, d_nome, d_uf, val, situacao, origem, manif)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (user_id, chave) DO ${full
    ? `UPDATE SET date = excluded.date, nf = excluded.nf, tipo = excluded.tipo, op = excluded.op, e_cnpj = excluded.e_cnpj,
         e_nome = excluded.e_nome, e_uf = excluded.e_uf, d_doc = excluded.d_doc, d_nome = excluded.d_nome, d_uf = excluded.d_uf,
         val = excluded.val, manif = CASE WHEN notes.manif IS NULL THEN NULL ELSE 'ok' END`
    : 'NOTHING'}
    RETURNING id`;
  const rows = await query(sql, values);
  return rows.length > 0;
}

async function saveXml(client, chave, gz, full) {
  await query(
    `INSERT INTO xmls (user_id, chave, full_xml, gz) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, chave) DO ${full ? 'UPDATE SET full_xml = 1, gz = excluded.gz' : 'NOTHING'}`,
    [client.id, chave, full ? 1 : 0, gz],
  );
}

const setSituacao = (client, chave, situacao) => query(
  'UPDATE notes SET situacao = $1 WHERE user_id = $2 AND chave = $3',
  [situacao, client.id, chave],
);

/* ---------- interpretação de cada documento recebido ---------- */

function partyOf(xml) {
  return {
    doc: docKey(text(xml, 'CNPJ', 'CPF')),
    nome: text(xml, 'xNome'),
    uf: text(block(xml, 'enderEmit') || block(xml, 'enderDest') || block(xml, 'enderToma') || block(xml, 'enderReme') || block(xml, 'enderReceb') || block(xml, 'enderExped') || xml, 'UF'),
  };
}

// Devolve 'nova' | 'atualizada' | null.
export async function processDoc(client, { schema, xml, gz }, state) {
  const me = client.doc;
  const name = schema.split('_')[0];

  if (name === 'resNFe') {
    const chave = text(xml, 'chNFe');
    const cSit = text(xml, 'cSitNFe');
    const isNew = await upsertNote(client, {
      chave,
      date: isoDate(text(xml, 'dhEmi')),
      nf: nfFromKey(chave),
      tipo: chave.slice(20, 22) === '65' ? 'NFC-e' : 'NF-e',
      op: 'entrada',
      eDoc: docKey(text(xml, 'CNPJ', 'CPF')),
      eNome: text(xml, 'xNome'),
      eUF: ufFromKey(chave),
      dDoc: me, dNome: client.nome, dUF: client.uf,
      val: Number(text(xml, 'vNF')) || 0,
      situacao: SITUACAO[cSit] || 'autorizada',
      manif: state.ciencia && cSit === '1' ? 'pendente' : null,
    }, { full: false });
    if (SITUACAO[cSit] && cSit !== '1') await setSituacao(client, chave, SITUACAO[cSit]);
    await saveXml(client, chave, gz, false);
    return isNew ? 'nova' : null;
  }

  if (name === 'procNFe' || name === 'nfeProc') {
    const inf = block(xml, 'infNFe');
    const chave = (attr(xml, 'infNFe', 'Id') || '').replace(/^NFe/, '');
    const ide = block(inf, 'ide');
    const emit = partyOf(block(inf, 'emit'));
    const dest = partyOf(block(inf, 'dest'));
    const op = dest.doc === me ? 'entrada' : emit.doc === me ? 'saida' : null;
    if (!op || !chave) return null;
    const isNew = await upsertNote(client, {
      chave,
      date: isoDate(text(ide, 'dhEmi', 'dEmi')),
      nf: text(ide, 'nNF'),
      tipo: text(ide, 'mod') === '65' ? 'NFC-e' : 'NF-e',
      op,
      eDoc: emit.doc, eNome: emit.nome, eUF: emit.uf,
      dDoc: dest.doc, dNome: dest.nome, dUF: dest.uf,
      val: Number(text(block(inf, 'ICMSTot'), 'vNF') || text(inf, 'vNF')) || 0,
      situacao: 'autorizada',
    }, { full: true });
    await saveXml(client, chave, gz, true);
    return isNew ? 'atualizada' : null;
  }

  if (name === 'procCTe' || name === 'cteProc' || name === 'procCTeOS' || name === 'cteOSProc') {
    const inf = block(xml, 'infCte') || block(xml, 'infCTe');
    const chave = (attr(xml, 'infCte', 'Id') || attr(xml, 'infCTe', 'Id')).replace(/^CTe/, '');
    const ide = block(inf, 'ide');
    const emit = partyOf(block(inf, 'emit'));
    let toma = { doc: '', nome: '', uf: '' };
    const toma4 = block(ide, 'toma4');
    const toma3 = block(ide, 'toma3') || block(ide, 'toma03');
    if (toma4) toma = partyOf(toma4);
    else if (toma3) {
      const role = { 0: 'rem', 1: 'exped', 2: 'receb', 3: 'dest' }[text(toma3, 'toma')];
      if (role) toma = partyOf(block(inf, role));
    } else if (block(inf, 'toma')) toma = partyOf(block(inf, 'toma'));
    const op = toma.doc === me ? 'entrada' : emit.doc === me ? 'saida' : null;
    if (!op || !chave) return null;
    const isNew = await upsertNote(client, {
      chave,
      date: isoDate(text(ide, 'dhEmi')),
      nf: text(ide, 'nCT'),
      tipo: 'CT-e',
      op,
      eDoc: emit.doc, eNome: emit.nome, eUF: emit.uf,
      dDoc: toma.doc, dNome: toma.nome, dUF: toma.uf,
      val: Number(text(block(inf, 'vPrest'), 'vTPrest')) || 0,
      situacao: 'autorizada',
    }, { full: true });
    await saveXml(client, chave, gz, true);
    return isNew ? 'nova' : null;
  }

  if (/^(resEvento|procEventoNFe|procEventoCTe|eventoCTeProc)$/.test(name)) {
    const tpEvento = text(xml, 'tpEvento');
    const chave = text(xml, 'chNFe', 'chCTe');
    if (tpEvento === '110111' && chave) await setSituacao(client, chave, 'cancelada');
    return null;
  }
  return null; // outros documentos (MDF-e, eventos de terceiros...) são ignorados
}

/* ---------- uma rodada para um cliente ---------- */

async function loadContext(userId) {
  const [client] = await query("SELECT * FROM users WHERE id = $1 AND role = 'cliente'", [userId]);
  const [cert] = await query('SELECT * FROM certificates WHERE user_id = $1', [userId]);
  const [state] = await query('SELECT * FROM sync_state WHERE user_id = $1', [userId]);
  return { client, cert, state };
}

async function lock(userId) {
  const now = Date.now();
  const rows = await query(
    'UPDATE sync_state SET lock_until = $1 WHERE user_id = $2 AND lock_until < $3 RETURNING user_id',
    [now + LOCK_MS, userId, now],
  );
  return rows.length > 0;
}

async function pullService(service, ctx, cred, deadline, counts) {
  const { client, state } = ctx;
  const nsuField = service === 'nfe' ? 'nsu_nfe' : 'nsu_cte';
  const nextField = service === 'nfe' ? 'next_nfe' : 'next_cte';
  if (Number(state[nextField]) > Date.now()) return 'aguardando';
  const call = service === 'nfe' ? distNfe : distCte;
  let nsu = state[nsuField];
  let next = Date.now() + HOUR;
  let outcome = 'ok';

  for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
    const res = await call(cred, { doc: client.doc, uf: client.uf, ultNSU: nsu });
    if (res.cStat === '138') {
      for (const doc of res.docs) {
        const r = await processDoc(client, doc, state);
        if (r === 'nova') counts.novas += 1;
        if (r === 'atualizada') counts.completas += 1;
        counts.docs += 1;
      }
      nsu = res.ultNSU || nsu;
      await query(`UPDATE sync_state SET ${nsuField} = $1 WHERE user_id = $2`, [nsu, client.id]);
      if (!res.maxNSU || BigInt(nsu) >= BigInt(res.maxNSU)) {
        next = Date.now() + HOUR; // chegou ao fim: a SEFAZ pede 1 hora de espera
        break;
      }
      next = Date.now(); // ainda há documentos: continua na próxima página/rodada
      continue;
    }
    if (res.cStat === '137') {
      nsu = res.ultNSU || nsu;
      next = Date.now() + HOUR;
      break;
    }
    if (res.cStat === '656') { // consumo indevido: a SEFAZ bloqueia por 1 hora
      if (res.ultNSU) nsu = res.ultNSU;
      next = Date.now() + HOUR + 5 * 60 * 1000;
      outcome = 'bloqueio';
      counts.msgs.push(`${service.toUpperCase()}: ${res.xMotivo}`);
      break;
    }
    outcome = 'erro';
    counts.msgs.push(`${service === 'nfe' ? 'NF-e' : 'CT-e'}: ${res.cStat} ${res.xMotivo}`.trim());
    break;
  }
  await query(`UPDATE sync_state SET ${nsuField} = $1, ${nextField} = $2 WHERE user_id = $3`, [nsu, next, client.id]);
  return outcome;
}

async function sendPendingCiencias(ctx, cred, deadline, counts) {
  for (let round = 0; round < 5 && Date.now() < deadline; round++) {
    const pending = await query(
      "SELECT chave FROM notes WHERE user_id = $1 AND manif = 'pendente' AND tipo = 'NF-e' AND situacao = 'autorizada' ORDER BY date DESC LIMIT 20",
      [ctx.client.id],
    );
    if (!pending.length) return;
    const result = await sendCiencias(cred, { doc: ctx.client.doc, chaves: pending.map((p) => p.chave) });
    for (const { chave } of pending) {
      const r = result[chave];
      const status = r?.ok ? 'ok' : `erro ${r?.cStat || ''}`.trim();
      await query('UPDATE notes SET manif = $1 WHERE user_id = $2 AND chave = $3', [status, ctx.client.id, chave]);
      if (r?.ok) counts.ciencias += 1;
    }
  }
}

export async function syncClient(userId, { deadline = Date.now() + 50000 } = {}) {
  if (!(await lock(userId))) return { status: 'ocupado', message: 'Já existe uma busca em andamento para este cliente.' };
  const counts = { docs: 0, novas: 0, completas: 0, ciencias: 0, msgs: [] };
  let status = 'ok';
  try {
    const ctx = await loadContext(userId);
    if (!ctx.client || !ctx.state) throw new SefazError('Cliente sem configuração de busca.');
    if (!ctx.cert) throw new SefazError('Cadastre o certificado A1 do cliente.');
    if (!ctx.client.active) throw new SefazError('Cliente bloqueado: busca suspensa.');
    if (Number(ctx.cert.not_after) < Date.now()) throw new SefazError('Certificado A1 vencido. Envie o novo certificado.');
    const cred = open(ctx.cert.sealed);

    const results = [await pullService('nfe', ctx, cred, deadline, counts)];
    if (Date.now() < deadline) results.push(await pullService('cte', ctx, cred, deadline, counts));
    if (ctx.state.ciencia && Date.now() < deadline) {
      try {
        await sendPendingCiencias(ctx, cred, deadline, counts);
      } catch (error) {
        counts.msgs.push(`Ciência: ${error.message}`);
      }
    }
    if (results.includes('erro')) status = 'erro';
    else if (results.includes('bloqueio')) status = 'aguardando';
  } catch (error) {
    status = 'erro';
    counts.msgs.push(error instanceof SefazError ? error.message : 'Erro interno na busca.');
    if (!(error instanceof SefazError)) console.error('sync', userId, error);
  }

  const parts = [];
  if (counts.novas) parts.push(`${counts.novas} nota(s) nova(s)`);
  if (counts.completas) parts.push(`${counts.completas} XML(s) completo(s)`);
  if (counts.ciencias) parts.push(`${counts.ciencias} ciência(s) enviada(s)`);
  if (!parts.length && status === 'ok') parts.push('Nenhuma nota nova');
  const message = [...parts, ...counts.msgs].join(' · ').slice(0, 480);
  await query(
    'UPDATE sync_state SET lock_until = 0, last_run = $1, last_status = $2, last_msg = $3 WHERE user_id = $4',
    [Date.now(), status, message, userId],
  );
  return { status, message, ...counts };
}

// Rodada agendada: atende os clientes que estão na vez, até acabar o tempo.
export async function syncDue({ budgetMs = 250000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const now = Date.now();
  const due = await query(
    `SELECT s.user_id FROM sync_state s
     JOIN certificates c ON c.user_id = s.user_id
     JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.active = 1 AND (s.next_nfe <= $1 OR s.next_cte <= $1)
     ORDER BY s.last_run NULLS FIRST`,
    [now],
  );
  const done = [];
  for (const { user_id: userId } of due) {
    if (Date.now() > deadline - 20000) break;
    const r = await syncClient(userId, { deadline: Math.min(deadline - 10000, Date.now() + 90000) });
    done.push({ userId, status: r.status, novas: r.novas });
  }
  return { due: due.length, processed: done.length, results: done };
}
