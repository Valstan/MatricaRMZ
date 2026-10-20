import { ipcMain } from 'electron';
import { eq } from 'drizzle-orm';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { erpEngineCards } from '../../database/schema.js';
import { saveEngineCardGated } from '../../services/engineCardWrite.js';
import { strictRowToSnake } from '../../services/engineCardsReplica.js';

type Err = { ok: false; error: string };

/**
 * Карточки двигателей — строгая реплика (план engine-cards-strict-2026-10, E3a).
 * Чтение — локальная реплика (офлайн работает), EAV-фолбэк решает renderer.
 * Запись — E3b (реплика pending + push); до тех пор пишет старый EAV-путь.
 * Гейт — тот же, что у прежнего чтения карточки (`engines.view`); секция
 * «Производство» — префиксом `engines:`.
 */
export function registerEngineCardsIpc(ctx: IpcContext) {
  ipcMain.handle('engines:card:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'engines.view');
    if (!gate.ok) return gate as Err;
    try {
      const rows = await ctx
        .dataDb()
        .select()
        .from(erpEngineCards)
        .where(eq(erpEngineCards.id, String(id ?? '')))
        .limit(1);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row || row.deletedAt != null) return { ok: true as const, row: null };
      return {
        ok: true as const,
        row: {
          id: String(row.id),
          ...strictRowToSnake(row as unknown as Parameters<typeof strictRowToSnake>[0]),
          updated_at: Number(row.updatedAt ?? 0),
          sync_status: String((row as { syncStatus?: unknown }).syncStatus ?? 'synced'),
        },
      };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  /**
   * Запись карточки (E3b): клиентские гейты дублей + локальная реплика pending.
   * Уход в push забирает collectPending; подтверждение — pull'ом. Гейты читают
   * локальные EAV (с лагом pull'а после E3b) — гонки ловит серверная pre-sign
   * партиция, отбитая строка гасится в error и показывается баннером.
   */
  ipcMain.handle('engines:card:save', async (_e, args: { id: string; fields: Record<string, unknown> }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate as Err;
    const stageWritePerms = await ctx.currentPermissions();
    return saveEngineCardGated(
      {
        db: ctx.dataDb(),
        actor: (await ctx.currentActor()) || 'local',
        canWriteStageRow: stageWritePerms['work_sheets.edit'] === true || stageWritePerms['operations.edit'] === true,
      },
      String(args?.id ?? ''),
      (args?.fields ?? {}) as Record<string, unknown>,
    );
  });
}
