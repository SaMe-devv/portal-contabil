// Chamadas à API do servidor (cookie de sessão HttpOnly enviado automaticamente).
export async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body ?? {});
  }

  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Erro inesperado (HTTP ${response.status}).`);
    error.status = response.status;
    Object.assign(error, data);
    // Senha provisória: só deixa seguir depois de trocar.
    if (data.mustChange && !location.pathname.endsWith('/senha.html')) location.replace('/senha.html');
    throw error;
  }
  return data;
}

export const goHome = () => location.replace('/index.html');
