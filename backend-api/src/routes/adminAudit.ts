import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { ensureAuditStatisticsWarm, getAuditStatisticsStatus, getDailyAuditStatistics, listAuditStatistics } from '../services/statisticsAuditService.js';

export const adminAuditRouter = Router();

adminAuditRouter.use(requireAuth);
adminAuditRouter.use(requirePermission(PermissionCode.AdminUsersManage));
adminAuditRouter.use((req, res, next) => {
  const role = String((req as AuthenticatedRequest).user?.role ?? '').toLowerCase();
  if (role !== 'superadmin') return res.status(403).json({ ok: false, error: 'superadmin only' });
  return next();
});

type ActionType = 'create' | 'update' | 'delete' | 'session' | 'other';

adminAuditRouter.get('/list', async (req, res) => {
  const parsed = z
    .object({
      limit: z.coerce.number().int().min(1).max(5000).optional(),
      fromMs: z.coerce.number().int().optional(),
      toMs: z.coerce.number().int().optional(),
      actor: z.string().optional(),
      actionType: z.enum(['create', 'update', 'delete', 'session', 'other']).optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  const limit = parsed.data.limit ?? 2000;
  await ensureAuditStatisticsWarm();
  const rows = await listAuditStatistics({
    limit,
    ...(parsed.data.fromMs != null ? { fromMs: parsed.data.fromMs } : {}),
    ...(parsed.data.toMs != null ? { toMs: parsed.data.toMs } : {}),
    ...(parsed.data.actor ? { actor: parsed.data.actor } : {}),
    ...(parsed.data.actionType ? { actionType: parsed.data.actionType } : {}),
  });
  return res.json({ ok: true, rows });
});

adminAuditRouter.get('/daily-summary', async (req, res) => {
  const parsed = z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      cutoffHour: z.coerce.number().int().min(0).max(23).optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  await ensureAuditStatisticsWarm();
  const result = await getDailyAuditStatistics({
    ...(parsed.data.date ? { date: parsed.data.date } : {}),
    ...(parsed.data.cutoffHour != null ? { cutoffHour: parsed.data.cutoffHour } : {}),
  });
  return res.json({ ok: true, ...result });
});

adminAuditRouter.get('/statistics-status', async (_req, res) => {
  await ensureAuditStatisticsWarm();
  const status = await getAuditStatisticsStatus();
  return res.json({ ok: true, status });
});
