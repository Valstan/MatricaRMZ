// Идентичность android-клиента (план, «Ключевые решения» §5): clientId вида
// `<host>-<uuid>` (тот же формат, что у десктопа — sidecar-валидация и
// флот-инструменты web-admin его уже понимают), host = имя устройства из шима
// node:os. Порядок чтения — как на десктопе (clientIdStore.ts): БД → sidecar →
// генерация; пишем всегда в оба. Sidecar-аналог на Android — localStorage
// WebView: переживает пересоздание реплики (лечение инцидента gala/PC69 —
// призрачные client_id после self-heal БД); при переустановке APK стирается
// вместе с данными приложения, это допустимо.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  SettingsKey,
  settingsGetString,
  settingsSetString,
} from '../../../electron-app/src/main/services/settingsStore.js';
import { hostname } from '../shims/nodeOs.js';

const SIDECAR_KEY = 'matricarmz.clientId';

const CLIENT_ID_RE = /^[\w.-]{1,64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type KV = { get(key: string): string | null; set(key: string, value: string): void };

function defaultKv(): KV {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) };
  } catch {
    // localStorage может быть недоступен (vitest/приватный режим)
  }
  const mem = new Map<string, string>();
  return { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) };
}

function readSidecar(kv: KV): string {
  const raw = String(kv.get(SIDECAR_KEY) ?? '').trim();
  return CLIENT_ID_RE.test(raw) ? raw : '';
}

export async function ensureClientId(db: BetterSQLite3Database, kv: KV = defaultKv()): Promise<string> {
  const fromDb = String((await settingsGetString(db, SettingsKey.ClientId).catch(() => null)) ?? '').trim();
  if (CLIENT_ID_RE.test(fromDb)) {
    if (readSidecar(kv) !== fromDb) kv.set(SIDECAR_KEY, fromDb);
    return fromDb;
  }
  const fromSidecar = readSidecar(kv);
  if (fromSidecar) {
    await settingsSetString(db, SettingsKey.ClientId, fromSidecar);
    return fromSidecar;
  }
  const generated = `${hostname()}-${globalThis.crypto.randomUUID()}`;
  await settingsSetString(db, SettingsKey.ClientId, generated);
  kv.set(SIDECAR_KEY, generated);
  return generated;
}
