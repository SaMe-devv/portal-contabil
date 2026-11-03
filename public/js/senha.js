import { api, goHome } from './api.js';
import { $ } from './util.js';
import { logout, passwordToggles, showMsg } from './ui.js';

const form = $('#form');
const message = $('#msg');
const nova = $('#f-nova');
const voluntario = new URLSearchParams(location.search).has('voluntario');
let user = null;

passwordToggles();

function rate(value) {
  const rules = { len: value.length >= 10, mix: /[A-Za-z]/.test(value) && /\d/.test(value) };
  Object.entries(rules).forEach(([key, ok]) => $(`[data-r="${key}"]`).classList.toggle('ok', ok));
  let score = Math.min(value.length / 16, 1) * 60 + (rules.mix ? 20 : 0) + (/[^A-Za-z0-9]/.test(value) ? 10 : 0) + (/[A-Z]/.test(value) && /[a-z]/.test(value) ? 10 : 0);
  if (!rules.len) score = Math.min(score, 35);
  const bar = $('#barra');
  bar.style.width = `${score}%`;
  bar.style.background = score < 50 ? 'var(--erro)' : score < 80 ? 'var(--laranja)' : 'var(--ok)';
}
nova.addEventListener('input', () => rate(nova.value));

const home = () => location.replace(user?.role === 'adm' ? '/admin.html' : '/cliente.html');

async function init() {
  try {
    user = await api('/api/me');
    $('#f-user').value = user.email;
    if (!user.mustChange) {
      $('#motivo').textContent = 'Escolha uma senha forte, que você não use em outros sites.';
    }
    $('#voltar').hidden = user.mustChange && !voluntario;
  } catch (error) {
    if (error.status === 401) goHome();
  }
}

$('#voltar').addEventListener('click', (event) => { event.preventDefault(); home(); });
$('#sair').addEventListener('click', (event) => { event.preventDefault(); logout(); });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showMsg(message, '');
  if (nova.value !== $('#f-conf').value) {
    showMsg(message, 'A confirmação não é igual à nova senha.');
    return;
  }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/api/account/password', { method: 'POST', body: { current: $('#f-atual').value, next: nova.value } });
    showMsg(message, 'Senha alterada. Abrindo o portal…', 'ok');
    setTimeout(home, 900);
  } catch (error) {
    if (error.status === 401) return goHome();
    showMsg(message, error.message);
    button.disabled = false;
  }
  return undefined;
});

init();
