import { api, goHome } from './api.js';
import { readFiles } from './parser.js';
import { mountReport } from './report.js';
import { $, esc, fmtDoc } from './util.js';

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

function openForm(client = null) {
  editingId = client?.id ?? null;
  $('#formTitle').textContent = client ? `Editar cliente: ${client.nome}` : 'Novo cliente';
  FIELDS.forEach((name) => { field(name).value = name === 'password' ? '' : (client?.[name] ?? ''); });
  field('doc').value = client ? fmtDoc(client.doc) : '';
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

  const totals = { novas: 0, repetidas: 0, outros: 0, invalidas: 0 };
  showMessage($('#importMsg'), 'Lendo arquivos…', true);
  try {
    const { notes, bad } = await readFiles(files);
    for (let i = 0; i < notes.length; i += CHUNK) {
      const result = await api(`/api/admin/clients/${importId}/notes`, {
        method: 'POST',
        body: { notes: notes.slice(i, i + CHUNK) },
      });
      Object.keys(totals).forEach((key) => { totals[key] += result[key]; });
    }
    showMessage($('#importMsg'),
      `${totals.novas} notas novas, ${totals.repetidas} repetidas, ${totals.outros} de outro CNPJ ignoradas`
      + `${totals.invalidas ? `, ${totals.invalidas} inválidas` : ''}${bad ? `, ${bad} arquivos ignorados` : ''}.`,
      true);
    await loadClients();
    if (reportId === importId) await openReport(importId);
  } catch (error) {
    showMessage($('#importMsg'), error.message);
  }
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
