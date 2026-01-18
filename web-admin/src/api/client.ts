const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL ?? '';

const ACCESS_KEY = 'matrica_access_token';
const REFRESH_KEY = 'matrica_refresh_token';
const LOG_KEY = 'matrica_webadmin_log';

type JsonValue = any;

function getAccessToken() {
  return localStorage.getItem(ACCESS_KEY);
}

function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  const r = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as any;
  if (!j?.ok || !j.accessToken || !j.refreshToken) return null;
  setTokens(j.accessToken, j.refreshToken);
  return j.accessToken;
}

export async function apiFetch(path: string, init?: RequestInit, opts?: { retry?: boolean }): Promise<{ ok: boolean; status: number; json?: JsonValue; text?: string }> {
  const headers = new Headers(init?.headers ?? {});
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const logEnabled = typeof localStorage !== 'undefined' && localStorage.getItem(LOG_KEY) === 'true';
  if (logEnabled) {
    const method = init?.method ?? 'GET';
    console.info(`[web-admin api] ${method} ${path}`);
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const status = res.status;
  const text = await res.text().catch(() => '');
  let json: JsonValue | undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (status === 401 && opts?.retry !== false) {
    const nextToken = await refreshAccessToken();
    if (nextToken) {
      const retryHeaders = new Headers(init?.headers ?? {});
      retryHeaders.set('Authorization', `Bearer ${nextToken}`);
      const retryRes = await fetch(`${API_BASE}${path}`, { ...init, headers: retryHeaders });
      const retryStatus = retryRes.status;
      const retryText = await retryRes.text().catch(() => '');
      let retryJson: JsonValue | undefined;
      try {
        retryJson = retryText ? JSON.parse(retryText) : undefined;
      } catch {
        retryJson = undefined;
      }
      return { ok: retryRes.ok, status: retryStatus, json: retryJson, text: retryText };
    }
  }

  return { ok: res.ok, status, json, text };
}

export async function apiJson(path: string, init?: RequestInit) {
  const r = await apiFetch(path, init);
  return r.json ?? { ok: false, error: `HTTP ${r.status}` };
}

