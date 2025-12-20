import { autoUpdater } from 'electron-updater';

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string }
  | { ok: false; error: string };

export function initAutoUpdate() {
  // В MVP — базовая настройка. Позже добавим прогресс и окно подтверждения.
  autoUpdater.autoDownload = false;
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


