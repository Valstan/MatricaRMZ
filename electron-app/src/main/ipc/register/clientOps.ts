import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';

import {
  clearFreshInstallFlag,
  getClientOpsBundle,
  isFreshInstallPending,
  launchClientOps,
  readAdminInstruction,
  revealClientOpsBundle,
  saveClientOpsBundleCopy,
} from '../../services/clientOpsService.js';

/**
 * Скрипты обслуживания машины парка. Доступны ЛЮБОМУ вошедшему: настройка антивируса и
 * правило брандмауэра — работа на своей машине, а не привилегия. Гейта по правам здесь нет
 * намеренно: он оставил бы половину парка без того, ради чего скрипты и писались.
 */
export function registerClientOpsIpc(_ctx: IpcContext) {
  ipcMain.handle('clientOps:bundle', async () => getClientOpsBundle());
  ipcMain.handle('clientOps:launch', async (_e, args: { tab?: string } = {}) => launchClientOps(args));
  ipcMain.handle('clientOps:reveal', async () => revealClientOpsBundle());
  ipcMain.handle('clientOps:saveCopy', async () => saveClientOpsBundleCopy());
  // Инструкция для системного администратора: показывается на свежей установке и по кнопке.
  ipcMain.handle('clientOps:adminInstruction', async () => readAdminInstruction());
  ipcMain.handle('clientOps:freshInstallPending', async () => isFreshInstallPending());
  ipcMain.handle('clientOps:freshInstallAck', async () => {
    clearFreshInstallFlag();
    return { ok: true };
  });
}
