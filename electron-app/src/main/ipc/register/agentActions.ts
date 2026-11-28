// Каналы действий агента для окна программы.
//
// Действие агента живёт в main, а окно «Добавить двигатели списком» — в renderer.
// Пачка номеров лежит в main (см. `agentTools/preparedAdd.ts`), и окно забирает её
// при открытии: `take` — забрать и забыть, `peek` — посмотреть, не забирая.
//
// Права на этом канале нет: забрать пачку может оператор своей машины, а сама пачка
// прошла гейт инструмента (право + раздел) ДО того, как её положили.

import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { peekPreparedAdd, takePreparedAdd } from '../../services/localMiniMax/agentTools/preparedAdd.js';

export function registerAgentActionsIpc(_ctx: IpcContext) {
  /** Пачка подготовленных номеров (пусто — ждать нечего). */
  ipcMain.handle(
    'agentActions:preparedAdd',
    async (_e, args?: { programId?: string | null; take?: boolean }) => {
      const programId = args?.programId ?? null;
      const batch = args?.take ? takePreparedAdd(programId) : peekPreparedAdd(programId);
      return { ok: true as const, batch };
    },
  );
}
