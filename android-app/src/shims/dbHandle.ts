// Шим database/db.ts (android): better-sqlite3 в WebView нет. Портированный
// syncService к handle не обращается (android подставляет исполнитель через
// setSyncSqlExecutor), поэтому getSqliteHandle честно отдаёт null, а десктопные
// open-функции падают громко.

export function openSqlite(): never {
  throw new Error('db shim: openSqlite недоступен в android-клиенте (используй AsyncSqlite-адаптер)');
}

export function openSqliteReadonly(): never {
  throw new Error('db shim: openSqliteReadonly недоступен в android-клиенте');
}

export function getSqliteHandle(): null {
  return null;
}
