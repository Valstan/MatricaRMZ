// Шим 'node:fs/promises' (android): файловой системы у портированных сервисов
// нет, поэтому «файл» — запись в localStorage WebView под своим путём.
//
// Потребителей в бандле двое:
//  - loginMruService — машинно-локальный список логинов (без паролей) рядом с
//    userData; на планшете он так же переживает пересоздание реплики, поэтому
//    подсказки экрана входа работают как на десктопе;
//  - десктопная ветка resetLocalDatabase (rm/stat) — на android перекрыта
//    setResetLocalDatabaseImpl и не исполняется, там честный отказ.

const PREFIX = 'matricarmz.fs:';

function store(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export async function readFile(path: string, _encoding?: unknown): Promise<string> {
  const value = store()?.getItem(PREFIX + path);
  if (value == null) {
    const err = new Error(`ENOENT: no such file, open '${path}'`) as Error & { code?: string };
    err.code = 'ENOENT';
    throw err;
  }
  return value;
}

export async function writeFile(path: string, data: string, _encoding?: unknown): Promise<void> {
  store()?.setItem(PREFIX + path, String(data));
}

export async function readdir(dir: string): Promise<string[]> {
  // «Каталог» — общий префикс ключей; отдаём только прямых детей (без подпапок).
  const s = store();
  if (!s) return [];
  const prefix = PREFIX + String(dir).replace(/[\\/]+$/, '');
  const names: string[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const key = s.key(i) ?? '';
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length).replace(/^[\\/]/, '');
    if (rest && !/[\\/]/.test(rest)) names.push(rest);
  }
  return names;
}

export async function rm(path: string, opts?: { force?: boolean }): Promise<void> {
  // Одиночный «файл» удаляем (нужно pending-export'у синка); рекурсивное
  // удаление каталогов остаётся недоступным — desktop-ветка resetLocalDatabase
  // на android перекрыта setResetLocalDatabaseImpl.
  const s = store();
  const key = PREFIX + path;
  if (s?.getItem(key) != null) {
    s.removeItem(key);
    return;
  }
  if (opts?.force) return;
  throw new Error('node:fs/promises shim: rm каталога недоступен в android-клиенте');
}

export async function stat(_path: string): Promise<never> {
  throw new Error('node:fs/promises shim: stat недоступен в android-клиенте');
}

export default { readFile, writeFile, readdir, rm, stat };
