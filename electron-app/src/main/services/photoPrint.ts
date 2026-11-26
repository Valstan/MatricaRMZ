// ПЕЧАТЬ КАРТИНОК — общий модуль программы (промт КАРМАНА #159).
//
// Что это: печать фотографий нужна в трёх местах — карточка двигателя (вложения),
// панель вложений и выдача «Поиска по файлам». Раньше реализаций было две
// (`photosPrint` — серверные вложения, `photosPrintLocalPaths` — локальные файлы
// оператора), и они разъехались: правка одной не доезжала до другой.
// Теперь реализация ОДНА — здесь. Источники путей остаются своими (серверные id
// против локальных путей), общий шаг печати — общий.
//
// Два режима печати (оператору — два разных окна, а оператору — два разных
// смысла; поэтому оба, и оба через один шаг):
//
//  - `dialog` — системный диалог печати Chromium: все картинки сразу одним
//    документом, оператор сам выбирает принтер, масштаб и ориентацию;
//  - `os` — СИСТЕМНЫЙ мастер печати фотографий (photowiz): оператор в его окне
//    правит размер и раскладку. Сначала пробуем ОДНО окно на весь набор (глагол
//    «Печать» у множественного выделения — как в Проводнике по Ctrl+P); если
//    оболочка мастер не открывает — по одному окну на файл (это ограничение
//    глагола «Печать» у одного файла).
//
// Проверено на машине (PC79, 26.11.2026, живой прогон):
//  - Chromium-диалог печати на этой машине НЕ РАБОТАЕТ: `webContents.print()`
//    возвращает «Invalid printer settings» при ЛЮБОМ принтере (их тут пять, все
//    в норме, спуллер работает) — и при скрытом, и при видимом окне, и с явным
//    deviceName. Это не «принтер не найден», это «печатающий модуль Chromium не
//    смог собрать настройки печати» — потому отказ и разбираем по-разному;
//  - системный мастер печати фотографий (глагол «Печать» у ОДНОГО файла)
//    РАБОТАЕТ: окно «Печать изображений» открывается;
//  - глагол «Печать» у множественного выделения мастер не открывает (окно не
//    появляется) — поэтому это запасной путь, а не основной.
//
// Поэтому: если Chromium-диалог не сработал именно так — печать не теряется,
// а уходит в системный мастер, и оператор видит, почему (в сообщении).

import { BrowserWindow } from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { printImagesViaOsWizard } from './localImagePrint.js';
import { openPhotoPrintWizard } from './photoPrintWizard.js';

/** Режим печати картинок. */
export type PhotoPrintMode = 'dialog' | 'os';

/** Почему печать не вышла — разбирают оператор и журнал. */
export type PhotoPrintFailureReason =
  | 'no-files'
  | 'no-printers'
  | 'cancelled'
  | 'dialog-unavailable'
  | 'wizard-unavailable'
  | 'failed';

export type PhotoPrintResult =
  | { ok: true; via: 'dialog' | 'os-wizard'; images: number; skipped: string[]; note?: string }
  | { ok: false; error: string; reason: PhotoPrintFailureReason };

/** Тип файла по расширению — чтобы печатать картинками только картинки. */
export function mimeForPath(localPath: string): string {
  const ext = (localPath.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/jpeg';
}

/**
 * Расширения, которые Chromium напечатает КАРТИНКОЙ.
 *
 * ⚠️ `mimeForPath` для незнакомого расширения отдаёт `image/jpeg` — по нему
 * нельзя отличать картинку от PDF или Word: ими «картинками» печатались пустые
 * листы, а задуманный список файлов первой страницей не срабатывал никогда.
 * Для печати отдельный список: всё, чего в нём нет, перечисляется списком.
 */
const PRINTABLE_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'svg',
]);

/** Напечатается ли файл картинкой (а не пойдёт списком на первой странице). */
export function isPrintableImage(localPath: string): boolean {
  const ext = (String(localPath ?? '').split('.').pop() || '').toLowerCase();
  return PRINTABLE_IMAGE_EXTENSIONS.has(ext);
}

/**
 * Экранирование для печатного HTML (в main).
 *
 * Известная копия общего `escapeHtml` — см. реестр `docs/GLOBAL_MODULES.md`.
 * Апостроф здесь НЕ экранируется (как и было): в атрибутах он не нужен.
 */
export function escapeHtmlMain(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Печатный HTML: картинка на страницу + (необязательно) список файлов первой страницей. */
export function buildPhotosHtml(imgPaths: string[], opts?: { listHtml?: string; skippedNames?: string[] }): string {
  const listPage = opts?.listHtml
    ? `<div class="page page-list"><h2>Файлы</h2>${opts.listHtml}${
        opts.skippedNames && opts.skippedNames.length > 0
          ? `<p class="muted">Не печатаются как изображение (открывайте из своего приложения): ${opts.skippedNames.map(escapeHtmlMain).join(', ')}</p>`
          : ''
      }</div>`
    : opts?.skippedNames && opts.skippedNames.length > 0
      ? `<div class="page page-list"><p class="muted">Эти файлы не печатаются как изображение (открывайте из своего приложения): ${opts.skippedNames.map(escapeHtmlMain).join(', ')}</p></div>`
      : '';
  const pages = imgPaths
    .map((p) => `<div class="page"><img src="${pathToFileURL(p).href}" /></div>`)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 10mm; }
html, body { margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; }
.page { width: 190mm; height: 277mm; display: flex; align-items: center; justify-content: center; page-break-after: always; }
.page-list { display: block; height: auto; min-height: 0; font-size: 13px; }
.page-list h2 { font-size: 16px; margin: 0 0 8px; }
.page-list ul { margin: 0; padding-left: 18px; }
.page-list li { margin: 2px 0; }
.muted { color: #64748b; }
.page:last-child { page-break-after: auto; }
img { max-width: 100%; max-height: 100%; object-fit: contain; }
</style></head><body>${listPage}${pages}</body></html>`;
}

/**
 * Окно печати фотографий.
 *
 * ⚠️ Печать из offscreen-окна падает «Invalid printer settings» (Chromium не
 * умеет print из offscreen-рендера). Для печати окно скрытое, но НЕ offscreen;
 * offscreen оставлен только пути printToPDF (там он работает и не мигает окном).
 */
export async function renderPhotosWindow(
  imgPaths: string[],
  opts?: { offscreen?: boolean; listHtml?: string; skippedNames?: string[] },
): Promise<BrowserWindow> {
  const dir = await mkdtemp(join(tmpdir(), 'matrica-photos-'));
  const htmlPath = join(dir, 'photos.html');
  const buildOpts: { listHtml?: string; skippedNames?: string[] } = {};
  if (opts?.listHtml) buildOpts.listHtml = opts.listHtml;
  if (opts?.skippedNames) buildOpts.skippedNames = opts.skippedNames;
  await writeFile(htmlPath, buildPhotosHtml(imgPaths, buildOpts), 'utf8');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: opts?.offscreen !== false },
  });
  await win.loadFile(htmlPath);
  return win;
}

/** Разделить пути: что печатаем картинкой, что перечисляем списком. */
export function splitPrintTargets(paths: string[]): { images: string[]; skipped: string[] } {
  const images: string[] = [];
  const skipped: string[] = [];
  for (const raw of paths) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    if (isPrintableImage(p)) images.push(p);
    else skipped.push(basename(p));
  }
  return { images, skipped };
}

/**
 * Как читать отказ печати Chromium.
 *
 * Три разные причины — и три разных ответа оператору:
 *  - отменил сам → это не поломка, печать просто не состоялась;
 *  - «Invalid printer settings» → печатающий модуль Chromium не собрал
 *    настройки печати (на PC79 так со всеми принтерами, 26.11.2026): печать
 *    уводим в системный мастер, а не теряем;
 *  - прочее → называем как есть.
 */
export function describePrintFailure(reason: string): {
  kind: 'cancelled' | 'dialog-unavailable' | 'failed';
  message: string;
} {
  const text = String(reason ?? '').trim();
  if (/cancel/i.test(text)) return { kind: 'cancelled', message: 'Печать отменена' };
  if (/invalid printer settings/i.test(text)) {
    return {
      kind: 'dialog-unavailable',
      message:
        'Системный диалог печати на этой машине не работает: система не смогла подготовить настройки печати (Invalid printer settings)',
    };
  }
  return { kind: 'failed', message: `Диалог печати не сработал: ${text || 'причина неизвестна'}` };
}

/**
 * Принтеры, которые видит система.
 *
 * `null` — узнать не удалось (тогда печать не запрещаем: молчаливый запрет
 * хуже лишней попытки). Пустой массив — принтеров в системе нет: тогда
 * оператору говорим причину, а не «Отправлено на печать».
 */
export async function readSystemPrinters(): Promise<string[] | null> {
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({ show: false });
    if (typeof win.webContents.getPrintersAsync !== 'function') return null;
    const printers = await win.webContents.getPrintersAsync();
    return printers.map((p) => String(p.displayName || p.name || '').trim()).filter(Boolean);
  } catch {
    return null;
  } finally {
    try {
      win?.destroy();
    } catch {
      /* окно уже мертво — ничего делать не надо */
    }
  }
}

/** Системный мастер печати фотографий (photowiz) на наборе файлов. */
async function printViaSystemWizard(images: string[]): Promise<PhotoPrintResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason: 'wizard-unavailable',
      error: 'Системный мастер печати фотографий — только на Windows',
    };
  }
  if (images.length === 0) return { ok: false, reason: 'no-files', error: 'Нет картинок для печати' };

  // Сначала — ОДНО окно на весь набор (глагол «Печать» у множественного
  // выделения). На PC79 (26.11.2026) оболочка мастер так НЕ открывает, поэтому
  // запасной путь — по одному окну на файл: он работает всегда.
  const folders = new Set(images.map((p) => dirname(p)));
  if (folders.size === 1) {
    const workDir = await mkdtemp(join(tmpdir(), 'matrica-photo-wizard-'));
    const wizard = await openPhotoPrintWizard(images, { workDir });
    if (wizard.ok) return { ok: true, via: 'os-wizard', images: images.length, skipped: [] };
    // Мастер не открылся — по одному окну на файл.
    const perFile = await printImagesViaOsWizard(images);
    if (perFile.ok) {
      return {
        ok: true,
        via: 'os-wizard',
        images: images.length,
        skipped: [],
        note: 'Системный мастер не открыл набор снимков одним окном — открыто по одному окну на снимок.',
      };
    }
    return { ok: false, reason: 'wizard-unavailable', error: `${wizard.error}. ${perFile.error}` };
  }
  const perFile = await printImagesViaOsWizard(images);
  if (perFile.ok) {
    return {
      ok: true,
      via: 'os-wizard',
      images: images.length,
      skipped: [],
      note: 'Снимки лежат в разных папках — открыто по одному окну мастера на снимок.',
    };
  }
  return { ok: false, reason: 'wizard-unavailable', error: perFile.error };
}

/**
 * ОБЩИЙ ШАГ ПЕЧАТИ КАРТИНОК — одна реализация на всех.
 *
 * @param paths     пути к файлам (серверные вложения уже скачаны на диск)
 * @param opts.mode `dialog` — диалог печати Chromium, `os` — системный мастер
 * @param opts.listHtml первая страница со списком файлов (для бланка)
 */
export async function printPhotos(
  paths: string[],
  opts?: { mode?: PhotoPrintMode; listHtml?: string },
): Promise<PhotoPrintResult> {
  const mode: PhotoPrintMode = opts?.mode === 'os' ? 'os' : 'dialog';
  const { images, skipped } = splitPrintTargets(paths);
  const listHtml = opts?.listHtml;
  if (images.length === 0 && !listHtml) {
    return { ok: false, reason: 'no-files', error: 'Нет файлов для печати' };
  }

  // Принтера нет — называем причину, а не рапортуем об успехе.
  const printers = await readSystemPrinters();
  if (printers && printers.length === 0) {
    return {
      ok: false,
      reason: 'no-printers',
      error: 'Принтер не найден: в системе нет ни одного принтера. Установите принтер в Windows и повторите.',
    };
  }

  if (mode === 'os') return printViaSystemWizard(images);

  const buildOpts: { offscreen: boolean; listHtml?: string; skippedNames?: string[] } = { offscreen: false };
  if (listHtml) buildOpts.listHtml = listHtml;
  if (skipped.length > 0) buildOpts.skippedNames = skipped;
  const win = await renderPhotosWindow(images, buildOpts);
  let outcome: { ok: boolean; reason: string };
  try {
    outcome = await new Promise<{ ok: boolean; reason: string }>((resolve) => {
      // Без silent: системный диалог печати — оператор выбирает принтер сам.
      win.webContents.print({ printBackground: true }, (ok, reason) => {
        resolve({ ok: !!ok, reason: String(reason || '') });
      });
    });
  } catch (e) {
    outcome = { ok: false, reason: String(e) };
  } finally {
    win.destroy();
  }

  if (outcome.ok) return { ok: true, via: 'dialog', images: images.length, skipped };

  const failure = describePrintFailure(outcome.reason);
  if (failure.kind === 'dialog-unavailable') {
    // Печать не теряется: уводим её в системный мастер и говорим почему.
    const viaWizard = await printViaSystemWizard(images);
    if (viaWizard.ok) {
      return {
        ok: true,
        via: 'os-wizard',
        images: images.length,
        skipped,
        note: `${failure.message}. Открыт системный мастер печати фотографий — принтер, размер и раскладку выберите в нём.`,
      };
    }
    return viaWizard;
  }
  return {
    ok: false,
    reason: failure.kind === 'cancelled' ? 'cancelled' : 'failed',
    error: failure.message,
  };
}
