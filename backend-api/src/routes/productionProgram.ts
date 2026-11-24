import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requirePermission } from '../auth/middleware.js';
import {
  createProductionProgram,
  deleteProductionProgram,
  getProductionProgram,
  listProductionPrograms,
  replaceProductionProgramRows,
  setProductionProgramRowOperatorNote,
  updateProductionProgram,
} from '../services/productionProgramService.js';

/**
 * Производственная программа (ПП) — REST-дверь модуля.
 *
 * Читать план может весь производственный контур (`production_program.view`),
 * вести — те, кому выдано `production_program.edit` (двигателист, мастер).
 * Клиентский push в эти таблицы закрыт безусловным backstop'ом (владение server) —
 * эта дверь единственный путь записи.
 */
export const productionProgramRouter = Router();

const programBody = z.object({
  periodStart: z.number(),
  periodEnd: z.number(),
  shop: z.string().trim().min(1).max(120),
  /**
   * Цех из справочника (`directory_workshops`) — связь по id.
   *
   * Поле обязано быть в схеме: zod отбрасывает неизвестные ключи, и без него
   * сервер получил бы программу БЕЗ цеха (а `shop` — текстом), то есть связь
   * терялась бы молча, а ошибка не всплывала бы. Пустое значение — legacy-путь
   * (цех остаётся текстом); непустое проверяется сервисом (uuid + наличие в
   * справочнике), и сервер сам кладёт снимок имени в `shop`.
   */
  workshopId: z.string().trim().max(64).nullable().optional(),
  title: z.string().trim().min(1).max(300),
  status: z.enum(['draft', 'approved']).optional(),
  signatureSlots: z.string().nullable().optional(),
});

const lineBody = z.object({
  id: z.string().trim().nullable().optional(),
  orderNo: z.number(),
  contractId: z.string().trim().nullable().optional(),
  groupLabel: z.string().trim().min(1).max(300),
  contractKind: z.enum(['military', 'civil']).nullable().optional(),
  engineId: z.string().trim().nullable().optional(),
  engineMark: z.string().max(120).optional(),
  engineNumber: z.string().max(120).optional(),
  state: z.enum(['restoration', 'repairable', 'capital_repair']).nullable().optional(),
  shippingPlanAt: z.number().nullable().optional(),
  factors: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
});

productionProgramRouter.get('/', requirePermission(PermissionCode.ProductionProgramView), async (_req: Request, res: Response) => {
  const result = await listProductionPrograms();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

productionProgramRouter.get('/:id', requirePermission(PermissionCode.ProductionProgramView), async (req: Request, res: Response) => {
  const result = await getProductionProgram(String(req.params.id ?? ''));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

productionProgramRouter.post('/', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const parsed = programBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные программы', issues: parsed.error.issues });
  const result = await createProductionProgram(parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

productionProgramRouter.patch('/:id', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const parsed = programBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные программы', issues: parsed.error.issues });
  const result = await updateProductionProgram(String(req.params.id ?? ''), parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

productionProgramRouter.put('/:id/rows', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const parsed = z.object({ rows: z.array(lineBody) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные строки плана', issues: parsed.error.issues });
  const result = await replaceProductionProgramRows(String(req.params.id ?? ''), parsed.data.rows);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

/**
 * Ручная отметка оператора на строке плана («особое внимание»).
 *
 * Своя дверь, а не поле в замене набора строк: замена набора — полная, и она
 * приходит из клиента, чья реплика отстаёт на минуту. Отметка ехала бы в
 * наборе — правка одного оператора затирала бы отметку, поставленную другим.
 */
productionProgramRouter.patch(
  '/:id/rows/:rowId/operator-note',
  requirePermission(PermissionCode.ProductionProgramEdit),
  async (req: Request, res: Response) => {
    const parsed = z.object({ mark: z.string().trim().nullable().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверная отметка', issues: parsed.error.issues });
    const result = await setProductionProgramRowOperatorNote(
      String(req.params.id ?? ''),
      String(req.params.rowId ?? ''),
      parsed.data.mark ?? null,
    );
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

productionProgramRouter.delete('/:id', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const result = await deleteProductionProgram(String(req.params.id ?? ''));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});
