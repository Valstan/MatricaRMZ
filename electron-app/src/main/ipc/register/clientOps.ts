import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';

import {
  getClientOpsBundle,
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
  // Инструкция для системного администратора: открывается по кнопке в справочном окне.
  // Автопоказа при старте программы больше нет (решение владельца 19.11.2026) — вместе с ним
  // снята и метка «свежая установка», которой он управлялся.
  ipcMain.handle('clientOps:adminInstruction', async () => readAdminInstruction());
}
