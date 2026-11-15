import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import {
  createChild,
  deleteChild,
  getChild,
  listChildren,
  updateChild,
} from '../services/childrenService.js';

/**
 * Детский модуль — REST-дверь.
 *
 * Смотреть карточки детей может тот, кому выдан раздел и право `children.view`;
 * вести — тот, кому выдано `children.edit`. Клиентский push в эту таблицу закрыт
 * безусловным backstop'ом (владение server) — эта дверь единственный путь записи.
 */
export const childrenRouter = Router();

/** Актор правки — попадает в журнал синка (кто записал строку). */
function actor(req: Request): { id: string; username: string; role: string } | undefined {
  return (req as AuthenticatedRequest).user;
}

const childBody = z.object({
  employeeId: z.string().uuid().nullable().optional(),
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.number().nullable().optional(),
  gender: z.enum(['male', 'female']).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

childrenRouter.get('/', requirePermission(PermissionCode.ChildrenView), async (_req: Request, res: Response) => {
  const result = await listChildren();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

childrenRouter.get('/:id', requirePermission(PermissionCode.ChildrenView), async (req: Request, res: Response) => {
  const result = await getChild(String(req.params.id ?? ''));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

childrenRouter.post('/', requirePermission(PermissionCode.ChildrenEdit), async (req: Request, res: Response) => {
  const parsed = childBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные карточки ребёнка', issues: parsed.error.issues });
  const result = await createChild(parsed.data, actor(req));
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

childrenRouter.patch('/:id', requirePermission(PermissionCode.ChildrenEdit), async (req: Request, res: Response) => {
  const parsed = childBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные карточки ребёнка', issues: parsed.error.issues });
  const result = await updateChild(String(req.params.id ?? ''), parsed.data, actor(req));
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

childrenRouter.delete('/:id', requirePermission(PermissionCode.ChildrenEdit), async (req: Request, res: Response) => {
  const result = await deleteChild(String(req.params.id ?? ''), actor(req));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});
