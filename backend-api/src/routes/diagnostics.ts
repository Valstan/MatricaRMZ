import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { getConsistencyReport, runServerSnapshot, storeClientSnapshot } from '../services/diagnosticsConsistencyService.js';
import { getSyncSchemaSnapshot } from '../services/diagnosticsSchemaService.js';

export const diagnosticsRouter = Router();

diagnosticsRouter.use(requireAuth);

diagnosticsRouter.get('/consistency', requirePermission(PermissionCode.ClientsManage), async (_req, res) => {
  try {
    const report = await getConsistencyReport();
    return res.json({ ok: true, report });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.post('/consistency/run', requirePermission(PermissionCode.ClientsManage), async (_req, res) => {
  try {
    await runServerSnapshot();
    const report = await getConsistencyReport();
    return res.json({ ok: true, report });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.post('/consistency/report', requirePermission(PermissionCode.SyncUse), async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1).max(200),
    serverSeq: z.number().int().nonnegative().optional(),
    tables: z.record(z.any()).optional(),
    entityTypes: z.record(z.any()).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(403).json({ ok: false, error: 'auth required' });
    const snapshot = await storeClientSnapshot(parsed.data.clientId, {
      serverSeq: parsed.data.serverSeq ?? null,
      tables: parsed.data.tables ?? {},
      entityTypes: parsed.data.entityTypes ?? {},
    });
    return res.json({ ok: true, snapshot });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.get('/sync-schema', requirePermission(PermissionCode.SyncUse), async (_req, res) => {
  try {
    const schema = await getSyncSchemaSnapshot();
    return res.json({ ok: true, schema });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
