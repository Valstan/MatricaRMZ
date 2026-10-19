import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { sanitizeExportFileName, type ListExportFormat, type ListExportSpec } from '@matricarmz/shared';

import { buildListDocument, buildListWorkbook, exportFileExtension } from '../../services/listExportService.js';
import { settingsGetString, settingsSetString } from '../../services/settingsStore.js';
import { SettingsKey } from '../../services/settingsStore.js';
import type { IpcContext } from '../ipcContext.js';

const APP_TITLE = 'Выгрузка списка';

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
async function offerToOpen(target: string): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options = {
    type: 'info' as const,
    title: APP_TITLE,
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
    if (failure !== '') dialog.showErrorBox(APP_TITLE, `Не удалось открыть файл: ${failure}`);
  } else if (picked.response === 1) {
    shell.showItemInFolder(target);
  }
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

      let target: string;
      if (autoDir) {
        mkdirSync(autoDir, { recursive: true });
        target = join(autoDir, baseName + ext);
      } else {
        const dir = await defaultExportDir(ctx);
        const options = {
          title: format === 'xlsx' ? 'Сохранить список в Excel' : 'Сохранить список в Word',
          defaultPath: join(dir, baseName + ext),
          filters: [
            format === 'xlsx'
              ? { name: 'Книга Excel', extensions: ['xlsx'] }
              : { name: 'Документ Word', extensions: ['docx'] },
          ],
        };
        const parent = BrowserWindow.getFocusedWindow();
        const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        if (picked.canceled || !picked.filePath) return { ok: false as const, error: 'cancelled', cancelled: true as const };
        target = picked.filePath;
        await settingsSetString(ctx.sysDb, SettingsKey.ExportsDir, dirname(target));
      }

      // Файл собирается после выбора пути: отменённый диалог не должен стоить минуты сборки.
      const buffer = format === 'xlsx' ? await buildListWorkbook(spec) : await buildListDocument(spec);
      writeFileSync(target, buffer);
      ctx.logToFile(`[exports] ${format} → ${basename(target)} (${spec.rows.length} строк)`);
      if (!autoDir) await offerToOpen(target);
      return { ok: true as const, path: target, name: basename(target) };
    } catch (e) {
      const message = String(e);
      ctx.logToFile(`[exports] ошибка: ${message}`);
      // Ошибку показываем нативным окном: кнопка выгрузки может уехать в меню переполнения,
      // и подпись в списке оператор просто не увидит.
      if (!autoDir) dialog.showErrorBox(APP_TITLE, `Не удалось выгрузить список.\n\n${message}`);
      return { ok: false as const, error: message };
    }
  });
}
