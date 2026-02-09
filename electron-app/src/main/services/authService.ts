import { net, safeStorage } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AuthLoginResult, AuthStatus, AuthUserInfo, AuthLogoutResult } from '@matricarmz/shared';
import { SettingsKey, settingsGetString, settingsSetString } from './settingsStore.js';
import { logMessageSetEnabled, logMessageSetMode } from './logService.js';

type StoredSession = {
  enc: boolean;
  data: string; // encrypted hex or plaintext json
};

export type SessionPayload = {
  accessToken: string;
  refreshToken: string;
  user: AuthUserInfo;
  permissions: Record<string, boolean>;
  savedAt: number;
};

export type LoginOption = { login: string; fullName: string; role: string };

function nowMs() {
  return Date.now();
}

function encryptJson(json: string): StoredSession {
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(json);
    return { enc: true, data: buf.toString('hex') };
  }
  return { enc: false, data: json };
}

function decryptToJson(stored: StoredSession): string | null {
  try {
    if (!stored.enc) return stored.data;
    const buf = Buffer.from(stored.data, 'hex');
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export async function getSession(db: BetterSQLite3Database): Promise<SessionPayload | null> {
  const raw = await settingsGetString(db, SettingsKey.AuthSession).catch(() => null);
  if (!raw) return null;
  const stored = safeJsonParse(raw) as StoredSession | null;
  if (!stored || typeof stored !== 'object' || typeof (stored as any).data !== 'string') return null;
  const json = decryptToJson(stored);
  if (!json) return null;
  const payload = safeJsonParse(json) as SessionPayload | null;
  if (!payload || typeof payload !== 'object') return null;
  if (typeof (payload as any).accessToken !== 'string') return null;
  if (typeof (payload as any).refreshToken !== 'string') return null;
  const user = (payload as any).user;
  if (!user || typeof user.username !== 'string') return null;
  return payload;
}

export async function clearSession(db: BetterSQLite3Database) {
  await settingsSetString(db, SettingsKey.AuthSession, '');
}

export async function authStatus(db: BetterSQLite3Database): Promise<AuthStatus> {
  const payload = await getSession(db);
  if (!payload) return { loggedIn: false, user: null, permissions: null };
  return { loggedIn: true, user: payload.user, permissions: payload.permissions ?? {} };
}

export async function authSync(db: BetterSQLite3Database, args: { apiBaseUrl: string }): Promise<AuthStatus> {
  const session = await getSession(db).catch(() => null);
  if (!session?.accessToken) return { loggedIn: false, user: null, permissions: null };

  // 1) Пробуем /auth/me (обновляет permissions после делегирований)
  try {
    const r = await net.fetch(`${args.apiBaseUrl}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (r.status === 401 || r.status === 403) {
      const t = await r.text().catch(() => '');
      if (t.includes('user disabled')) {
        await clearSession(db);
        return { loggedIn: false, user: null, permissions: null };
      }
    }
    if (r.ok) {
      const json = (await r.json().catch(() => null)) as any;
      if (json?.ok && json?.user && json?.permissions) {
        const payload: SessionPayload = {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          user: json.user as AuthUserInfo,
          permissions: (json.permissions ?? {}) as Record<string, boolean>,
          savedAt: nowMs(),
        };
        const stored = encryptJson(JSON.stringify(payload));
        await settingsSetString(db, SettingsKey.AuthSession, JSON.stringify(stored));
        return { loggedIn: true, user: payload.user, permissions: payload.permissions };
      }
    }
  } catch {
    // ignore
  }

  // 2) Fallback: если accessToken протух — пусть authRefresh обновит permissions.
  if (session.refreshToken) {
    const refreshed = await authRefresh(db, { apiBaseUrl: args.apiBaseUrl, refreshToken: session.refreshToken });
    if (refreshed.ok) return await authStatus(db);
  }

  return await authStatus(db);
}

export async function authLogin(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string; username: string; password: string },
): Promise<AuthLoginResult> {
  try {
    const url = `${args.apiBaseUrl}/auth/login`;
    const r = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: args.username, password: args.password }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `login HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.accessToken || !json?.refreshToken || !json?.user) return { ok: false, error: 'bad login response' };

    const payload: SessionPayload = {
      accessToken: String(json.accessToken),
      refreshToken: String(json.refreshToken),
      user: json.user as AuthUserInfo,
      permissions: (json.permissions ?? {}) as Record<string, boolean>,
      savedAt: nowMs(),
    };
    const stored = encryptJson(JSON.stringify(payload));
    await settingsSetString(db, SettingsKey.AuthSession, JSON.stringify(stored));
    await logMessageSetEnabled(db, true, args.apiBaseUrl);
    await logMessageSetMode(db, 'dev');
    return {
      ok: true,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      user: payload.user,
      permissions: payload.permissions,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authLoginOptions(
  _db: BetterSQLite3Database,
  args: { apiBaseUrl: string },
): Promise<{ ok: true; rows: LoginOption[] } | { ok: false; error: string }> {
  try {
    const url = `${args.apiBaseUrl}/auth/login-options`;
    const r = await net.fetch(url, { method: 'GET' });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `login-options HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !Array.isArray(json.rows)) return { ok: false, error: 'bad login-options response' };
    const rows = json.rows
      .map((row: any) => ({
        login: String(row.login ?? '').trim(),
        fullName: String(row.fullName ?? '').trim(),
        role: String(row.role ?? '').trim(),
      }))
      .filter((row: LoginOption) => row.login);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authRegister(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string; login: string; password: string; fullName: string; position: string },
): Promise<AuthLoginResult> {
  try {
    const url = `${args.apiBaseUrl}/auth/register`;
    const r = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: args.login,
        password: args.password,
        fullName: args.fullName,
        position: args.position,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `register HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.accessToken || !json?.refreshToken || !json?.user) return { ok: false, error: 'bad register response' };

    const payload: SessionPayload = {
      accessToken: String(json.accessToken),
      refreshToken: String(json.refreshToken),
      user: json.user as AuthUserInfo,
      permissions: (json.permissions ?? {}) as Record<string, boolean>,
      savedAt: nowMs(),
    };
    const stored = encryptJson(JSON.stringify(payload));
    await settingsSetString(db, SettingsKey.AuthSession, JSON.stringify(stored));
    await logMessageSetEnabled(db, true, args.apiBaseUrl);
    await logMessageSetMode(db, 'dev');
    return {
      ok: true,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      user: payload.user,
      permissions: payload.permissions,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authRefresh(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string; refreshToken: string },
): Promise<{ ok: true; accessToken: string; refreshToken: string; user: AuthUserInfo } | { ok: false; error: string }> {
  try {
    const r = await net.fetch(`${args.apiBaseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: args.refreshToken }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (r.status === 401 || r.status === 403) {
        // Any auth rejection on refresh means local tokens are no longer valid.
        await clearSession(db);
      }
      return { ok: false, error: `refresh HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.accessToken || !json?.refreshToken || !json?.user) return { ok: false, error: 'bad refresh response' };

    const payload: SessionPayload = {
      accessToken: String(json.accessToken),
      refreshToken: String(json.refreshToken),
      user: json.user as AuthUserInfo,
      permissions: (json.permissions ?? {}) as Record<string, boolean>,
      savedAt: nowMs(),
    };
    const stored = encryptJson(JSON.stringify(payload));
    await settingsSetString(db, SettingsKey.AuthSession, JSON.stringify(stored));
    return { ok: true, accessToken: payload.accessToken, refreshToken: payload.refreshToken, user: payload.user };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authLogout(db: BetterSQLite3Database, args: { apiBaseUrl: string; refreshToken?: string }): Promise<AuthLogoutResult> {
  try {
    const session = await getSession(db);
    const token = (args.refreshToken?.trim() || session?.refreshToken || '').trim();
    const accessToken = session?.accessToken ?? null;

    // Сначала пробуем уведомить сервер (если есть refresh token и access token).
    if (token && accessToken) {
      await net
        .fetch(`${args.apiBaseUrl}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ refreshToken: token }),
        })
        .catch(() => {});
    }

    // Затем стираем локальную сессию.
    await clearSession(db);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authChangePassword(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string; currentPassword: string; newPassword: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await getSession(db);
    const accessToken = session?.accessToken ?? null;
    if (!accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ currentPassword: args.currentPassword, newPassword: args.newPassword }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `change-password HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false, error: json?.error ?? 'bad response' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authProfileGet(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string },
): Promise<{ ok: true; profile: any } | { ok: false; error: string }> {
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/auth/profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `profile HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.profile) return { ok: false, error: json?.error ?? 'bad profile response' };
    return { ok: true, profile: json.profile };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authProfileUpdate(
  db: BetterSQLite3Database,
  args: {
    apiBaseUrl: string;
    fullName?: string | null;
    position?: string | null;
    sectionName?: string | null;
    chatDisplayName?: string | null;
    telegramLogin?: string | null;
    maxLogin?: string | null;
  },
): Promise<{ ok: true; profile: any } | { ok: false; error: string }> {
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/auth/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        ...(args.fullName !== undefined ? { fullName: args.fullName } : {}),
        ...(args.chatDisplayName !== undefined ? { chatDisplayName: args.chatDisplayName } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.sectionName !== undefined ? { sectionName: args.sectionName } : {}),
        ...(args.telegramLogin !== undefined ? { telegramLogin: args.telegramLogin } : {}),
        ...(args.maxLogin !== undefined ? { maxLogin: args.maxLogin } : {}),
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `profile HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.profile) return { ok: false, error: json?.error ?? 'bad profile response' };
    return { ok: true, profile: json.profile };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authSettingsGet(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string },
): Promise<{ ok: true; settings: { loggingEnabled: boolean; loggingMode: 'dev' | 'prod' } } | { ok: false; error: string }> {
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/auth/settings`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `settings HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.settings) return { ok: false, error: json?.error ?? 'bad settings response' };
    const loggingEnabled = json.settings.loggingEnabled === true;
    const rawMode = String(json.settings.loggingMode ?? '').trim().toLowerCase();
    const loggingMode = rawMode === 'dev' ? 'dev' : 'prod';
    return { ok: true, settings: { loggingEnabled, loggingMode } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authSettingsUpdate(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string; loggingEnabled?: boolean; loggingMode?: 'dev' | 'prod' },
): Promise<{ ok: true; settings: { loggingEnabled: boolean; loggingMode: 'dev' | 'prod' } } | { ok: false; error: string }> {
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/auth/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        ...(args.loggingEnabled !== undefined ? { loggingEnabled: args.loggingEnabled } : {}),
        ...(args.loggingMode !== undefined ? { loggingMode: args.loggingMode } : {}),
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `settings HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.settings) return { ok: false, error: json?.error ?? 'bad settings response' };
    const loggingEnabled = json.settings.loggingEnabled === true;
    const rawMode = String(json.settings.loggingMode ?? '').trim().toLowerCase();
    const loggingMode = rawMode === 'dev' ? 'dev' : 'prod';
    return { ok: true, settings: { loggingEnabled, loggingMode } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
export async function presenceMe(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string },
): Promise<{ ok: true; online: boolean; lastActivityAt: number | null } | { ok: false; error: string }> {
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/presence/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `presence HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false, error: 'bad presence response' };
    return { ok: true, online: !!json.online, lastActivityAt: json.lastActivityAt ?? null };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}


