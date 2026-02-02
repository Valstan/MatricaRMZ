import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { getConsistencyReport, runServerSnapshot, storeClientSnapshot } from '../services/diagnosticsConsistencyService.js';
import { getLatestEntityDiff, storeEntityDiff } from '../services/diagnosticsEntityDiffService.js';
import { getSyncSchemaSnapshot } from '../services/diagnosticsSchemaService.js';
import { replayLedgerToDb } from '../services/sync/ledgerReplayService.js';

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

diagnosticsRouter.post('/entity-diff/report', requirePermission(PermissionCode.SyncUse), async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1).max(200),
    entityId: z.string().uuid(),
    entity: z.object({
      id: z.string().uuid(),
      createdAt: z.number().int().optional().nullable(),
      updatedAt: z.number().int().optional().nullable(),
      attributes: z.record(z.unknown()).optional(),
    }),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const clientEntity = {
      id: parsed.data.entity.id,
      createdAt: parsed.data.entity.createdAt ?? null,
      updatedAt: parsed.data.entity.updatedAt ?? null,
      attributes: parsed.data.entity.attributes ?? {},
    };
    const diff = await storeEntityDiff({
      clientId: parsed.data.clientId,
      entityId: parsed.data.entityId,
      clientEntity,
    });
    return res.json({ ok: true, diff });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.get('/entity-diff', requirePermission(PermissionCode.ClientsManage), async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1).max(200),
    entityId: z.string().uuid(),
  });
  const parsed = schema.safeParse({ clientId: req.query.clientId, entityId: req.query.entityId });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const diff = await getLatestEntityDiff(parsed.data.clientId, parsed.data.entityId);
    return res.json({ ok: true, diff });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.get('/clients/:clientId/last-error', requirePermission(PermissionCode.ClientsManage), async (req, res) => {
  const clientId = String(req.params.clientId || '').trim();
  if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
  try {
    const { findLastClientSyncError } = await import('../services/diagnosticsLogsService.js');
    const result = findLastClientSyncError(clientId);
    return res.json({ ok: true, result });
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

diagnosticsRouter.post('/ledger/replay', requirePermission(PermissionCode.ClientsManage), async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(403).json({ ok: false, error: 'auth required' });
    const result = await replayLedgerToDb({ id: actor.id, username: actor.username, role: actor.role });
    return res.json({ ok: true, applied: result.applied });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
