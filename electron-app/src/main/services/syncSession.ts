// Доступ движка синка к живой сессии. Прячем за провайдером, потому что расшифровать
// сохранённую сессию может только процесс с OS-keyring (`safeStorage`/DPAPI): в
// отдельном процессе воркера `safeStorage` недоступен вовсе, а `app.getPath` — тем
// более. Воркер ставит провайдер, который спрашивает main по порту; main и android
// ставят прямой провайдер (`authSessionProvider`).
//
// Провайдер ставится явно и никакого «импорта по умолчанию» здесь нет намеренно: в
// графе воркера `authService` тянул бы за собой `safeStorage`, а статический импорт
// имени, которого в utility-процессе нет, роняет процесс при загрузке (проверено).
// Пока провайдер не поставлен, движок считает, что сессии нет, — и честно отказывает
// «auth required», как и раньше без логина.
//
// Модуль без node/electron-импортов: его тянут оба процесса.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/** Что движку синка действительно нужно от сессии — и ничего сверх. */
export type SyncSessionView = {
  accessToken: string | null;
  /** Есть refresh-токен: решает, пробовать ли обновление после 401. */
  canRefresh: boolean;
  userId: string | null;
  username: string | null;
};

export type SyncRefreshOutcome = { ok: true; accessToken: string } | { ok: false; error: string };

export type SyncSessionProvider = {
  read: (db: BetterSQLite3Database) => Promise<SyncSessionView | null>;
  /**
   * Обновление токена. Токен берётся из актуальной сессии вызывающей стороны — очередь
   * из двух refresh'ей не должна отправлять протухший токен (это делает authRefresh).
   */
  refresh: (db: BetterSQLite3Database, args: { apiBaseUrl: string }) => Promise<SyncRefreshOutcome>;
  clear: (db: BetterSQLite3Database, opts?: { includeSidecar?: boolean }) => Promise<void>;
};

let installed: SyncSessionProvider | null = null;

export function setSyncSessionProvider(provider: SyncSessionProvider | null): void {
  installed = provider;
}

export async function readSyncSession(db: BetterSQLite3Database): Promise<SyncSessionView | null> {
  if (!installed) return null;
  try {
    return await installed.read(db);
  } catch {
    return null;
  }
}

export async function refreshSyncSession(
  db: BetterSQLite3Database,
  args: { apiBaseUrl: string },
): Promise<SyncRefreshOutcome> {
  if (!installed) return { ok: false, error: 'no session provider' };
  try {
    return await installed.refresh(db, args);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function clearSyncSession(
  db: BetterSQLite3Database,
  opts?: { includeSidecar?: boolean },
): Promise<void> {
  if (!installed) return;
  try {
    await installed.clear(db, opts);
  } catch {
    // сессия могла уже исчезнуть — чистить нечего
  }
}
