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
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

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
