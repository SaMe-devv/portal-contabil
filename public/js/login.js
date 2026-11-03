import { api } from './api.js';
import { $ } from './util.js';
import { passwordToggles, showMsg } from './ui.js';

const form = $('#login');
const message = $('#msg');
const codeBox = $('#campoCodigo');
const goTo = (user) => {
  if (user.mustChange) return location.replace('/senha.html');
  return location.replace(user.role === 'adm' ? '/admin.html' : '/cliente.html');
};

passwordToggles();
// Quem já tem sessão válida vai direto para o painel.
api('/api/me').then(goTo).catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showMsg(message, '');
  const login = form.login.value.trim();
  const password = form.password.value;
  if (!login || !password) {
    showMsg(message, 'Preencha o login e a senha.');
    return;
  }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const body = { login, password };
    if (!codeBox.hidden) body.code = form.code.value.trim();
    const { user } = await api('/api/login', { method: 'POST', body });
    goTo(user);
  } catch (error) {
    if (error.totpRequired) {
      const first = codeBox.hidden;
      codeBox.hidden = false;
      form.code.value = '';
      form.code.focus();
      showMsg(message, first ? 'Falta só o código de verificação.' : error.message, first ? 'info' : 'erro');
    } else {
      showMsg(message, error.message);
    }
    button.disabled = false;
  }
});
