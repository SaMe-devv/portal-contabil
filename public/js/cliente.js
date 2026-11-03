import { api, goHome } from './api.js';
import { mountReport } from './report.js';
import { $, esc } from './util.js';
import { accountMenu, idleLogout } from './ui.js';

async function init() {
  try {
    const user = await api('/api/me');
    if (user.role === 'adm') return location.replace('/admin.html');
    if (user.mustChange) return location.replace('/senha.html');
    $('#who').textContent = user.nome || user.email;
    accountMenu();
    idleLogout(120);

    const report = await mountReport($('#report'));
    const { profile, notes, sync } = await api('/api/report');
    report.render(profile, notes, sync);
  } catch (error) {
    if (error.status === 401) goHome();
    else $('#report').innerHTML = `<p class="aviso erro">${esc(error.message)}</p>`;
  }
  return undefined;
}

init();
