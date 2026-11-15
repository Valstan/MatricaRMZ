import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requirePermission } from '../auth/middleware.js';
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
 * Организационный модуль — REST-дверь.
 *
 * Мероприятия (праздники, соревнования, дни рождения) и журнал выдачи подарков,
 * призов и грамот. Смотреть — `organization.view`, вести — `organization.edit`.
 * Клиентский push в эти таблицы закрыт безусловным backstop'ом (владение server) —
 * эта дверь единственный путь записи.
 */
export const organizationRouter = Router();

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
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные мероприятия', issues: parsed.error.issues });
  const result = await createOrgEvent(parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.patch('/events/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const parsed = eventBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные мероприятия', issues: parsed.error.issues });
  const result = await updateOrgEvent(String(req.params.id ?? ''), parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.delete('/events/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const result = await deleteOrgEvent(String(req.params.id ?? ''));
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
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные выдачи', issues: parsed.error.issues });
  const result = await createGiftRecord(parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.patch('/gifts/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const parsed = giftBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные выдачи', issues: parsed.error.issues });
  const result = await updateGiftRecord(String(req.params.id ?? ''), parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

organizationRouter.delete('/gifts/:id', requirePermission(PermissionCode.OrganizationEdit), async (req: Request, res: Response) => {
  const result = await deleteGiftRecord(String(req.params.id ?? ''));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});
