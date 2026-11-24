/**
 * Шаблон подписей производственной программы — REST-дверь (промт КАРМАНА #120).
 *
 * Границы прав:
 *  - читать шаблоны — тот, кто видит производственную программу;
 *  - вести — поимённое право `production_program.signature_templates.edit`:
 *    шаблон по умолчанию подставляется в НОВЫЕ программы всего завода.
 *
 * Таблица вне sync-контракта: клиентский push в неё невозможен, эта дверь —
 * единственный путь записи.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requirePermission } from '../auth/middleware.js';
import {
  deleteProductionProgramSignatureTemplate,
  listProductionProgramSignatureTemplates,
  saveProductionProgramSignatureTemplate,
} from '../services/productionProgramSignatureTemplateService.js';

export const productionProgramSignatureTemplatesRouter = Router();

const templateBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  slots: z.string().min(1),
  isDefault: z.boolean().optional(),
});

productionProgramSignatureTemplatesRouter.get(
  '/',
  requirePermission(PermissionCode.ProductionProgramView),
  async (_req: Request, res: Response) => {
    const rows = await listProductionProgramSignatureTemplates();
    return res.json({ ok: true, rows });
  },
);

productionProgramSignatureTemplatesRouter.post(
  '/',
  requirePermission(PermissionCode.ProductionProgramSignatureTemplatesEdit),
  async (req: Request, res: Response) => {
    const parsed = templateBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const user = (req as { user?: { username?: string } }).user;
    const result = await saveProductionProgramSignatureTemplate({
      ...(parsed.data.id ? { id: parsed.data.id } : {}),
      // Шаблон по умолчанию — общий для парка: он подставляется в новые программы
      // на всех компьютерах завода, и личный тут не имел бы смысла.
      ownerId: 'shared',
      name: parsed.data.name,
      slots: parsed.data.slots,
      ...(parsed.data.isDefault !== undefined ? { isDefault: parsed.data.isDefault } : {}),
      updatedBy: String(user?.username ?? ''),
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

productionProgramSignatureTemplatesRouter.delete(
  '/:id',
  requirePermission(PermissionCode.ProductionProgramSignatureTemplatesEdit),
  async (req: Request, res: Response) => {
    const result = await deleteProductionProgramSignatureTemplate(String(req.params.id ?? ''));
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);
