import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';

import { auditLog } from '../database/schema.js';
import { db } from '../database/db.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';

export const adminAuditRouter = Router();

adminAuditRouter.use(requireAuth);
adminAuditRouter.use(requirePermission(PermissionCode.UpdatesUse));

adminAuditRouter.get('/list', async (req, res) => {
  const parsed = z
    .object({
      limit: z.coerce.number().int().min(1).max(5000).optional(),
      fromMs: z.coerce.number().int().optional(),
      toMs: z.coerce.number().int().optional(),
      actor: z.string().optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  const limit = parsed.data.limit ?? 2000;
  const filters = [isNull(auditLog.deletedAt)];
  if (parsed.data.fromMs != null) filters.push(gte(auditLog.createdAt, parsed.data.fromMs));
  if (parsed.data.toMs != null) filters.push(lte(auditLog.createdAt, parsed.data.toMs));
  if (parsed.data.actor) filters.push(eq(auditLog.actor, parsed.data.actor));

  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...filters))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  return res.json({ ok: true, rows });
});
