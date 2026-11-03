// Peças de interface usadas em várias páginas: mostrar senha, menu da conta, janelas.
import { api, goHome } from './api.js';
import { $, $$ } from './util.js';

export function passwordToggles(root = document) {
  $$('.ver-senha', root).forEach((button) => {
    button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', show ? 'Esconder senha' : 'Mostrar senha');
      button.querySelector('use').setAttribute('href', `img/icons.svg#${show ? 'i-eyeoff' : 'i-eye'}`);
    });
  });
}

export async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  goHome();
}

// Menu da conta no cabeçalho: trocar senha, sair de todos os aparelhos, sair.
export function accountMenu() {
  const toggle = $('#menuBt');
  const list = $('#menuLista');
  const close = () => { list.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
  });
  document.addEventListener('click', (event) => { if (!list.contains(event.target)) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  $('#mSenha').addEventListener('click', () => { location.href = '/senha.html?voluntario=1'; });
  $('#mTodos').addEventListener('click', async () => {
    if (!window.confirm('Encerrar a sessão em todos os aparelhos, inclusive neste?')) return;
    await api('/api/account/logout-all', { method: 'POST' }).catch(() => {});
    goHome();
  });
  $('#mSair').addEventListener('click', logout);
}

// Encerra a sessão no navegador depois de um tempo sem uso (o servidor também encerra).
export function idleLogout(minutes) {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(logout, minutes * 60 * 1000);
  };
  ['click', 'keydown', 'scroll', 'pointermove'].forEach((e) => window.addEventListener(e, reset, { passive: true }));
  reset();
}

export function showMsg(target, text, kind = 'erro') {
  target.textContent = text;
  target.className = `aviso ${kind}`;
  target.hidden = !text;
}

export function openDialog(dialog) {
  dialog.showModal();
  dialog.querySelector('[autofocus], input:not([type=hidden]):not([hidden]), button')?.focus();
}
