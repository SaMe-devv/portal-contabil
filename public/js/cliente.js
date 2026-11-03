import { api, goHome } from './api.js';
import { mountReport } from './report.js';
import { $ } from './util.js';

async function init() {
  try {
    const user = await api('/api/me');
    if (user.role === 'adm') return location.replace('/admin.html');
    $('#who').textContent = user.nome || user.email;

    const report = await mountReport($('#report'));
    const { profile, notes } = await api('/api/report');
    report.render(profile, notes);
  } catch (error) {
    if (error.status === 401) goHome();
    else $('#report').innerHTML = `<p class="msg">${error.message}</p>`;
  }
}

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  goHome();
});

init();
