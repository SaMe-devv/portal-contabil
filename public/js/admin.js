import { api, goHome } from './api.js';
import { readFiles, summarizeIgnored, toWire } from './parser.js';
import { mountReport } from './report.js';
import { $, digits, esc, fmtDoc } from './util.js';

const FIELDS = ['nome', 'doc', 'email', 'password', 'ie', 'lgr', 'nro', 'cpl', 'bairro', 'mun', 'uf', 'cep', 'fone'];
const CHUNK = 1000; // notas por requisição (a Vercel limita o corpo a ~4,5 MB)

let clients = [];
let editingId = null;
let importId = null;
let reportId = null;
let report = null;

const field = (name) => $(`#f_${name}`);
const byId = (id) => clients.find((c) => c.id === id);

function showMessage(target, text, good = false) {
  target.textContent = text;
  target.classList.toggle('good', good);
  target.hidden = !text;
}

/* ---------- lista de clientes ---------- */

async function loadClients() {
  ({ clients } = await api('/api/admin/clients'));
  $('#clients').innerHTML = clients.length
    ? clients.map((c) => `
        <tr>
          <td class="nm">${esc(c.nome)}</td>
          <td>${esc(fmtDoc(c.doc))}</td>
          <td>${esc(c.email)}</td>
          <td><span class="badge ${c.active ? 'ok' : 'off'}">${c.active ? 'Liberado' : 'Bloqueado'}</span></td>
          <td class="num">${c.notes}</td>
          <td>
            <div class="actions">
              <button class="btn small" data-act="report" data-id="${c.id}">Relatório</button>
              <button class="btn small alt" data-act="import" data-id="${c.id}">Importar XMLs</button>
              <button class="btn small alt" data-act="edit" data-id="${c.id}">Editar</button>
              <button class="btn small alt" data-act="toggle" data-id="${c.id}">${c.active ? 'Bloquear' : 'Liberar'}</button>
              <button class="btn small danger" data-act="delete" data-id="${c.id}">Excluir</button>
            </div>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="6" class="empty">Nenhum cliente cadastrado ainda.</td></tr>';
}

async function openReport(id) {
  reportId = id;
  const { profile, notes } = await api(`/api/report?client=${id}`);
  $('#report').hidden = false;
  report.render(profile, notes);
  $('#report').scrollIntoView({ behavior: 'smooth' });
}

$('#clients').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = Number(button.dataset.id);
  const client = byId(id);
  try {
    switch (button.dataset.act) {
      case 'report': await openReport(id); break;
      case 'import': openImport(client); break;
      case 'edit': openForm(client); break;
      case 'toggle':
        await api(`/api/admin/clients/${id}`, { method: 'PATCH', body: { active: !client.active } });
        await loadClients();
        break;
      case 'delete':
        if (!window.confirm(`Excluir ${client.nome} e todo o histórico de notas? Esta ação não tem volta.`)) break;
        await api(`/api/admin/clients/${id}`, { method: 'DELETE' });
        if (reportId === id) $('#report').hidden = true;
        if (importId === id) $('#importCard').hidden = true;
        await loadClients();
        break;
      default:
    }
  } catch (error) {
    window.alert(error.message);
  }
});

/* ---------- cadastro / edição ---------- */

function openForm(client = null, prefill = null) {
  editingId = client?.id ?? null;
  $('#formTitle').textContent = client ? `Editar cliente: ${client.nome}` : 'Novo cliente';
  FIELDS.forEach((name) => { field(name).value = name === 'password' ? '' : (client?.[name] ?? prefill?.[name] ?? ''); });
  field('doc').value = fmtDoc(client?.doc ?? prefill?.doc ?? '');
  field('active').checked = client ? !!client.active : true;
  field('gen').checked = false;
  $('#genRow').hidden = !client;
  $('#pwHint').textContent = client
    ? 'Deixe em branco para manter a senha atual.'
    : 'Deixe em branco para gerar uma senha automática.';
  showMessage($('#formMsg'), '');
  $('#creds').hidden = true;
  $('#formCard').hidden = false;
  $('#formCard').scrollIntoView({ behavior: 'smooth' });
}

$('#new').addEventListener('click', () => openForm());
$('#cancel').addEventListener('click', () => { $('#formCard').hidden = true; });

$('#form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {};
  FIELDS.forEach((name) => { body[name] = field(name).value.trim(); });
  body.active = field('active').checked;
  body.generatePassword = field('gen').checked;
  if (editingId && !body.password) delete body.password;

  try {
    const result = editingId
      ? await api(`/api/admin/clients/${editingId}`, { method: 'PATCH', body })
      : await api('/api/admin/clients', { method: 'POST', body });

    if (result.password) {
      $('#creds').textContent = `Login do cliente — e-mail: ${result.client.email} · senha: ${result.password} (anote agora: ela não é exibida de novo)`;
      $('#creds').hidden = false;
    }
    showMessage($('#formMsg'), 'Cliente salvo.', true);
    editingId = result.client.id;
    $('#genRow').hidden = false;
    field('password').value = '';
    field('gen').checked = false;
    await loadClients();
  } catch (error) {
    showMessage($('#formMsg'), error.message);
  }
});

/* ---------- importação de XMLs ---------- */

// Envia as notas de um cliente em lotes e soma os resultados.
async function sendNotes(clientId, notes) {
  const totals = { novas: 0, repetidas: 0, outros: 0, invalidas: 0 };
  for (let i = 0; i < notes.length; i += CHUNK) {
    const result = await api(`/api/admin/clients/${clientId}/notes`, {
      method: 'POST',
      body: { notes: notes.slice(i, i + CHUNK).map(toWire) },
    });
    Object.keys(totals).forEach((key) => { totals[key] += result[key]; });
  }
  return totals;
}

// Lista os CNPJs/CPFs que aparecem nos arquivos (como emitente ou destinatário/tomador), para diagnóstico.
function describeParties(notes) {
  const parties = new Map();
  for (const note of notes) {
    for (const [rawDoc, nome] of [[note.destDoc, note.destNome], [note.eCnpj, note.eNome]]) {
      const doc = digits(rawDoc);
      if (!doc) continue;
      const item = parties.get(doc) || { nome, count: 0 };
      item.count += 1;
      parties.set(doc, item);
    }
  }
  return [...parties]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .map(([doc, { nome, count }]) => `${nome} (${fmtDoc(doc)}) — ${count} nota(s)`)
    .join('; ');
}

function openImport(client) {
  importId = client.id;
  $('#importTitle').textContent = `Importar XMLs para: ${client.nome} (${fmtDoc(client.doc)})`;
  showMessage($('#importMsg'), '');
  $('#importCard').hidden = false;
  $('#importCard').scrollIntoView({ behavior: 'smooth' });
}

$('#file').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length || !importId) return;

  showMessage($('#importMsg'), 'Lendo arquivos…', true);
  try {
    const { notes, ignored } = await readFiles(files);
    const totals = await sendNotes(importId, notes);
    const parts = [`${totals.novas} notas novas`, `${totals.repetidas} repetidas`];
    if (totals.outros) parts.push(`${totals.outros} ignoradas por não pertencerem a este cliente`);
    if (totals.invalidas) parts.push(`${totals.invalidas} inválidas`);
    let text = `${parts.join(', ')}.`;
    if (totals.outros) {
      text += ` O CNPJ/CPF do cliente precisa aparecer como emitente (saídas) ou destinatário/tomador (entradas). `
        + `CNPJs/CPFs encontrados nos arquivos: ${describeParties(notes) || 'nenhum'}.`;
    }
    if (ignored.length) text += ` ${summarizeIgnored(ignored).join('; ')}.`;
    showMessage($('#importMsg'), text, totals.novas > 0 || totals.repetidas > 0);
    await loadClients();
    if (reportId === importId) await openReport(importId);
  } catch (error) {
    showMessage($('#importMsg'), error.message);
  }
});

/* ---------- importação em lote (vários clientes de uma vez) ---------- */

let pendingGroups = new Map(); // CNPJ/CPF -> notas ainda sem cliente cadastrado

// Cada nota vai para todo cliente cadastrado que seja o emitente ou o destinatário/tomador dela.
function distribute(notes) {
  const byClient = new Map();
  const unmatched = new Map();
  for (const note of notes) {
    const docs = new Set([digits(note.destDoc), digits(note.eCnpj)]);
    const owners = clients.filter((c) => docs.has(c.doc));
    if (owners.length) {
      owners.forEach((c) => {
        if (!byClient.has(c.id)) byClient.set(c.id, []);
        byClient.get(c.id).push(note);
      });
      continue;
    }
    const asDest = digits(note.destDoc);
    const doc = asDest || digits(note.eCnpj);
    const group = unmatched.get(doc) || {
      doc,
      nome: (asDest ? note.destNome : note.eNome) || '(sem identificação)',
      profile: asDest ? note.destProfile : note.emitProfile,
      notes: [],
    };
    group.notes.push(note);
    unmatched.set(doc, group);
  }
  return { byClient, unmatched };
}

async function runBatch(notes, ignored = []) {
  const { byClient, unmatched } = distribute(notes);
  const rows = [];

  for (const [id, list] of byClient) {
    const client = byId(id);
    const totals = await sendNotes(id, list);
    rows.push({ nome: client.nome, doc: client.doc, count: list.length, status: `Importado: ${totals.novas} novas, ${totals.repetidas} repetidas` });
  }
  for (const group of unmatched.values()) {
    const button = group.doc ? ` <button class="btn small" data-doc="${esc(group.doc)}" type="button">Cadastrar</button>` : '';
    rows.push({ nome: group.nome, doc: group.doc, count: group.notes.length, status: `Sem cadastro${button}` });
  }
  pendingGroups = unmatched;

  $('#batchRows').innerHTML = rows.map((row) => `
    <tr>
      <td class="nm">${esc(row.nome)}</td>
      <td>${esc(fmtDoc(row.doc) || '—')}</td>
      <td class="num">${row.count}</td>
      <td class="nm">${row.status}</td>
    </tr>`).join('');
  $('#batchResult').hidden = !rows.length;
  $('#batchPending').hidden = unmatched.size === 0;

  const messages = summarizeIgnored(ignored);
  if (unmatched.size) messages.push(`${unmatched.size} CNPJ/CPF sem cadastro: cadastre e clique em “Importar pendentes”`);
  showMessage($('#batchMsg'), messages.length ? `${messages.join('. ')}.` : 'Importação concluída.', !unmatched.size && !ignored.length);
  await loadClients();
}

$('#batchFile').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;

  showMessage($('#batchMsg'), 'Lendo arquivos…', true);
  try {
    const { notes, ignored } = await readFiles(files);
    await runBatch(notes, ignored);
  } catch (error) {
    showMessage($('#batchMsg'), error.message);
  }
});

$('#batchPending').addEventListener('click', async () => {
  try {
    await runBatch([...pendingGroups.values()].flatMap((group) => group.notes));
  } catch (error) {
    showMessage($('#batchMsg'), error.message);
  }
});

$('#batchRows').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-doc]');
  const group = button && pendingGroups.get(button.dataset.doc);
  if (group) openForm(null, { ...group.profile, doc: group.doc });
});

$('#clearNotes').addEventListener('click', async () => {
  const client = byId(importId);
  if (!client || !window.confirm(`Apagar todas as notas de ${client.nome}?`)) return;
  try {
    await api(`/api/admin/clients/${importId}/notes`, { method: 'DELETE' });
    showMessage($('#importMsg'), 'Histórico apagado.', true);
    await loadClients();
    if (reportId === importId) await openReport(importId);
  } catch (error) {
    showMessage($('#importMsg'), error.message);
  }
});

/* ---------- início ---------- */

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  goHome();
});

async function init() {
  try {
    const user = await api('/api/me');
    if (user.role !== 'adm') return location.replace('/cliente.html');
    $('#who').textContent = user.email;
    report = await mountReport($('#report'));
    await loadClients();
  } catch (error) {
    if (error.status === 401) goHome();
    else window.alert(error.message);
  }
}

init();
