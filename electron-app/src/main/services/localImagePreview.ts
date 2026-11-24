// Превью локальной картинки для модуля «Поиск по файлам» (промт КАРМАНА #88).
//
// Renderer не читает диск — превью приходит из главного процесса как data-URL
// (прецедент — `filesOriginalGet`, `fileService.ts:772`). Так страница не
// становится мостом «прочитай любой файл с диска» (сторож
// `FileSearchPage.guard.test.ts`).
//
// Превью — КРУПНОЕ: владельцу нужно разглядеть, что изображено на фото
// двигателя. Поэтому картинка ужимается до большой стороны (не до иконки),
// как и просил промт: «крупные превьюшки, такие, чтобы можно было разглядеть».
//
// Формат: PNG/JPEG читает `nativeImage` самого Electron — без новых зависимостей
// (sharp живёт только в бэкенде). Остальные форматы (webp, gif, bmp) отдаём
// как есть: браузер их рисует сам.

import { readFile, stat } from 'node:fs/promises';

import { nativeImage } from 'electron';

/** Большая сторона превью: хватает, чтобы разглядеть фото двигателя. */
export const PREVIEW_MAX_SIDE = 1600;
/** Потолок на файл: гигабайтная фотография — не наш случай. */
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function mimeForImagePath(path: string): string {
  const dot = String(path ?? '').toLowerCase().lastIndexOf('.');
  const ext = dot < 0 ? '' : String(path ?? '').toLowerCase().slice(dot + 1);
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Превью картинки как data-URL.
 *
 * Файл недоступен или слишком большой — честная ошибка оператору, а не пустая
 * картинка в списке.
 */
export async function readLocalImagePreview(
  path: string,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  const clean = String(path ?? '').trim();
  if (!clean) return { ok: false, error: 'Не указан файл' };
  try {
    const st = await stat(clean);
    if (!st.isFile()) return { ok: false, error: 'Это не файл' };
    if (st.size > MAX_PREVIEW_BYTES) {
      return { ok: false, error: `Файл слишком большой (${Math.round(st.size / (1024 * 1024))} МБ)` };
    }
  } catch {
    return { ok: false, error: 'Файл недоступен — выберите папку заново' };
  }

  // PNG/JPEG: Electron сам умеет декодировать и ужимать.
  try {
    const image = nativeImage.createFromPath(clean);
    if (!image.isEmpty()) {
      const size = image.getSize();
      const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(size.width, size.height));
      const resized = scale < 1 ? image.resize({ width: Math.round(size.width * scale) }) : image;
      const buffer = resized.toJPEG(88);
      return { ok: true, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
    }
  } catch {
    // Формат не читается Electron'ом — отдаём как есть (см. ниже).
  }

  try {
    const buffer = await readFile(clean);
    return { ok: true, dataUrl: `data:${mimeForImagePath(clean)};base64,${buffer.toString('base64')}` };
  } catch (e) {
    return { ok: false, error: `Файл недоступен: ${String(e)}` };
  }
}
