import { ipcMain, app } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { rememberIssuedPath } from '../pathOriginRegistry.js';

import { filesDownloadDirGet } from '../../services/fileService.js';
import { captureScan, discardScan, placeScan } from '../../services/scannerService.js';

// Сканер документов (промт КАРМАНА #148).
//
// Каналы в main: WIA — это COM-объект Windows, в renderer его нет, и по правилам
// проекта нативные возможности живут в main-процессе.
//
// Три канала — по трём шагам сценария:
//   * `scan:document` — снять документ (кадр во временной папке, имя предложено);
//   * `scan:place`    — положить кадр в папку объекта под именем оператора;
//   * `scan:discard`  — убрать кадр, который оператор не стал прикладывать.
//
// Право — то же, что у загрузки файла (`files.upload`): скан это вложение, и
// обойти право на загрузку через новый канал нельзя. Право на просмотр файлов
// (`files.view`) проверяется отдельно, когда карточка тянет карточку файла.
//
// Отказ называет причину: «сканер не найден», «не смог снять документ» —
// оператор должен понимать, что делать, а не гадать, «прав не хватает или прибор».
export function registerScannerIpc(ctx: IpcContext) {
  ipcMain.handle('scan:document', async (_e, args: { label?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'files.upload');
    if (!gate.ok) return gate;

    const label = String(args?.label ?? '').trim() || 'Карточка';
    const result = await captureScan({ label });
    if (!result.ok) return { ok: false as const, error: result.error };

    // Кадр пока во временной папке — он ещё не вложение. Право на загрузку
    // проверяется здесь же, чтобы скан нельзя было снять «в обход» и потом
    // положить в объект под чужой подписью.
    return { ok: true as const, path: result.path, fileName: result.fileName };
  });

  ipcMain.handle('scan:place', async (_e, args: { path: string; fileName: string; label?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'files.upload');
    if (!gate.ok) return gate;

    const source = String(args?.path ?? '').trim();
    if (!source) return { ok: false as const, error: 'скан не получен' };

    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;

    const label = String(args?.label ?? '').trim() || 'Карточка';
    const result = await placeScan({
      path: source,
      fileName: String(args?.fileName ?? '').trim(),
      label,
      downloadDir: dir.path,
    });
    if (!result.ok) return { ok: false as const, error: result.error };

    // Путь выдал main — гейт путей (`files:upload`) пропустит этот файл: он лежит
    // в папке объекта, который собрал сам main, а не пришёл из renderer.
    rememberIssuedPath(result.path);
    return { ok: true as const, path: result.path, fileName: result.fileName };
  });

  ipcMain.handle('scan:discard', async (_e, args: { path: string }) => {
    const source = String(args?.path ?? '').trim();
    if (!source) return { ok: true as const };
    const result = await discardScan({ path: source });
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const };
  });
}
