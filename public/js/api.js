// Chamadas à API do servidor (cookie de sessão HttpOnly enviado automaticamente).
export async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin' };
  if (method !== 'GET') {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body ?? {});
  }

  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Erro inesperado.');
    error.status = response.status;
    throw error;
  }
  return data;
}

export const goHome = () => location.replace('/index.html');
