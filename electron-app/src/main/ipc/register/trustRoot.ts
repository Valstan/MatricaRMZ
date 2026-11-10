import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';

import {
  getTrustRootNotice,
  getTrustRootStatus,
  installTrustRootToMachineStore,
  installTrustRootToUserStore,
  writeTrustRootNoticeShownAt,
} from '../../services/trustRootService.js';

/**
 * Корень доверия Матрицы: подпись программы и «не трогать» со стороны Касперского (ADR-0003).
 *
 * Гейта по правам здесь нет намеренно, как и у скриптов обслуживания: проверка сертификатов
 * и установка в профиль пользователя — работа на своей машине, а не привилегия. Права
 * администратора нужны только машинному хранилища, и там решение остаётся за человеком —
 * клиент лишь запускает скрипт с запросом прав (UAC).
 */
export function registerTrustRootIpc(_ctx: IpcContext) {
  ipcMain.handle('trustRoot:status', async (_e, args: { force?: boolean } = {}) =>
    getTrustRootStatus({ force: Boolean(args?.force) }),
  );
  ipcMain.handle('trustRoot:installUser', async () => installTrustRootToUserStore());
  ipcMain.handle('trustRoot:installMachine', async () => installTrustRootToMachineStore());
  // Подсказку при старте: показывать или нет (решение — в домене, здесь только состояние).
  ipcMain.handle('trustRoot:notice', async () => getTrustRootNotice());
  ipcMain.handle('trustRoot:noticeAck', async () => {
    writeTrustRootNoticeShownAt(Date.now());
    return { ok: true };
  });
}
