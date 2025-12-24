import { net, safeStorage } from 'electron';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AuthLoginResult, AuthStatus, AuthUserInfo, AuthLogoutResult } from '@matricarmz/shared';
import { syncState } from '../database/schema.js';

const KEY_SESSION = 'auth.session';

type StoredSession = {
  enc: boolean;
  data: string; // encrypted hex or plaintext json
};

export type SessionPayload = {
  accessToken: string;
  refreshToken: string;
  user: AuthUserInfo;
  savedAt: number;
};

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

async function setSyncState(db: BetterSQLite3Database, key: string, value: string) {
  const ts = nowMs();
  await db.insert(syncState).values({ key, value, updatedAt: ts }).onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: ts } });
}

async function getSyncState(db: BetterSQLite3Database, key: string): Promise<string | null> {
  const row = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  return row[0]?.value ? String(row[0].value) : null;
}

export async function getSession(db: BetterSQLite3Database): Promise<SessionPayload | null> {
  const raw = await getSyncState(db, KEY_SESSION).catch(() => null);
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
  await setSyncState(db, KEY_SESSION, '');
}

export async function authStatus(db: BetterSQLite3Database): Promise<AuthStatus> {
  const payload = await getSession(db);
  if (!payload) return { loggedIn: false, user: null };
  return { loggedIn: true, user: payload.user };
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
      savedAt: nowMs(),
    };
    const stored = encryptJson(JSON.stringify(payload));
    await setSyncState(db, KEY_SESSION, JSON.stringify(stored));
    return { ok: true, accessToken: payload.accessToken, refreshToken: payload.refreshToken, user: payload.user };
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
      return { ok: false, error: `refresh HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !json?.accessToken || !json?.refreshToken || !json?.user) return { ok: false, error: 'bad refresh response' };

    const payload: SessionPayload = {
      accessToken: String(json.accessToken),
      refreshToken: String(json.refreshToken),
      user: json.user as AuthUserInfo,
      savedAt: nowMs(),
    };
    const stored = encryptJson(JSON.stringify(payload));
    await setSyncState(db, KEY_SESSION, JSON.stringify(stored));
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

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}


