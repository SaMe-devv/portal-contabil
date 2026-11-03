import { api, goHome } from './api.js';
import { gzipBase64, readFiles, summarizeIgnored, toWire } from './parser.js';
import { mountReport } from './report.js';
import { $, $$, docKey, esc, fmtDateTime, fmtDoc, icon, int } from './util.js';
import { accountMenu, idleLogout, openDialog, passwordToggles, showMsg } from './ui.js';

const FIELDS = ['nome', 'doc', 'email', 'password', 'ie', 'lgr', 'nro', 'cpl', 'bairro', 'mun', 'uf', 'cep', 'fone'];
const MAX_BATCH_BYTES = 3_000_000; // a Vercel limita cada envio a ~4,5 MB
const DAY = 24 * 3600 * 1000;

let me = null;
let clients = [];
let editingId = null;
let certId = null;
let report = null;
let reportId = null;

const field = (name) => $(`#f_${name}`);
const byId = (id) => clients.find((c) => c.id === id);

/* ---------- abas ---------- */

function selectTab(name) {
  $$('.aba').forEach((tab) => {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#${tab.getAttribute('aria-controls')}`).hidden = !on;
  });
  if (name === 'seguranca') loadAudit();
  try { sessionStorage.setItem('aba', name); } catch { /* sem armazenamento */ }
}
$$('.aba').forEach((tab, i, all) => {
  tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = all[(i + step + all.length) % all.length];
    next.focus();
    selectTab(next.id.slice(4));
  });
});

/* ---------- selos ---------- */

function certBadge(c) {
  if (!c.cert_until) return '<span class="selo neutro">Sem certificado</span>';
  const left = Number(c.cert_until) - Date.now();
  const until = new Date(Number(c.cert_until)).toLocaleDateString('pt-BR');
  if (left < 0) return `<span class="selo off">Vencido</span><small>em ${until}</small>`;
  if (left < 30 * DAY) return `<span class="selo espera">Vence em ${Math.ceil(left / DAY)} dia(s)</span><small>${until}</small>`;
  return `<span class="selo ok">Válido</span><small>até ${until}</small>`;
}

function accessBadge(c) {
  if (!c.active) return '<span class="selo off">Bloqueado</span>';
  if (c.must_change) return '<span class="selo espera">Senha provisória</span>';
  return '<span class="selo ok">Liberado</span>';
}

function syncBadge(c) {
  const map = { ok: ['ok', 'Concluída'], erro: ['off', 'Com erro'], aguardando: ['espera', 'Aguardando SEFAZ'], ocupado: ['espera', 'Em andamento'] };
  const [cls, label] = map[c.sync_status] || ['neutro', 'Ainda não buscou'];
  return `<span class="selo ${cls}">${label}</span>`;
}

/* ---------- lista de clientes ---------- */

function drawClients() {
  const q = $('#buscaCli').value.toLowerCase().trim();
  const qDoc = docKey(q);
  const list = clients.filter((c) => !q || c.nome.toLowerCase().includes(q) || c.email.includes(q) || (qDoc && c.doc.includes(qDoc)));
  $('#clients').innerHTML = list.length
    ? list.map((c) => `
        <tr>
          <td class="nome">${esc(c.nome)}<span class="email">${esc(c.email)}</span></td>
          <td>${esc(fmtDoc(c.doc))}</td>
          <td>${accessBadge(c)}</td>
          <td>${certBadge(c)}<button class="link" type="button" data-act="cert" data-id="${c.id}">${c.cert_until ? 'Trocar certificado' : 'Enviar certificado'}</button></td>
          <td class="num">${int.format(c.notes)}</td>
          <td>${c.last_login ? fmtDateTime(c.last_login) : '<span class="muted">Nunca entrou</span>'}</td>
          <td>
            <div class="acoes">
              <button class="btn btn-sm" data-act="report" data-id="${c.id}">Relatório</button>
              <button class="btn btn-sm btn-contorno" data-act="edit" data-id="${c.id}">Editar</button>
            </div>
          </td>
        </tr>`).join('')
    : `<tr><td colspan="7" class="vazio">${clients.length ? 'Nenhum cliente encontrado com essa busca.' : 'Nenhum cliente cadastrado ainda. Clique em “Novo cliente” para começar.'}</td></tr>`;

  const withCert = clients.filter((c) => c.cert_until && Number(c.cert_until) > Date.now()).length;
  const expiring = clients.filter((c) => c.cert_until && Number(c.cert_until) - Date.now() < 30 * DAY).length;
  $('#resumoGeral').textContent = `${clients.length} cliente(s), ${withCert} com busca automática na SEFAZ`
    + `${expiring ? `, ${expiring} certificado(s) vencido(s) ou vencendo em 30 dias` : ''}.`;
}

function drawSync() {
  const list = clients;
  $('#syncRows').innerHTML = list.length
    ? list.map((c) => {
      const hasCert = c.cert_until && Number(c.cert_until) > Date.now();
      const enabled = c.sync_enabled === null || c.sync_enabled === undefined ? 1 : c.sync_enabled;
      return `
        <tr data-id="${c.id}">
          <td class="nome">${esc(c.nome)}<span class="email">${esc(fmtDoc(c.doc))}</span></td>
          <td>${certBadge(c)}</td>
          <td><label class="chave"><input type="checkbox" data-sync="enabled" ${enabled ? 'checked' : ''} ${hasCert ? '' : 'disabled'}><i></i><span class="sr">Busca automática para ${esc(c.nome)}</span></label></td>
          <td><label class="chave"><input type="checkbox" data-sync="ciencia" ${c.sync_ciencia ? 'checked' : ''} ${hasCert ? '' : 'disabled'}><i></i><span class="sr">Ciência automática para ${esc(c.nome)}</span></label></td>
          <td class="msg-sync">${syncBadge(c)}<b>${c.sync_last ? fmtDateTime(c.sync_last) : ''}</b>${esc(c.sync_msg || '')}</td>
          <td><div class="acoes">${hasCert
            ? `<button class="btn btn-sm btn-contorno" data-act="sync" data-id="${c.id}">${icon('i-refresh')}Buscar agora</button>`
            : `<button class="btn btn-sm btn-contorno" data-act="cert" data-id="${c.id}">${icon('i-key')}Enviar certificado</button>`}</div></td>
        </tr>`;
    }).join('')
    : '<tr><td colspan="6" class="vazio">Cadastre clientes para configurar a busca.</td></tr>';
}

async function loadClients() {
  ({ clients } = await api('/api/admin/clients'));
  drawClients();
  drawSync();
}

$('#buscaCli').addEventListener('input', drawClients);

async function onTableClick(event) {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = Number(button.dataset.id);
  const client = byId(id);
  try {
    if (button.dataset.act === 'report') await openReport(id);
    if (button.dataset.act === 'edit') openForm(client);
    if (button.dataset.act === 'cert') openCert(client);
    if (button.dataset.act === 'sync') {
      button.disabled = true;
      button.lastChild.textContent = 'Buscando…';
      await api(`/api/admin/clients/${id}/sync`, { method: 'POST' });
      await loadClients();
    }
  } catch (error) {
    window.alert(error.message);
    button.disabled = false;
  }
}
$('#clients').addEventListener('click', onTableClick);
$('#syncRows').addEventListener('click', onTableClick);

$('#syncRows').addEventListener('change', async (event) => {
  const input = event.target.closest('input[data-sync]');
  if (!input) return;
  const id = Number(input.closest('tr').dataset.id);
  const key = input.dataset.sync;
  if (key === 'ciencia' && input.checked
    && !window.confirm('A ciência será registrada na SEFAZ em nome do cliente para cada NF-e recebida. Confirma que o cliente autorizou?')) {
    input.checked = false;
    return;
  }
  try {
    await api(`/api/admin/clients/${id}/sync`, { method: 'PATCH', body: { [key]: input.checked } });
    const c = byId(id);
    c[key === 'enabled' ? 'sync_enabled' : 'sync_ciencia'] = input.checked ? 1 : 0;
  } catch (error) {
    input.checked = !input.checked;
    window.alert(error.message);
  }
});

/* ---------- relatório ---------- */

async function openReport(id) {
  reportId = id;
  report = await mountReport($('#report'), { clientId: id });
  const { profile, notes, sync } = await api(`/api/report?client=${id}`);
  report.render(profile, notes, sync);
  $('#viewPainel').hidden = true;
  $('#viewReport').hidden = false;
  window.scrollTo({ top: 0 });
}
$('#fecharRel').addEventListener('click', () => {
  $('#viewReport').hidden = true;
  $('#viewPainel').hidden = false;
  reportId = null;
});

/* ---------- cadastro / edição ---------- */

const dlgCliente = $('#dlgCliente');
$$('[data-fechar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

function openForm(client = null, prefill = null) {
  editingId = client?.id ?? null;
  $('#formTitle').textContent = client ? client.nome : 'Novo cliente';
  $('#formSub').textContent = client
    ? 'Alterar e-mail, senha ou bloquear o acesso encerra as sessões abertas do cliente.'
    : 'O cliente recebe uma senha provisória e escolhe a dele no primeiro acesso.';
  FIELDS.forEach((name) => { field(name).value = name === 'password' ? '' : (client?.[name] ?? prefill?.[name] ?? ''); });
  field('doc').value = fmtDoc(client?.doc ?? prefill?.doc ?? '');
  field('active').checked = client ? Boolean(client.active) : true;
  field('gen').checked = false;
  $('#genRow').hidden = !client;
  $('#pwRow').hidden = Boolean(client);
  $('#excluir').hidden = !client;
  $('#limparNotas').hidden = !client || !client.notes;
  showMsg($('#formMsg'), '');
  $('#creds').hidden = true;
  $('#salvar').disabled = false;
  openDialog(dlgCliente);
}

$('#novo').addEventListener('click', () => openForm());

function showCredentials(client, password) {
  $('#creds').innerHTML = `
    <p><strong>Envie estes dados ao cliente</strong> (a senha não aparece de novo):</p>
    <p>Endereço: <code>${esc(location.origin)}</code><br>Login: <code>${esc(client.email)}</code> ou <code>${esc(fmtDoc(client.doc))}</code><br>Senha provisória: <code>${esc(password)}</code></p>
    <p class="acoes"><button class="btn btn-sm btn-laranja" type="button" id="copiar">Copiar dados</button></p>`;
  $('#creds').hidden = false;
  $('#copiar').addEventListener('click', async () => {
    const text = `Portal do Cliente SaMe Contabilidade\nEndereço: ${location.origin}\nLogin: ${client.email}\nSenha provisória: ${password}\nNo primeiro acesso você vai criar a sua senha pessoal.`;
    await navigator.clipboard.writeText(text).catch(() => {});
    $('#copiar').textContent = 'Copiado';
  });
}

$('#form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {};
  FIELDS.forEach((name) => { body[name] = field(name).value.trim(); });
  body.active = field('active').checked;
  body.generatePassword = field('gen').checked;
  if (editingId || !body.password) delete body.password;

  $('#salvar').disabled = true;
  try {
    const result = editingId
      ? await api(`/api/admin/clients/${editingId}`, { method: 'PATCH', body })
      : await api('/api/admin/clients', { method: 'POST', body });
    showMsg($('#formMsg'), editingId ? 'Alterações salvas.' : 'Cliente cadastrado.', 'ok');
    if (result.password) {
      showCredentials(result.client, result.password);
      $('#creds').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    editingId = result.client.id;
    $('#genRow').hidden = false;
    $('#pwRow').hidden = true;
    $('#excluir').hidden = false;
    field('gen').checked = false;
    $('#formTitle').textContent = result.client.nome;
    await loadClients();
  } catch (error) {
    showMsg($('#formMsg'), error.message);
  }
  $('#salvar').disabled = false;
});

$('#excluir').addEventListener('click', async () => {
  const client = byId(editingId);
  if (!client) return;
  const typed = window.prompt(`Excluir ${client.nome}, o certificado e todas as notas? Esta ação não tem volta.\nDigite EXCLUIR para confirmar.`);
  if (typed?.trim().toUpperCase() !== 'EXCLUIR') return;
  try {
    await api(`/api/admin/clients/${client.id}`, { method: 'DELETE' });
    dlgCliente.close();
    await loadClients();
  } catch (error) {
    showMsg($('#formMsg'), error.message);
  }
});

$('#limparNotas').addEventListener('click', async () => {
  const client = byId(editingId);
  if (!client || !window.confirm(`Apagar as ${client.notes} notas e XMLs de ${client.nome}? As notas da SEFAZ só voltam se ainda estiverem dentro dos 90 dias.`)) return;
  try {
    await api(`/api/admin/clients/${client.id}/notes`, { method: 'DELETE' });
    showMsg($('#formMsg'), 'Notas apagadas.', 'ok');
    $('#limparNotas').hidden = true;
    await loadClients();
  } catch (error) {
    showMsg($('#formMsg'), error.message);
  }
});

/* ---------- certificado A1 ---------- */

const dlgCert = $('#dlgCert');

function openCert(client) {
  certId = client.id;
  $('#certSub').textContent = `${client.nome} · ${fmtDoc(client.doc)}`;
  const has = Boolean(client.cert_until);
  $('#certAtual').hidden = !has;
  $('#certRemover').hidden = !has;
  if (has) $('#certAtual').textContent = `Certificado atual: ${client.cert_subject}, válido até ${new Date(Number(client.cert_until)).toLocaleDateString('pt-BR')}. Envie outro para substituir.`;
  $('#certFile').value = '';
  $('#certPass').value = '';
  showMsg($('#certMsg'), '');
  openDialog(dlgCert);
}

$('#certForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#certFile').files[0];
  if (!file) return showMsg($('#certMsg'), 'Escolha o arquivo .pfx do certificado.');
  if (file.size > 100000) return showMsg($('#certMsg'), 'Arquivo grande demais para um certificado A1.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  const submit = $('#certForm button[type=submit]');
  submit.disabled = true;
  try {
    const r = await api(`/api/admin/clients/${certId}/cert`, { method: 'POST', body: { pfx: btoa(binary), password: $('#certPass').value } });
    $('#certPass').value = '';
    showMsg($('#certMsg'), `Certificado de ${r.subject} salvo, válido até ${new Date(r.notAfter).toLocaleDateString('pt-BR')}. A primeira busca acontece no próximo horário (6h ou 18h) ou em “Buscar agora”.`, 'ok');
    $('#certRemover').hidden = false;
    await loadClients();
  } catch (error) {
    showMsg($('#certMsg'), error.message);
  }
  submit.disabled = false;
  return undefined;
});

$('#certRemover').addEventListener('click', async () => {
  if (!window.confirm('Remover o certificado? A busca automática deste cliente para de funcionar.')) return;
  try {
    await api(`/api/admin/clients/${certId}/cert`, { method: 'DELETE' });
    dlgCert.close();
    await loadClients();
  } catch (error) {
    showMsg($('#certMsg'), error.message);
  }
});

/* ---------- importação em lote ---------- */

let pendingGroups = new Map(); // CNPJ/CPF -> notas ainda sem cliente cadastrado

// Envia as notas de um cliente em lotes de até ~3 MB e soma os resultados.
async function sendNotes(clientId, notes, progress) {
  const totals = { novas: 0, repetidas: 0, outros: 0, invalidas: 0 };
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await api(`/api/admin/clients/${clientId}/notes`, { method: 'POST', body: { notes: batch } });
    Object.keys(totals).forEach((key) => { totals[key] += result[key]; });
    batch = [];
    size = 0;
  };
  for (let i = 0; i < notes.length; i++) {
    const wire = toWire(notes[i]);
    if (notes[i].raw) wire.gz = await gzipBase64(notes[i].raw);
    const bytes = JSON.stringify(wire).length;
    if (size + bytes > MAX_BATCH_BYTES || batch.length >= 1500) await flush();
    batch.push(wire);
    size += bytes;
    if (progress && i % 200 === 0) progress(i, notes.length);
  }
  await flush();
  return totals;
}

// Cada nota vai para todo cliente cadastrado que seja o emitente ou o destinatário/tomador dela.
function distribute(notes) {
  const byClient = new Map();
  const unmatched = new Map();
  for (const note of notes) {
    const docs = new Set([docKey(note.destDoc), docKey(note.eCnpj)]);
    const owners = clients.filter((c) => docs.has(c.doc));
    if (owners.length) {
      owners.forEach((c) => {
        if (!byClient.has(c.id)) byClient.set(c.id, []);
        byClient.get(c.id).push(note);
      });
      continue;
    }
    const asDest = docKey(note.destDoc);
    const doc = asDest || docKey(note.eCnpj);
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
  const msg = $('#batchMsg');

  for (const [id, list] of byClient) {
    const client = byId(id);
    const totals = await sendNotes(id, list, (i, n) => showMsg(msg, `Enviando ${client.nome}: ${i} de ${n} notas…`, 'info'));
    rows.push({ nome: client.nome, doc: client.doc, count: list.length, status: `<span class="selo ok">Importado</span> ${totals.novas} nova(s), ${totals.repetidas} repetida(s)` });
  }
  for (const group of unmatched.values()) {
    const button = group.doc ? ` <button class="btn btn-sm" data-doc="${esc(group.doc)}" type="button">Cadastrar</button>` : '';
    rows.push({ nome: group.nome, doc: group.doc, count: group.notes.length, status: `<span class="selo espera">Sem cadastro</span>${button}` });
  }
  pendingGroups = unmatched;

  $('#batchRows').innerHTML = rows.map((row) => `
    <tr>
      <td class="nome">${esc(row.nome)}</td>
      <td>${esc(fmtDoc(row.doc) || '—')}</td>
      <td class="num">${row.count}</td>
      <td class="nome">${row.status}</td>
    </tr>`).join('');
  $('#batchResult').hidden = !rows.length;
  $('#batchPending').hidden = unmatched.size === 0;

  const messages = summarizeIgnored(ignored);
  if (unmatched.size) messages.push(`${unmatched.size} CNPJ/CPF sem cadastro: cadastre e clique em “Importar pendentes”`);
  showMsg(msg, messages.length ? `${messages.join('. ')}.` : 'Importação concluída.', unmatched.size || ignored.length ? 'alerta' : 'ok');
  await loadClients();
}

async function importFiles(files) {
  if (!files.length) return;
  showMsg($('#batchMsg'), 'Lendo arquivos…', 'info');
  try {
    const { notes, ignored } = await readFiles(files);
    await runBatch(notes, ignored);
  } catch (error) {
    showMsg($('#batchMsg'), error.message);
  }
}

$('#batchFile').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  await importFiles(files);
});
const drop = $('#soltar');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('sobre'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('sobre')));
drop.addEventListener('drop', (e) => { e.preventDefault(); importFiles([...e.dataTransfer.files]); });

$('#batchPending').addEventListener('click', async () => {
  try {
    await runBatch([...pendingGroups.values()].flatMap((group) => group.notes));
  } catch (error) {
    showMsg($('#batchMsg'), error.message);
  }
});

$('#batchRows').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-doc]');
  const group = button && pendingGroups.get(button.dataset.doc);
  if (group) openForm(null, { ...group.profile, doc: group.doc });
});

/* ---------- segurança: 2FA e atividade ---------- */

function drawTfa() {
  const on = me.totp;
  $('#aviso2fa').hidden = on;
  $('#tfaStatus').textContent = on
    ? 'Ativa. Para entrar no painel são pedidos a senha e o código do aplicativo no celular.'
    : 'Desativada. Hoje basta a senha para entrar no painel do escritório.';
  $('#tfaAcoes').innerHTML = on
    ? '<button class="btn btn-contorno" type="button" id="tfaDesligar">Desativar</button>'
    : '<button class="btn" type="button" id="tfaLigar">Ativar verificação em duas etapas</button>';
  $('#tfaAcoes').hidden = false;
  $('#tfaSetup').hidden = true;
  $('#tfaOff').hidden = true;
}

$('#tfaAcoes').addEventListener('click', async (event) => {
  if (event.target.id === 'tfaLigar') {
    try {
      const { secret, uri } = await api('/api/account/totp-setup', { method: 'POST' });
      $('#qr').innerHTML = window.qrSVG ? window.qrSVG(uri, 184) : '';
      $('#tfaSecret').textContent = secret.match(/.{1,4}/g).join(' ');
      $('#tfaSetup').hidden = false;
      $('#tfaAcoes').hidden = true;
      $('#tfaCode').focus();
    } catch (error) {
      showMsg($('#tfaMsg'), error.message, 'erro');
    }
  }
  if (event.target.id === 'tfaDesligar') {
    $('#tfaOff').hidden = false;
    $('#offPass').focus();
  }
});

$('#tfaForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/account/totp-enable', { method: 'POST', body: { code: $('#tfaCode').value } });
    me.totp = true;
    drawTfa();
    showMsg($('#tfaMsg'), 'Verificação em duas etapas ativada. Os outros aparelhos conectados saíram da conta.', 'ok');
    loadAudit();
  } catch (error) {
    showMsg($('#tfaMsg'), error.message, 'erro');
  }
});

$('#tfaOff').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/account/totp-disable', { method: 'POST', body: { password: $('#offPass').value, code: $('#offCode').value } });
    me.totp = false;
    $('#offPass').value = '';
    $('#offCode').value = '';
    drawTfa();
    showMsg($('#tfaMsg'), 'Verificação em duas etapas desativada.', 'alerta');
    loadAudit();
  } catch (error) {
    showMsg($('#tfaMsg'), error.message, 'erro');
  }
});
$('#tfaOffCancel').addEventListener('click', () => { $('#tfaOff').hidden = true; });

async function loadAudit() {
  try {
    const { rows } = await api('/api/admin/audit?limit=150');
    $('#logRows').innerHTML = rows.length
      ? rows.map((r) => `
        <tr>
          <td>${fmtDateTime(r.ts)}</td>
          <td>${esc(r.email)}</td>
          <td>${/fail|blocked/.test(r.action) ? `<span class="selo off">${esc(r.label)}</span>` : esc(r.label)}</td>
          <td class="nome">${esc(r.target)}</td>
          <td class="nome muted">${esc(r.detail)}</td>
          <td class="muted">${esc(r.ip)}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="vazio">Nenhuma atividade registrada.</td></tr>';
  } catch (error) {
    $('#logRows').innerHTML = `<tr><td colspan="6" class="vazio">${esc(error.message)}</td></tr>`;
  }
}
$('#recarregarLog').addEventListener('click', loadAudit);

const goSecurity = () => {
  $('#menuLista').hidden = true;
  $('#viewReport').hidden = true;
  $('#viewPainel').hidden = false;
  selectTab('seguranca');
  $('#p-seguranca').scrollIntoView({ behavior: 'smooth' });
};
$('#m2fa').addEventListener('click', goSecurity);
$('#ir2fa').addEventListener('click', goSecurity);

/* ---------- início ---------- */

async function init() {
  try {
    me = await api('/api/me');
    if (me.role !== 'adm') return location.replace('/cliente.html');
    if (me.mustChange) return location.replace('/senha.html');
    $('#who').textContent = me.email;
    accountMenu();
    passwordToggles();
    idleLogout(60);
    drawTfa();
    let tab = 'clientes';
    try { tab = sessionStorage.getItem('aba') || tab; } catch { /* sem armazenamento */ }
    selectTab($(`#tab-${tab}`) ? tab : 'clientes');
    await loadClients();
  } catch (error) {
    if (error.status === 401) goHome();
    else window.alert(error.message);
  }
  return undefined;
}

init();
