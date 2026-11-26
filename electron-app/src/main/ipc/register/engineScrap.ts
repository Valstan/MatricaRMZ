import { ipcMain } from 'electron';

import { findScrapStageInconsistencies } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { warehouseRepairFundIntake } from '../../services/erpService.js';
import {
  resolveEngineScrap,
  SCRAP_RESOLVE_REASONS,
  type EngineScrapResolveInput,
} from '../../services/engineScrapResolveService.js';

/**
 * Снятие утиля двигателя — действие «Деталь отремонтирована» (промт КАРМАНА #170).
 *
 * Право — как у правки карточки двигателя (`engines.edit`): снятие утиля меняет состояние
 * движка, а не просто пишет строку истории.
 */
export function registerEngineScrapIpc(ctx: IpcContext) {
  ipcMain.handle('engines:scrap:reasons', async () => ({ ok: true as const, reasons: [...SCRAP_RESOLVE_REASONS] }));

  ipcMain.handle('engines:scrap:resolve', async (_e, args?: EngineScrapResolveInput) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    try {
      const actor = await ctx.currentActor();
      return await resolveEngineScrap({
        db: ctx.dataDb(),
        engineId: String(args?.engineId ?? ''),
        input: {
          engineId: String(args?.engineId ?? ''),
          partId: args?.partId ?? null,
          partLabel: args?.partLabel ?? null,
          outcome: args?.outcome ?? 'repaired',
          reason: String(args?.reason ?? ''),
          atMs: args?.atMs ?? null,
        },
        actor,
        // Возврат детали в ремонтный фонд — существующей дверью заноса (он требует сервера).
        repairFundIntake: async (payload) =>
          warehouseRepairFundIntake(ctx.sysDb, ctx.mgr.getApiBaseUrl(), payload),
      });
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  /**
   * Проверка согласованности «утиль ↔ этап ремонта» (промт КАРМАНА #170): перечень
   * двигателей, у которых в текущем заезде есть и этап ремонта, и статус утиль.
   *
   * Читает каталог двигателей и считает по доменному правилу — тем же, что держит гейт
   * записи этапа. Этапы прошлых заездов расхождением не считаются.
   */
  ipcMain.handle('engines:scrap:consistency', async () => {
    const gate = await requirePermOrResult(ctx, 'engines.view');
    if (!gate.ok) return gate;
    try {
      const read = await ctx.engineList.read();
      const rows = findScrapStageInconsistencies(
        read.rows.map((row) => ({
          id: row.id,
          engineNumber: row.engineNumber,
          isScrap: row.isScrap,
          statusDates: row.statusDates,
          stageEntries: row.stageEntries,
        })),
      );
      return { ok: true as const, rows };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
