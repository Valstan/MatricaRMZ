import { ipcMain } from 'electron';

import type { EngineBulkIntakeApplyInput } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { applyEngineBulkIntake, previewEngineBulkIntake } from '../../services/engineBulkIntakeService.js';

type Err = { ok: false; error: string };

/**
 * Пакетный приём двигателей списком (накладная). Секция «Двигатели» — те же права,
 * что у карточки: смотреть `engines.view`, заводить `engines.edit`. Гейты дублей
 * не дублируются здесь — их держит `saveEngineCardGated`, общая дверь записи.
 */
export function registerEngineBulkIntakeIpc(ctx: IpcContext) {
  ipcMain.handle('engines:bulkIntake:preview', async (_e, args: { text?: string }) => {
    const gate = await requirePermOrResult(ctx, 'engines.view');
    if (!gate.ok) return gate as Err;
    try {
      return { ok: true as const, preview: await previewEngineBulkIntake(ctx.dataDb(), String(args?.text ?? '')) };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('engines:bulkIntake:apply', async (_e, args: EngineBulkIntakeApplyInput) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate as Err;
    try {
      const perms = await ctx.currentPermissions();
      return await applyEngineBulkIntake(
        {
          db: ctx.dataDb(),
          actor: (await ctx.currentActor()) || 'local',
          canWriteStageRow: perms['work_sheets.edit'] === true || perms['operations.edit'] === true,
        },
        args,
      );
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
