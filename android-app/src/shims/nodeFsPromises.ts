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

export async function rm(_path: string, _opts?: unknown): Promise<never> {
  throw new Error('node:fs/promises shim: rm недоступен в android-клиенте');
}

export async function stat(_path: string): Promise<never> {
  throw new Error('node:fs/promises shim: stat недоступен в android-клиенте');
}

export default { readFile, writeFile, rm, stat };
