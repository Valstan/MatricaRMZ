import { apiJson, clearTokens, setTokens } from './client.js';

export async function login(username: string, password: string) {
  const r = await apiJson('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r?.ok && r.accessToken && r.refreshToken) {
    setTokens(r.accessToken, r.refreshToken);
  }
  return r;
}

export async function logout() {
  clearTokens();
}

export async function me() {
  return apiJson('/auth/me', { method: 'GET' });
}

