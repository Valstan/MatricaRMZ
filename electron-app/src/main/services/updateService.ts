import { createRequire } from 'node:module';

// electron-updater — CommonJS пакет. В ESM main-процессе Electron нельзя надежно
// импортировать его named-export'ом, поэтому подключаем через require().
const require = createRequire(import.meta.url);
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
import { dialog } from 'electron';

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string }
  | { ok: false; error: string };

export function initAutoUpdate() {
  // В MVP — базовая настройка. Позже добавим прогресс и окно подтверждения.
  autoUpdater.autoDownload = false;
}

export function wireAutoUpdateDialogs(opts: {
  log: (msg: string) => void;
  getLogPath: () => string;
}) {
  autoUpdater.on('error', (e) => {
    opts.log(`autoUpdater error: ${String(e)}`);
  });

  autoUpdater.on('update-available', async (info) => {
    opts.log(`update-available: ${info?.version ?? 'unknown'}`);
    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'Доступно обновление',
      message: 'Найдена новая версия программы.',
      detail: `Новая версия: ${info?.version ?? ''}\n\nЛог: ${opts.getLogPath()}`,
      buttons: ['Скачать обновление', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (e) {
        opts.log(`downloadUpdate failed: ${String(e)}`);
        await dialog.showMessageBox({
          type: 'error',
          title: 'Ошибка обновления',
          message: 'Не удалось скачать обновление.',
          detail: `${String(e)}\n\nЛог: ${opts.getLogPath()}`,
        });
      }
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    opts.log(`update-downloaded: ${info?.version ?? 'unknown'}`);
    const r = await dialog.showMessageBox({
      type: 'question',
      title: 'Обновление готово',
      message: 'Обновление скачано. Установить сейчас?',
      detail: `Версия: ${info?.version ?? ''}`,
      buttons: ['Установить и перезапустить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  try {
    const r = await autoUpdater.checkForUpdates();
    const info = r?.updateInfo;
    return { ok: true, updateAvailable: !!info, version: info?.version };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function quitAndInstall(): Promise<{ ok: boolean; error?: string }> {
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


