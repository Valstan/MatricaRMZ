import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { sanitizeExportFileName, type CardExportSpec, type ListExportFormat, type ListExportSpec } from '@matricarmz/shared';

import { buildCardDocument } from '../../services/cardExportService.js';
import { buildListDocument, buildListWorkbook, exportFileExtension } from '../../services/listExportService.js';
import { settingsGetString, settingsSetString } from '../../services/settingsStore.js';
import { SettingsKey } from '../../services/settingsStore.js';
import type { IpcContext } from '../ipcContext.js';

const APP_TITLE = 'Выгрузка списка';
const CARD_TITLE = 'Выгрузка карточки';

/**
 * Смоук-шов: «Сохранить как» — нативное окно, из CDP его не нажать. Когда переменная задана,
 * файл пишется прямо в неё и ни одного нативного окна не показывается (ни выбора пути, ни
 * предложения открыть файл, ни сообщения об ошибке) — этим живёт проверка выгрузки на стенде.
 * В обычной работе переменной нет, и путь выбирает оператор.
 */
function autoSaveDir(): string | null {
  const dir = String(process.env.MATRICA_EXPORT_AUTOSAVE_DIR ?? '').trim();
  return dir === '' ? null : dir;
}

/** Папка по умолчанию: последняя выгрузка, иначе «Документы». Запомненной папки может уже
 * не быть (флешка, сетевой диск) — тогда молча возвращаемся к «Документам». */
async function defaultExportDir(ctx: IpcContext): Promise<string> {
  const documents = app.getPath('documents');
  const stored = await settingsGetString(ctx.sysDb, SettingsKey.ExportsDir);
  const dir = String(stored ?? '').trim();
  return dir !== '' && existsSync(dir) ? dir : documents;
}

/** Файл сохранён — предлагаем сразу его открыть: чаще всего оператор выгружает, чтобы посмотреть
 * или посчитать в Excel, и это один клик вместо поиска файла в папке. */
async function offerToOpen(target: string, title: string): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options = {
    type: 'info' as const,
    title,
    message: `Файл сохранён: ${basename(target)}`,
    detail: dirname(target),
    buttons: ['Открыть', 'Показать в папке', 'Готово'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const picked = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (picked.response === 0) {
    const failure = await shell.openPath(target);
    if (failure !== '') dialog.showErrorBox(title, `Не удалось открыть файл: ${failure}`);
  } else if (picked.response === 1) {
    shell.showItemInFolder(target);
  }
}

type SaveResult = { ok: true; path: string; name: string } | { ok: false; error: string; cancelled?: true };

/**
 * Общий путь сохранения выгрузки: папка (память оператора или «Документы»), необязательный
 * выбор пути, сборка файла после выбора и нативное предложение открыть. Сборка идёт **после**
 * диалога: отменённый «Сохранить как» не должен стоить времени сборки.
 */
async function saveExportFile(args: {
  ctx: IpcContext;
  autoDir: string | null;
  dialogTitle: string;
  baseName: string;
  ext: string;
  filterName: string;
  build: () => Promise<Buffer>;
}): Promise<SaveResult> {
  const { ctx, autoDir, dialogTitle, baseName, ext, filterName, build } = args;
  let target: string;
  if (autoDir) {
    mkdirSync(autoDir, { recursive: true });
    target = join(autoDir, baseName + ext);
  } else {
    const dir = await defaultExportDir(ctx);
    const options = {
      title: dialogTitle,
      defaultPath: join(dir, baseName + ext),
      filters: [{ name: filterName, extensions: [ext.replace(/^\./, '')] }],
    };
    const parent = BrowserWindow.getFocusedWindow();
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled', cancelled: true };
    target = picked.filePath;
    await settingsSetString(ctx.sysDb, SettingsKey.ExportsDir, dirname(target));
  }

  const buffer = await build();
  writeFileSync(target, buffer);
  if (!autoDir) await offerToOpen(target, dialogTitle);
  return { ok: true, path: target, name: basename(target) };
}

export function registerExportsIpc(ctx: IpcContext) {
  ipcMain.handle('exports:list', async (_e, args: { format: ListExportFormat; spec: ListExportSpec }) => {
    const autoDir = autoSaveDir();
    try {
      const format: ListExportFormat = args?.format === 'docx' ? 'docx' : 'xlsx';
      const spec = args?.spec;
      if (!spec || !Array.isArray(spec.columns) || !Array.isArray(spec.rows) || spec.columns.length === 0) {
        throw new Error('в списке нет колонок — выгружать нечего');
      }

      const ext = exportFileExtension(format);
      const baseName = sanitizeExportFileName(spec.fileBaseName || spec.title);
      const result = await saveExportFile({
        ctx,
        autoDir,
        dialogTitle: format === 'xlsx' ? 'Сохранить список в Excel' : 'Сохранить список в Word',
        baseName,
        ext,
        filterName: format === 'xlsx' ? 'Книга Excel' : 'Документ Word',
        build: () => (format === 'xlsx' ? buildListWorkbook(spec) : buildListDocument(spec)),
      });
      if (result.ok) ctx.logToFile(`[exports] ${format} → ${result.name} (${spec.rows.length} строк)`);
      return result;
    } catch (e) {
      const message = String(e);
      ctx.logToFile(`[exports] ошибка: ${message}`);
      // Ошибку показываем нативным окном: кнопка выгрузки может уехать в меню переполнения,
      // и подпись в списке оператор просто не увидит.
      if (!autoDir) dialog.showErrorBox(APP_TITLE, `Не удалось выгрузить список.\n\n${message}`);
      return { ok: false as const, error: message };
    }
  });

  ipcMain.handle('exports:card', async (_e, args: CardExportSpec) => {
    const autoDir = autoSaveDir();
    try {
      const spec = args;
      if (!spec || !Array.isArray(spec.sections) || spec.sections.length === 0) {
        throw new Error('у формы нет ни одной секции — выгружать нечего');
      }

      const baseName = sanitizeExportFileName(spec.fileBaseName || spec.title || 'Форма');
      const result = await saveExportFile({
        ctx,
        autoDir,
        dialogTitle: 'Сохранить форму в Word',
        baseName,
        ext: '.docx',
        filterName: 'Документ Word',
        build: () => buildCardDocument(spec),
      });
      if (result.ok) ctx.logToFile(`[exports] card → ${result.name} (${spec.sections.length} секций)`);
      return result;
    } catch (e) {
      const message = String(e);
      ctx.logToFile(`[exports] ошибка карточки: ${message}`);
      if (!autoDir) dialog.showErrorBox(CARD_TITLE, `Не удалось выгрузить форму.\n\n${message}`);
      return { ok: false as const, error: message };
    }
  });
}
