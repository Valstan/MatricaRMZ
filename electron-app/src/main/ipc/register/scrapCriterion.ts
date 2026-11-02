import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';
import {
  countEnginesAffectedByCriterion,
  getScrapCriterionState,
  loadScrapCriterionIndex,
  resolveCriterionParts,
  seedScrapCriterionParts,
  setScrapCriterionFlag,
} from '../../services/scrapCriterionService.js';

/**
 * Признак «деталь уводит двигатель в утиль» (метка на карточке детали).
 *
 * Здесь только чтение: список помеченных деталей и сухой прогон — сколько
 * двигателей получат признак утиля, если деталь включить в набор. Саму метку
 * ставит карточка детали через общую дверь атрибутов (`admin.entities.setAttr`),
 * поэтому правило прав и синхронизации у неё одна на все атрибуты.
 */
export function registerScrapCriterionIpc(ctx: IpcContext) {
  ipcMain.handle('scrap:criterion:list', async (_e) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const index = await loadScrapCriterionIndex(ctx.dataDb());
    return { ok: true as const, parts: index.parts };
  });

  ipcMain.handle('scrap:criterion:impact', async (_e, args?: { partIds?: string[] }) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const partIds = Array.isArray(args?.partIds) ? args.partIds : [];
    const parts = await resolveCriterionParts(ctx.dataDb(), partIds);
    const impact = await countEnginesAffectedByCriterion(ctx.dataDb(), parts);
    return { ok: true as const, parts, ...impact };
  });

  ipcMain.handle('scrap:criterion:get', async (_e, args?: { partId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const partId = String(args?.partId ?? '').trim();
    if (!partId) return { ok: false as const, error: 'Деталь не указана' };
    return getScrapCriterionState(ctx.dataDb(), partId);
  });

  ipcMain.handle('scrap:criterion:seed', async () => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    const seeded = await seedScrapCriterionParts(ctx.dataDb());
    if (!seeded.ok) return seeded;
    return { ok: true as const, parts: seeded.parts, ...(seeded.skipped ? { skipped: seeded.skipped } : {}) };
  });

  ipcMain.handle('scrap:criterion:set', async (_e, args?: { partId?: string; enabled?: boolean }) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    const partId = String(args?.partId ?? '').trim();
    if (!partId) return { ok: false as const, error: 'Деталь не указана' };
    const written = await setScrapCriterionFlag(ctx.dataDb(), partId, args?.enabled !== false);
    if (!written.ok) return written;
    const impact = await countEnginesAffectedByCriterion(ctx.dataDb(), written.parts);
    return { ok: true as const, parts: written.parts, ...impact };
  });
}
