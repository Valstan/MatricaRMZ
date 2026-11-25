// Шим 'services/fileService.js' для android-бандла (подставляется vite-плагином
// androidShims).
//
// Десктопный fileService — это диск: файловые диалоги, кэш скачивания, печать
// через скрытое окно, zip-архивы, буфер обмена. У WebView ничего этого нет.
//
// На планшете в бандл этот модуль попадает только из-за ИИ-чата: вложение к
// вопросу грузится с ПУТИ на диске (`filesUpload`). На планшете пути нет —
// вложение приходит из галереи через узкий мост вложений (filesBridge.ts), где
// канал свой (`files:uploadBlob`). Поэтому здесь честный отказ с объяснением,
// а не молчание.
//
// `filesMeta` — исключение: пути на диске не требует, это один GET к серверу
// (`GET /files/:id/meta`), который заодно ПРОВЕРЯЕТ доступ к файлу. Без него
// передача файла между Верстаками на планшете не работала бы: нечем было бы
// проверить, что отправитель вправе переслать этот файл (см. `filesBridge.ts`).
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { FileRef } from '@matricarmz/shared';

import { httpAuthed } from '../../../electron-app/src/main/services/httpClient.js';
import { httpFailureLine } from '../../../electron-app/src/main/services/httpFailureText.js';

export async function filesUpload(
  _db: BetterSQLite3Database,
  _apiBaseUrl: string,
  _args: { path: string; fileName?: string; scope?: unknown; transferId?: string | undefined },
): Promise<{ ok: true; file: unknown } | { ok: false; error: string }> {
  return {
    ok: false,
    error: 'на планшете нет файловой системы — вложение к вопросу грузится из галереи (канал files:uploadBlob)',
  };
}

/**
 * Карточка файла по id — тот же контракт, что на десктопе.
 *
 * Сервер проверяет доступ тем же запросом (403, если читать нельзя), поэтому
 * вызов годится как гейт отправителя: переслать можно только то, к чему у
 * отправителя есть доступ.
 */
export async function filesMeta(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fileId: string },
): Promise<{ ok: true; file: FileRef } | { ok: false; error: string }> {
  const fileId = String(args?.fileId || '').trim();
  if (!fileId) return { ok: false, error: 'fileId is empty' };
  const res = await httpAuthed(db, apiBaseUrl, `/files/${encodeURIComponent(fileId)}/meta`, { method: 'GET' });
  if (!res.ok) return { ok: false, error: `meta ${httpFailureLine(res)}` };
  if (!res.json?.ok || !res.json?.file) return { ok: false, error: 'bad meta response' };
  return { ok: true, file: res.json.file as FileRef };
}
