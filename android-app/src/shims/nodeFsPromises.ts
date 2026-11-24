// Шим 'node:fs/promises' (android): файловой системы у портированных сервисов
// нет, поэтому «файл» — запись в localStorage WebView под своим путём.
//
// Потребителей в бандле двое:
//  - loginMruService — машинно-локальный список логинов (без паролей) рядом с
//    userData; на планшете он так же переживает пересоздание реплики, поэтому
//    подсказки экрана входа работают как на десктопе;
//  - десктопная ветка resetLocalDatabase (rm/stat) — на android перекрыта
//    setResetLocalDatabaseImpl и не исполняется, там честный отказ.
//
// `stat` раньше бросал ошибку всегда, и разбор «файла» выгрузки pending всегда
// считал его отсутствующим (план #114, шаг 30): теперь stat честно отвечает по
// записи в localStorage — того же самого файла, который читает readFile.

import { fsRead, fsRemove, fsStat, fsStore, fsWrite } from './fsStore.js';

export async function readFile(path: string, _encoding?: unknown): Promise<string> {
  const value = fsRead(path);
  if (value == null) {
    const err = new Error(`ENOENT: no such file, open '${path}'`) as Error & { code?: string };
    err.code = 'ENOENT';
    throw err;
  }
  return value;
}

export async function writeFile(path: string, data: string, _encoding?: unknown): Promise<void> {
  fsWrite(path, String(data));
}

export async function readdir(dir: string): Promise<string[]> {
  // «Каталог» — общий префикс ключей; отдаём только прямых детей (без подпапок).
  const s = fsStore();
  if (!s) return [];
  const prefix = 'matricarmz.fs:' + String(dir).replace(/[\\/]+$/, '');
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
  if (fsRemove(path)) return;
  if (opts?.force) return;
  throw new Error('node:fs/promises shim: rm каталога недоступен в android-клиенте');
}

export async function stat(path: string): Promise<{ size: number; mtimeMs: number }> {
  const info = fsStat(path);
  if (!info) {
    const err = new Error(`ENOENT: no such file, stat '${path}'`) as Error & { code?: string };
    err.code = 'ENOENT';
    throw err;
  }
  return info;
}

export default { readFile, writeFile, readdir, rm, stat };
