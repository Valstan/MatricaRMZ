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

function nowMs() {
  return Date.now();
}

// In-memory session fallback for machines where OS-level encryption (safeStorage)
// is unavailable (e.g. a Linux box with no keyring). We REFUSE to persist tokens
// as plaintext on disk (fail-closed): the session then lives only in this process
// and a re-login is required after restart. On Windows (DPAPI) and macOS
// safeStorage is always available, so prod clients keep surviving restarts via the
// encrypted on-disk session — behaviour there is unchanged.
let memorySession: SessionPayload | null = null;

async function persistSession(db: BetterSQLite3Database, payload: SessionPayload): Promise<void> {
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(JSON.stringify(payload));
    const stored: StoredSession = { enc: true, data: buf.toString('hex') };
    await settingsSetString(db, SettingsKey.AuthSession, JSON.stringify(stored));
    memorySession = null; // the encrypted on-disk copy is canonical
    return;
  }
  // Fail-closed: hold the session in memory only; never write plaintext to disk.
  memorySession = payload;
  await settingsSetString(db, SettingsKey.AuthSession, '');
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
  if (memorySession) return memorySession;
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
  // Migrate a legacy plaintext-on-disk session off disk: hold it in memory and, if
  // encryption is now available, re-persist it encrypted — then the plaintext copy
  // is wiped and never trusted again.
  if (stored.enc === false) {
    await persistSession(db, payload).catch(() => {});
  }
  return payload;
}

export async function clearSession(db: BetterSQLite3Database) {
  memorySession = null;
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
        await persistSession(db, payload);
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
    await persistSession(db, payload);
    await logMessageSetEnabled(db, true, args.apiBaseUrl);
    await logMessageSetMode(db, 'dev');
    return {
      ok: true,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      user: payload.user,
      permissions: payload.permissions,
      ...(json.fullName ? { fullName: String(json.fullName) } : {}),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authLoginSuggest(
  _db: BetterSQLite3Database,
  args: { apiBaseUrl: string; q: string },
): Promise<{ ok: true; rows: Array<{ login: string; fullName: string }> } | { ok: false; error: string }> {
  try {
    const q = String(args.q ?? '').trim();
    if (q.length < 2) return { ok: true, rows: [] };
    const url = `${args.apiBaseUrl}/auth/login-suggest?q=${encodeURIComponent(q)}`;
    const r = await net.fetch(url, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `login-suggest HTTP ${r.status}` };
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !Array.isArray(json.rows)) return { ok: false, error: 'bad login-suggest response' };
    const rows = json.rows
      .map((row: any) => ({ login: String(row.login ?? '').trim(), fullName: String(row.fullName ?? '').trim() }))
      .filter((row: { login: string }) => row.login);
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
    await persistSession(db, payload);
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
    await persistSession(db, payload);
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

export async function authUiProfileGet(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string },
): Promise<{ ok: true; profile: unknown | null } | { ok: false; error: string }> {
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/auth/ui-profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `ui-profile HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false, error: json?.error ?? 'bad ui-profile response' };
    return { ok: true, profile: json.profile ?? null };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function authUiProfileSet(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string; profile: unknown },
): Promise<{ ok: true; profile: unknown; stale: boolean } | { ok: false; error: string }> {
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) return { ok: false, error: 'missing session' };
    const r = await net.fetch(`${args.apiBaseUrl}/auth/ui-profile`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: args.profile }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `ui-profile HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false, error: json?.error ?? 'bad ui-profile response' };
    return { ok: true, profile: json.profile, stale: json.stale === true };
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


