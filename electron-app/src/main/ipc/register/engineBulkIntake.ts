import { ipcMain } from 'electron';

import {
  ENGINE_INVENTORY_STAGE,
  type EngineBulkIntakeApplyInput,
  type RepairChecklistPayload,
} from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import {
  applyEngineBulkIntake,
  previewEngineBulkIntake,
  type IncomingOtkWriteResult,
} from '../../services/engineBulkIntakeService.js';
import {
  getRepairChecklistForEngine,
  listRepairChecklistTemplates,
  saveRepairChecklistForEngine,
} from '../../services/checklistService.js';
import { ensureRepairStageRow, loadRepairStageTemplates } from '../../services/repairStageService.js';

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

  /**
   * «Входной контроль ОТК» — дата прихода, акт комплектности и этап одним действием
   * (владелец 21.10.2026). Идём штатным путём актов: у листа появляются версия и
   * снимок подписи, а этап `incoming_otk` встаёт тем же следствием, что в карточке.
   * Строки списка деталей не пишем — их досеет панель по марке, когда акт откроют.
   */
  const writeIncomingOtk = async (
    engineId: string,
    dateMs: number,
    perms: Record<string, boolean>,
  ): Promise<IncomingOtkWriteResult> => {
    if (perms['operations.edit'] !== true) {
      return { ok: false, error: 'Нет права на операции — акт комплектности не создан.' };
    }
    const db = ctx.dataDb();
    const actor = (await ctx.currentActor()) || 'local';
    const leaf = await getRepairChecklistForEngine(db, engineId, ENGINE_INVENTORY_STAGE);
    if (!leaf.ok) return { ok: false, error: leaf.error };

    const current = (leaf.payload?.answers as Record<string, any> | undefined)?.completeness_inspection_date;
    const currentMs =
      current?.kind === 'date' && Number.isFinite(Number(current.value)) && Number(current.value) > 0
        ? Number(current.value)
        : null;
    // Чужую дату не перезаписываем: там могла быть ручная правка, которой оператор пачки не видел.
    if (currentMs !== null && currentMs !== dateMs) return { ok: true, applied: false, conflict: true };

    let payload = leaf.payload;
    if (!payload) {
      const t = await listRepairChecklistTemplates(db, ENGINE_INVENTORY_STAGE);
      if (!t.ok) return { ok: false, error: t.error };
      const tmpl = t.templates.find((x) => x.active) ?? t.templates[0] ?? null;
      if (!tmpl) return { ok: false, error: 'Шаблон акта комплектности не найден.' };
      payload = {
        kind: 'repair_checklist',
        templateId: tmpl.id,
        templateVersion: tmpl.version,
        stage: ENGINE_INVENTORY_STAGE,
        engineEntityId: engineId,
        filledBy: actor,
        filledAt: Date.now(),
        answers: {},
      } satisfies RepairChecklistPayload;
    }

    // Дата уже стоит та же — акт не трогаем вовсе (второй заход тем же списком не шумит).
    if (currentMs === dateMs) return { ok: true, applied: false, conflict: false };

    const patched: RepairChecklistPayload = {
      ...payload,
      answers: {
        ...(payload.answers as Record<string, unknown>),
        completeness_inspection_date: { kind: 'date', value: dateMs },
      } as RepairChecklistPayload['answers'],
    };
    const saved = await saveRepairChecklistForEngine(db, {
      engineId,
      stage: ENGINE_INVENTORY_STAGE,
      ...(leaf.operationId ? { operationId: leaf.operationId } : {}),
      payload: patched,
      actor,
    });
    if (!saved.ok) return { ok: false, error: saved.error };

    // Этап — не причина терять сохранённый акт, но и молчать о его отказе нельзя:
    // итог пачки обязан сказать «акт лёг, а этап не встал», иначе оператор считает,
    // что след работы есть, а в истории ремонта его нет (смоук 21.10.2026).
    let stageMissed = false;
    let stageError = '';
    try {
      const { templates } = await loadRepairStageTemplates(ctx.sysDb, ctx.mgr.getApiBaseUrl());
      const marked = await ensureRepairStageRow(db, engineId, 'incoming_otk', dateMs, actor, templates);
      if (!marked.ok) {
        stageMissed = true;
        stageError = marked.error;
      }
    } catch (e) {
      stageMissed = true;
      stageError = String(e);
    }
    return { ok: true, applied: true, conflict: false, ...(stageMissed ? { stageMissed: true, ...(stageError ? { stageError } : {}) } : {}) };
  };

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
          writeIncomingOtk: (engineId, dateMs) => writeIncomingOtk(engineId, dateMs, perms),
        },
        args,
      );
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
