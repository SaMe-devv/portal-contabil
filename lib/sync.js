// Busca automática de notas na SEFAZ (Distribuição DF-e), cliente a cliente.
import { query } from './db.js';
import { docKey } from './doc.js';
import { open } from './vault.js';
import { SefazError, UF_BY_CODE, consChave, consNsu, distCte, distNfe, sendCiencias } from './sefaz.js';
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

const LABEL = { nfe: 'NF-e', cte: 'CT-e' };
const brClock = (ms) => new Date(Number(ms) - 3 * HOUR).toISOString().slice(11, 16); // hora de Brasília

// Busca uma fila (NF-e ou CT-e). Devolve 'ok' | 'aguardando' | 'bloqueio' | 'conflito' | 'erro'.
async function pullService(service, ctx, cred, deadline, counts) {
  const { client, state } = ctx;
  const nsuField = service === 'nfe' ? 'nsu_nfe' : 'nsu_cte';
  const nextField = service === 'nfe' ? 'next_nfe' : 'next_cte';
  const label = LABEL[service];
  if (Number(state[nextField]) > Date.now()) {
    counts.msgs.push(`${label}: a SEFAZ só aceita nova consulta a partir das ${brClock(state[nextField])}`);
    return 'aguardando';
  }
  const call = service === 'nfe' ? distNfe : distCte;
  let nsu = state[nsuField];
  let next = Date.now() + HOUR;
  let outcome = 'ok';
  let conflitos = Number(state.conflitos) || 0;

  try {
    for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
      const fromZero = BigInt(nsu) === 0n;
      const res = await call(cred, { doc: client.doc, uf: client.uf, ultNSU: nsu });
      // Começou do zero e a SEFAZ aceitou: este cliente recebeu os 90 dias completos na primeira busca.
      if (fromZero && service === 'nfe' && ['137', '138'].includes(res.cStat)) await query('UPDATE sync_state SET janela_ok = 1 WHERE user_id = $1', [client.id]);
      if (res.cStat === '138') {
        for (const doc of res.docs) {
          try {
            const r = await processDoc(client, doc, state);
            if (r === 'nova') counts.novas += 1;
            if (r === 'atualizada') counts.completas += 1;
          } catch (error) {
            // um documento com problema não pode travar a sequência de NSU
            counts.falhas += 1;
            console.error('documento', doc.nsu, doc.schema, error);
          }
          counts.docs += 1;
        }
        nsu = res.ultNSU || nsu;
        if (service === 'nfe') conflitos = 0;
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
        if (service === 'nfe') conflitos = 0;
        next = Date.now() + HOUR;
        break;
      }
      if (res.cStat === '656') {
        // Consumo indevido. Quase sempre: outro sistema (emissor, ERP, outro portal) consulta este mesmo CNPJ
        // e a SEFAZ já está mais à frente na sequência. Ela informa o último NSU: seguimos a partir dele.
        if (res.ultNSU && BigInt(res.ultNSU) > BigInt(nsu)) {
          // As notas entre a nossa posição e a da SEFAZ foram entregues a outro sistema: entram na fila de recuperação.
          await addGap(client.id, service, BigInt(nsu) + 1n, BigInt(res.ultNSU));
          counts.msgs.push(`${label}: notas já baixadas por outro sistema entram na busca retroativa automática (até 90 dias)`);
          nsu = res.ultNSU;
        }
        next = Date.now() + HOUR + 5 * 60 * 1000;
        conflitos += 1;
        outcome = conflitos >= 2 ? 'conflito' : 'bloqueio';
        counts.msgs.push(conflitos >= 2
          ? `${label}: a SEFAZ recusou de novo porque outro sistema também consulta as notas deste CNPJ. Use um só sistema por CNPJ (veja o LEIAME). Próxima tentativa às ${brClock(next)}`
          : `${label}: a SEFAZ pausou as consultas deste CNPJ até as ${brClock(next)} porque outro sistema já baixou notas dele. O portal guardou a posição informada pela SEFAZ e continua sozinho`);
        break;
      }
      outcome = 'erro';
      counts.msgs.push(`${label}: ${res.cStat} ${res.xMotivo}`.trim());
      break;
    }
  } catch (error) {
    outcome = 'erro';
    next = Date.now() + 15 * 60 * 1000;
    counts.msgs.push(`${label}: ${error instanceof SefazError ? error.message : 'erro interno'}`);
    if (!(error instanceof SefazError)) console.error('pull', service, client.id, error);
  } finally {
    // Sempre grava a posição e o próximo horário, mesmo se algo falhar no meio.
    await query(
      `UPDATE sync_state SET ${nsuField} = $1, ${nextField} = $2${service === 'nfe' ? ', conflitos = $4' : ''} WHERE user_id = $3`,
      service === 'nfe' ? [nsu, next, client.id, conflitos] : [nsu, next, client.id],
    );
  }
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
  const counts = { docs: 0, novas: 0, completas: 0, ciencias: 0, falhas: 0, msgs: [] };
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
    else if (results.includes('conflito')) status = 'conflito';
    else if (results.includes('bloqueio') || results.every((r) => r === 'aguardando')) status = 'aguardando';
  } catch (error) {
    status = 'erro';
    counts.msgs.push(error instanceof SefazError ? error.message : 'Erro interno na busca.');
    if (!(error instanceof SefazError)) console.error('sync', userId, error);
  }

  const parts = [];
  if (counts.novas) parts.push(`${counts.novas} nota(s) nova(s)`);
  if (counts.completas) parts.push(`${counts.completas} XML(s) completo(s)`);
  if (counts.ciencias) parts.push(`${counts.ciencias} ciência(s) enviada(s)`);
  if (counts.falhas) parts.push(`${counts.falhas} documento(s) não lido(s)`);
  if (!parts.length && status === 'ok') parts.push('Nenhuma nota nova');
  if (status === 'ok') counts.msgs = counts.msgs.filter((m) => !m.includes('só aceita nova consulta'));
  const message = [...parts, ...counts.msgs].join(' · ').slice(0, 480);
  await query(
    'UPDATE sync_state SET lock_until = 0, last_run = $1, last_status = $2, last_msg = $3 WHERE user_id = $4',
    [Date.now(), status, message, userId],
  );
  return { status, message, ...counts };
}

/* ---------- busca retroativa (até 90 dias) ---------- */
// A SEFAZ guarda as notas por 90 dias. Quando outro sistema já baixou parte delas, a consulta normal pula esse trecho.
// A busca retroativa recupera esse trecho de dois jeitos, respeitando o limite da SEFAZ de 20 consultas por hora:
//  1) por chave de acesso (consChNFe), quando o escritório informa uma lista de chaves — vai direto na nota;
//  2) por número de sequência (consNSU), do mais recente para o mais antigo, até a data inicial escolhida.

const PER_HOUR = 18; // margem abaixo do limite de 20 da SEFAZ
const MAX_MISSES = 5; // NSUs seguidos sem documento: acabou o que a SEFAZ guarda
const OLDER_STOP = 3; // documentos seguidos anteriores à data inicial: chegou ao começo do período
const parseJson = (text) => { try { return JSON.parse(text || '[]'); } catch { return []; } };
const docDate = (xml) => isoDate(text(xml, 'dhRecbto', 'dhEmi', 'dEmi', 'dhEvento'));

async function addGap(userId, service, lo, hi) {
  if (hi < lo) return;
  const [row] = await query('SELECT backfill FROM sync_state WHERE user_id = $1', [userId]);
  const gaps = parseJson(row?.backfill);
  gaps.push({ s: service, lo: String(lo), hi: String(hi), misses: 0, older: 0 });
  await query('UPDATE sync_state SET backfill = $1 WHERE user_id = $2', [JSON.stringify(gaps), userId]);
}

const ninetyDaysAgo = () => new Date(Date.now() - 90 * 24 * HOUR).toISOString().slice(0, 10);

// Pedido do escritório: período (data inicial, no máximo 90 dias atrás) e, opcionalmente, chaves de acesso.
export async function queueBackfill(userId, { since = '', chaves = [], porSequencia = true } = {}) {
  const [state] = await query('SELECT nsu_nfe, nsu_cte, backfill FROM sync_state WHERE user_id = $1', [userId]);
  const floor = ninetyDaysAgo();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(since) && since > floor ? since : floor;

  // Chaves de NF-e/NFC-e válidas (44 dígitos), sem repetir e sem as que já têm XML completo.
  const unique = [...new Set(chaves.map((c) => String(c).replace(/\D/g, '')).filter((c) => c.length === 44 && ['55', '65'].includes(c.slice(20, 22))))];
  let keys = unique;
  if (unique.length) {
    const have = new Set();
    for (let i = 0; i < unique.length; i += 500) {
      const part = unique.slice(i, i + 500);
      const rows = await query(
        `SELECT chave FROM xmls WHERE user_id = $1 AND full_xml = 1 AND chave IN (${part.map((_, j) => `$${j + 2}`).join(', ')})`,
        [userId, ...part],
      );
      rows.forEach((r) => have.add(r.chave));
    }
    keys = unique.filter((c) => !have.has(c));
  }

  const gaps = parseJson(state?.backfill).filter((g) => g.lo !== '1'); // substitui um pedido anterior
  if (porSequencia) {
    for (const [service, field] of [['nfe', 'nsu_nfe'], ['cte', 'nsu_cte']]) {
      const top = BigInt(state?.[field] || '0');
      if (top > 0n) gaps.unshift({ s: service, lo: '1', hi: String(top), misses: 0, older: 0 });
    }
  }
  const has = gaps.length > 0 || keys.length > 0;
  await query(
    `UPDATE sync_state SET backfill = $1, backfill_keys = $2, backfill_since = $3,
       backfill_done = 0, backfill_calls = 0, backfill_started = $4 WHERE user_id = $5`,
    [gaps.length ? JSON.stringify(gaps) : '', keys.length ? JSON.stringify(keys) : '', start, has ? Date.now() : 0, userId],
  );
  return { since: start, chaves: keys.length, jaTinha: unique.length - keys.length, sequencia: gaps.length > 0 };
}

export async function cancelBackfill(userId) {
  // backfill_next é mantido: a cota de 20 consultas por hora da SEFAZ continua valendo.
  await query("UPDATE sync_state SET backfill = '', backfill_keys = '' WHERE user_id = $1", [userId]);
}

export async function backfillClient(userId, { deadline = Date.now() + 40000 } = {}) {
  const [state] = await query('SELECT * FROM sync_state WHERE user_id = $1', [userId]);
  const gaps = parseJson(state?.backfill);
  const keys = parseJson(state?.backfill_keys);
  if ((!gaps.length && !keys.length) || Number(state.backfill_next) > Date.now()) return null;
  if (!(await lock(userId))) return null;
  const ctx = await loadContext(userId);
  const since = state.backfill_since || ninetyDaysAgo();
  let recovered = 0;
  let calls = 0;
  let next = Date.now() + HOUR + 60 * 1000; // próxima leva depois de 1 hora
  let note = '';
  const handleDocs = async (docs, label) => {
    for (const doc of docs) {
      try {
        const r = await processDoc(ctx.client, doc, ctx.state);
        if (r) recovered += 1;
      } catch (error) {
        console.error('retroativa', label, error);
      }
    }
  };
  try {
    if (!ctx.cert || Number(ctx.cert.not_after) < Date.now() || !ctx.client?.active) return null;
    const cred = open(ctx.cert.sealed);

    // 1) chaves informadas pelo escritório
    while (keys.length && calls < PER_HOUR && Date.now() < deadline) {
      const chave = keys[keys.length - 1];
      calls += 1;
      const res = await consChave(cred, { doc: ctx.client.doc, uf: ctx.client.uf, chave });
      if (res.cStat === '656') {
        calls -= 1;
        next = Date.now() + HOUR + 5 * 60 * 1000;
        note = 'SEFAZ pausou a busca retroativa por 1 hora';
        break;
      }
      if (res.cStat === '138') await handleDocs(res.docs, chave);
      keys.pop(); // achou, não existe, fora do prazo ou sem permissão: segue para a próxima
    }

    // 2) sequência de NSU, do mais recente para o mais antigo
    while (!note && gaps.length && calls < PER_HOUR && Date.now() < deadline) {
      const gap = gaps[gaps.length - 1];
      const nsu = BigInt(gap.hi);
      calls += 1;
      const res = await consNsu(gap.s, cred, { doc: ctx.client.doc, uf: ctx.client.uf, nsu });
      if (res.cStat === '138') {
        gap.misses = 0;
        await handleDocs(res.docs, String(nsu));
        const dates = res.docs.map((d) => docDate(d.xml)).filter(Boolean);
        gap.older = dates.length && dates.every((d) => d < since) ? (gap.older || 0) + 1 : 0;
      } else if (res.cStat === '656') {
        next = Date.now() + HOUR + 5 * 60 * 1000; // limite estourado (talvez por outro sistema): espera 1 hora
        calls -= 1;
        note = 'SEFAZ pausou a busca retroativa por 1 hora';
        break;
      } else if (['137', '632', '217'].includes(res.cStat)) {
        gap.misses = (gap.misses || 0) + 1;
      } else {
        note = `Busca retroativa: ${res.cStat} ${res.xMotivo}`.trim();
        break;
      }
      gap.hi = String(nsu - 1n);
      if (BigInt(gap.hi) < BigInt(gap.lo) || gap.misses >= MAX_MISSES || gap.older >= OLDER_STOP) gaps.pop();
    }
  } catch (error) {
    note = `Busca retroativa: ${error instanceof SefazError ? error.message : 'erro interno'}`;
    if (!(error instanceof SefazError)) console.error('backfill', userId, error);
  } finally {
    await query(
      `UPDATE sync_state SET backfill = $1, backfill_keys = $2, backfill_next = $3, backfill_done = backfill_done + $4,
         backfill_calls = backfill_calls + $5, lock_until = 0 WHERE user_id = $6`,
      [gaps.length ? JSON.stringify(gaps) : '', keys.length ? JSON.stringify(keys) : '', calls ? next : Number(state.backfill_next), recovered, calls, userId],
    );
  }
  const pending = gaps.length > 0 || keys.length > 0;
  const parts = [];
  if (recovered) parts.push(`${recovered} nota(s) antiga(s) recuperada(s)`);
  if (note) parts.push(note);
  if (!pending) parts.push('busca retroativa concluída');
  return { recovered, calls, pending, message: parts.join(' · ') };
}

// Rodada agendada: atende os clientes que estão na vez, até acabar o tempo.
export async function syncDue({ budgetMs = 250000, full = true } = {}) {
  const deadline = Date.now() + budgetMs;
  const now = Date.now();
  const due = !full ? [] : await query(
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
  // Recuperação de notas antigas (roda em todas as rodadas, inclusive as de hora em hora).
  const pending = await query(
    `SELECT s.user_id FROM sync_state s JOIN certificates c ON c.user_id = s.user_id JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.active = 1 AND (s.backfill <> '' OR s.backfill_keys <> '') AND s.backfill_next <= $1`,
    [Date.now()],
  );
  const recovered = [];
  for (const { user_id: userId } of pending) {
    if (Date.now() > deadline - 15000) break;
    const r = await backfillClient(userId, { deadline: Math.min(deadline - 5000, Date.now() + 60000) });
    if (r) recovered.push({ userId, recuperadas: r.recovered, consultas: r.calls });
  }
  return { full, due: due.length, processed: done.length, results: done, backfill: recovered };
}
