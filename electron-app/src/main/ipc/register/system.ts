import { app, ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode } from '../ipcContext.js';
import {
  checkClockSkew,
  getClockSkewState,
  openDateTimeSettings,
  syncSystemClock,
} from '../../services/clockSkewService.js';

/**
 * Системные действия клиента: часы и перезапуск программы.
 *
 * Кнопка «Перезапустить программу» — для оператора: программа живёт в трее и
 * сама не выгружается, а после правок или зависания перезапуск нужен без
 * перезагрузки компьютера. Гасимся штатно (движок Ииваныча, синк, трей) и
 * поднимаемся заново; если гашение зависло — выходим принудительно, рестарт
 * всё равно состоится.
 */
export function registerSystemIpc(ctx: IpcContext) {
  ipcMain.handle('system:clockStatus', async () => {
    return { ok: true as const, ...getClockSkewState() };
  });

  ipcMain.handle('system:clockCheck', async () => {
    return { ok: true as const, ...(await checkClockSkew(ctx.mgr.getApiBaseUrl())) };
  });

  ipcMain.handle('system:clockSync', async () => {
    const res = await syncSystemClock();
    if (res.ok) {
      // Сразу перепроверяем: после синхронизации время должно встать на место.
      const state = await checkClockSkew(ctx.mgr.getApiBaseUrl());
      return { ok: true as const, ...state };
    }
    return { ok: false as const, error: res.error ?? 'не удалось синхронизировать время' };
  });

  ipcMain.handle('system:openDateTimeSettings', async () => {
    return openDateTimeSettings();
  });

  ipcMain.handle('system:restart', async () => {
    if (isViewMode(ctx)) {
      // В режиме просмотра бэкапа перезапуск не нужен и может мешать чтению.
      return { ok: false as const, error: 'в режиме просмотра бэкапа перезапуск недоступен' };
    }
    // Гашение делает before-quit: гасит движок Ииваныча, пинает последний
    // синк (с потолком 8 с) и снимает трей. Страховка на случай, если он завис.
    app.relaunch();
    setTimeout(() => {
      app.exit(0);
    }, 12_000);
    app.quit();
    return { ok: true as const };
  });
}
