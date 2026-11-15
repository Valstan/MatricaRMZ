import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import {
  createGiftRecord,
  createOrgEvent,
  deleteGiftRecord,
  deleteOrgEvent,
  getOrgEvent,
  listGiftRecords,
  listOrgEvents,
  updateGiftRecord,
  updateOrgEvent,
} from '../services/organizationService.js';

/**
 * Р В РЎвЂєР РЋР вЂљР В РЎвЂ“Р В Р’В°Р В Р вЂ¦Р В РЎвЂР В Р’В·Р В Р’В°Р РЋРІР‚В Р В РЎвЂР В РЎвЂўР В Р вЂ¦Р В Р вЂ¦Р РЋРІР‚в„–Р В РІвЂћвЂ“ Р В РЎВР В РЎвЂўР В РўвЂР РЋРЎвЂњР В Р’В»Р РЋР Р‰ Р Р†Р вЂљРІР‚Сњ REST-Р В РўвЂР В Р вЂ Р В Р’ВµР РЋР вЂљР РЋР Р‰.
 *
 * Р В РЎС™Р В Р’ВµР РЋР вЂљР В РЎвЂўР В РЎвЂ”Р РЋР вЂљР В РЎвЂР РЋР РЏР РЋРІР‚С™Р В РЎвЂР РЋР РЏ (Р В РЎвЂ”Р РЋР вЂљР В Р’В°Р В Р’В·Р В РўвЂР В Р вЂ¦Р В РЎвЂР В РЎвЂќР В РЎвЂ, Р РЋР С“Р В РЎвЂўР РЋР вЂљР В Р’ВµР В Р вЂ Р В Р вЂ¦Р В РЎвЂўР В Р вЂ Р В Р’В°Р В Р вЂ¦Р В РЎвЂР РЋР РЏ, Р В РўвЂР В Р вЂ¦Р В РЎвЂ Р РЋР вЂљР В РЎвЂўР В Р’В¶Р В РўвЂР В Р’ВµР В Р вЂ¦Р В РЎвЂР РЋР РЏ) Р В РЎвЂ Р В Р’В¶Р РЋРЎвЂњР РЋР вЂљР В Р вЂ¦Р В Р’В°Р В Р’В» Р В Р вЂ Р РЋРІР‚в„–Р В РўвЂР В Р’В°Р РЋРІР‚РЋР В РЎвЂ Р В РЎвЂ”Р В РЎвЂўР В РўвЂР В Р’В°Р РЋР вЂљР В РЎвЂќР В РЎвЂўР В Р вЂ ,
 * Р В РЎвЂ”Р РЋР вЂљР В РЎвЂР В Р’В·Р В РЎвЂўР В Р вЂ  Р В РЎвЂ Р В РЎвЂ“Р РЋР вЂљР В Р’В°Р В РЎВР В РЎвЂўР РЋРІР‚С™. Р В Р Р‹Р В РЎВР В РЎвЂўР РЋРІР‚С™Р РЋР вЂљР В Р’ВµР РЋРІР‚С™Р РЋР Р‰ Р Р†Р вЂљРІР‚Сњ `organization.view`, Р В Р вЂ Р В Р’ВµР РЋР С“Р РЋРІР‚С™Р В РЎвЂ Р Р†Р вЂљРІР‚Сњ `organization.edit`.
 * Р В РЎв„ўР В Р’В»Р В РЎвЂР В Р’ВµР В Р вЂ¦Р РЋРІР‚С™Р РЋР С“Р В РЎвЂќР В РЎвЂР В РІвЂћвЂ“ push Р В Р вЂ  Р РЋР РЉР РЋРІР‚С™Р В РЎвЂ Р РЋРІР‚С™Р В Р’В°Р В Р’В±Р В Р’В»Р В РЎвЂР РЋРІР‚В Р РЋРІР‚в„– Р В Р’В·Р В Р’В°Р В РЎвЂќР РЋР вЂљР РЋРІР‚в„–Р РЋРІР‚С™ Р В Р’В±Р В Р’ВµР В Р’В·Р РЋРЎвЂњР РЋР С“Р В Р’В»Р В РЎвЂўР В Р вЂ Р В Р вЂ¦Р РЋРІР‚в„–Р В РЎВ backstop'Р В РЎвЂўР В РЎВ (Р В Р вЂ Р В Р’В»Р В Р’В°Р В РўвЂР В Р’ВµР В Р вЂ¦Р В РЎвЂР В Р’Вµ server) Р Р†Р вЂљРІР‚Сњ
 * Р РЋР РЉР РЋРІР‚С™Р В Р’В° Р В РўвЂР В Р вЂ Р В Р’ВµР РЋР вЂљР РЋР Р‰ Р В Р’ВµР В РўвЂР В РЎвЂР В Р вЂ¦Р РЋР С“Р РЋРІР‚С™Р В Р вЂ Р В Р’ВµР В Р вЂ¦Р В Р вЂ¦Р РЋРІР‚в„–Р В РІвЂћвЂ“ Р В РЎвЂ”Р РЋРЎвЂњР РЋРІР‚С™Р РЋР Р‰ Р В Р’В·Р В Р’В°Р В РЎвЂ”Р В РЎвЂР РЋР С“Р В РЎвЂ.
 */
export const organizationRouter = Router();

/** Актор правки — попадает в журнал синка (кто записал строку). */
function actor(req: Request): { id: string; username: string; role: string } | undefined {
  return (req as AuthenticatedRequest).user;
}

const selectionBody = z.object({
  childId: z.string().uuid(),
  invited: z.boolean(),
  reason: z.string().max(300).optional(),
});

const eventBody = z.object({
  title: z.string().trim().min(1).max(300),
  kind: z.enum(['holiday', 'competition', 'birthday', 'other']).optional(),
  eventDate: z.number().nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  selections: z.array(selectionBody).max(500).nullable().optional(),
});

const giftBody = z.object({
  eventId: z.string().uuid().nullable().optional(),
  recipientKind: z.enum(['employee', 'child']).optional(),
  recipientEmployeeId: z.string().uuid().nullable().optional(),
  recipientChildId: z.string().uuid().nullable().optional(),
  kind: z.enum(['gift', 'prize', 'certificate', 'money']).optional(),
  title: z.string().max(300).nullable().optional(),
  place: z.string().max(120).nullable().optional(),
  givenAt: z.number().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

organizationRouter.get('/events', requirePermission(PermissionCode.OrganizationView), async (_req: Request, res: Response) => {
  const result = await listOrgEvents();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.get('/events/:id', requirePermission(PermissionCode.OrganizationView), async (req: Request, res: Response) => {
  const result = await getOrgEvent(String(req.params.id ?? ''));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

organizationRouter.post('/events', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const parsed = eventBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Р В Р вЂ¦Р В Р’ВµР В Р вЂ Р В Р’ВµР РЋР вЂљР В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В РўвЂР В Р’В°Р В Р вЂ¦Р В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В РЎВР В Р’ВµР РЋР вЂљР В РЎвЂўР В РЎвЂ”Р РЋР вЂљР В РЎвЂР РЋР РЏР РЋРІР‚С™Р В РЎвЂР РЋР РЏ', issues: parsed.error.issues });
  const result = await createOrgEvent(parsed.data, actor(req));
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.patch('/events/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const parsed = eventBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Р В Р вЂ¦Р В Р’ВµР В Р вЂ Р В Р’ВµР РЋР вЂљР В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В РўвЂР В Р’В°Р В Р вЂ¦Р В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В РЎВР В Р’ВµР РЋР вЂљР В РЎвЂўР В РЎвЂ”Р РЋР вЂљР В РЎвЂР РЋР РЏР РЋРІР‚С™Р В РЎвЂР РЋР РЏ', issues: parsed.error.issues });
  const result = await updateOrgEvent(String(req.params.id ?? ''), parsed.data, actor(req));
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.delete('/events/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const result = await deleteOrgEvent(String(req.params.id ?? ''), actor(req));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

organizationRouter.get('/gifts', requirePermission(PermissionCode.OrganizationView), async (_req: Request, res: Response) => {
  const result = await listGiftRecords();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.post('/gifts', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const parsed = giftBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Р В Р вЂ¦Р В Р’ВµР В Р вЂ Р В Р’ВµР РЋР вЂљР В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В РўвЂР В Р’В°Р В Р вЂ¦Р В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В Р вЂ Р РЋРІР‚в„–Р В РўвЂР В Р’В°Р РЋРІР‚РЋР В РЎвЂ', issues: parsed.error.issues });
  const result = await createGiftRecord(parsed.data, actor(req));
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.patch('/gifts/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const parsed = giftBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Р В Р вЂ¦Р В Р’ВµР В Р вЂ Р В Р’ВµР РЋР вЂљР В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В РўвЂР В Р’В°Р В Р вЂ¦Р В Р вЂ¦Р РЋРІР‚в„–Р В Р’Вµ Р В Р вЂ Р РЋРІР‚в„–Р В РўвЂР В Р’В°Р РЋРІР‚РЋР В РЎвЂ', issues: parsed.error.issues });
  const result = await updateGiftRecord(String(req.params.id ?? ''), parsed.data, actor(req));
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.delete('/gifts/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const result = await deleteGiftRecord(String(req.params.id ?? ''), actor(req));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});
