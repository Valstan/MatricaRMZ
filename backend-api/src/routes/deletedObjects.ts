import { Router } from 'express';
import { z } from 'zod';

import { DELETED_RETENTION_DAYS } from '@matricarmz/shared';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  describeDeletedObject,
  listRecentlyDeleted,
  purgeDeletedObject,
  purgeExpiredDeletedObjects,
  restoreDeletedObject,
} from '../services/deletedObjectsService.js';

/**
 * «Удалённое за 3 дня» (промт КАРМАНА #169): список удалённого, восстановление,
 * окончательное удаление.
 *
 * Право — одно (`deleted.restore`): список без права восстановить — мёртвый экран,
 * а восстановление меняет данные, поэтому оно под тем же правом, что и список.
 * Супер-админ право имеет всегда (как `audit.view`).
 */
export const deletedObjectsRouter = Router();

deletedObjectsRouter.use(requireAuth);
deletedObjectsRouter.use((req, res, next) => {
  const role = String((req as AuthenticatedRequest).user?.role ?? '').toLowerCase();
  if (role === 'superadmin') return next();
  return requirePermission(PermissionCode.DeletedRestore)(req, res, next);
});

/** Список удалённого за окно (по умолчанию три дня). */
deletedObjectsRouter.get('/list', async (req, res) => {
  const parsed = z
    .object({ days: z.coerce.number().int().min(1).max(30).optional() })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const days = parsed.data.days ?? DELETED_RETENTION_DAYS;
  // Перед сборкой списка — уборка: старше срока записи не просто исчезают из вида,
  // а удаляются окончательно (правило «храним три дня»).
  await purgeExpiredDeletedObjects(days).catch(() => 0);
  const result = await listRecentlyDeleted({ days });
  return res.json({ ...result, days, retentionDays: DELETED_RETENTION_DAYS });
});

/** «Посмотреть»: что это за объект и что в нём — без восстановления. */
deletedObjectsRouter.get('/describe', async (req, res) => {
  const parsed = z
    .object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(80) })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await describeDeletedObject(parsed.data);
  if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
  return res.json(result);
});

/** Восстановить объект: снять метку удаления. */
deletedObjectsRouter.post('/restore', async (req, res) => {
  const parsed = z
    .object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(80) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as AuthenticatedRequest).user;
  const result = await restoreDeletedObject({ id: user.id, username: user.username, role: user.role }, parsed.data);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, restorePath: result.restorePath });
});

/** Удалить окончательно: необратимо, запись исчезает из списка. */
deletedObjectsRouter.post('/purge', async (req, res) => {
  const parsed = z
    .object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(80) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as AuthenticatedRequest).user;
  const result = await purgeDeletedObject({ id: user.id, username: user.username, role: user.role }, parsed.data);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true });
});
