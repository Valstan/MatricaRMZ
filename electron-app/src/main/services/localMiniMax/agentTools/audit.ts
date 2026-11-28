// След действия агента в журнале.
//
// ЗАЧЕМ ОТДЕЛЬНО. Журнал пишется ДО записи в данные (как в `engine:delete`: причина
// удаления пишется до того, как карточка исчезнет). Действие агента — тоже след в
// журнале, и он должен лечь ДО того, как действие что-то изменит.
//
// КТО АКТЁР. Оператор: действие выполняет приложение от имени оператора, с его
// правами и в его аудите (решение владельца по промту КАРМАНА #176). Отдельного
// аккаунта «нейросеть» не заводим — тогда в журнале была бы строка без человека.
//
// `payload.source = 'agent'` — по нему видно, что команду дала нейросеть.

import type { IpcContext } from '../../../ipc/ipcContext.js';
import { addAudit } from '../../auditService.js';

/** Записать след действия агента в журнал. */
export async function auditAgentAction(
  ctx: IpcContext,
  args: { action: string; payload?: Record<string, unknown>; entityId?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await ctx.currentActor();
  return addAudit(ctx.dataDb(), {
    actor,
    action: args.action,
    entityId: args.entityId ?? null,
    tableName: null,
    payload: { ...(args.payload ?? {}), source: 'agent' },
  });
}
