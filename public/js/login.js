import { api } from './api.js';
import { $ } from './util.js';

const form = $('#form');
const message = $('#msg');
const goTo = (user) => location.replace(user.role === 'adm' ? '/admin.html' : '/cliente.html');

// Quem já tem sessão válida vai direto para o painel.
api('/api/me').then(goTo).catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: { email: form.email.value, password: form.password.value },
    });
    goTo(user);
  } catch (error) {
    message.textContent = error.message;
    message.hidden = false;
    button.disabled = false;
  }
});
