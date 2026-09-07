import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';

import { getClientOpsBundle, revealClientOpsBundle, saveClientOpsBundleCopy } from '../../services/clientOpsService.js';

/**
 * Скрипты обслуживания машины парка. Доступны ЛЮБОМУ вошедшему: настройка антивируса и
 * правило брандмауэра — работа на своей машине, а не привилегия. Гейта по правам здесь нет
 * намеренно: он оставил бы половину парка без того, ради чего скрипты и писались.
 */
export function registerClientOpsIpc(_ctx: IpcContext) {
  ipcMain.handle('clientOps:bundle', async () => getClientOpsBundle());
  ipcMain.handle('clientOps:reveal', async () => revealClientOpsBundle());
  ipcMain.handle('clientOps:saveCopy', async () => saveClientOpsBundleCopy());
}
