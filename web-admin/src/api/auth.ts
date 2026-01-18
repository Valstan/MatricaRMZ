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

export async function register(args: { login: string; password: string; fullName: string; position: string }) {
  const r = await apiJson('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
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

export async function profileGet() {
  return apiJson('/auth/profile', { method: 'GET' });
}

export async function profileUpdate(args: { fullName?: string | null; position?: string | null; sectionName?: string | null }) {
  return apiJson('/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
}

