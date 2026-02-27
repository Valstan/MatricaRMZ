import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { listClientSettings, setClientSyncRequest, updateClientSettings } from '../services/clientSettingsService.js';
import { randomUUID } from 'node:crypto';
import { emitAllMasterdataSyncSnapshot } from '../services/masterdataSyncService.js';

export const adminClientsRouter = Router();

adminClientsRouter.use(requireAuth);
adminClientsRouter.use(requirePermission(PermissionCode.ClientsManage));

adminClientsRouter.get('/clients', async (_req, res) => {
  try {
    const rows = await listClientSettings();
    return res.json({
      ok: true,
      rows: rows.map((r) => ({
        clientId: r.clientId,
        updatesEnabled: r.updatesEnabled,
        torrentEnabled: r.torrentEnabled,
        loggingEnabled: r.loggingEnabled,
        loggingMode: r.loggingMode,
        lastSeenAt: r.lastSeenAt ?? null,
        lastVersion: r.lastVersion ?? null,
        lastIp: r.lastIp ?? null,
        lastHostname: r.lastHostname ?? null,
        lastPlatform: r.lastPlatform ?? null,
        lastArch: r.lastArch ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminClientsRouter.patch('/clients/:clientId', async (req, res) => {
  const schema = z.object({
    updatesEnabled: z.boolean().optional(),
    torrentEnabled: z.boolean().optional(),
    loggingEnabled: z.boolean().optional(),
    loggingMode: z.enum(['dev', 'prod']).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const clientId = String(req.params.clientId || '').trim();
  if (!clientId) return res.status(400).json({ ok: false, error: 'clientId обязателен' });

  try {
    const updates: {
      updatesEnabled?: boolean;
      torrentEnabled?: boolean;
      loggingEnabled?: boolean;
      loggingMode?: 'dev' | 'prod';
    } = {};
    if (parsed.data.updatesEnabled !== undefined) updates.updatesEnabled = parsed.data.updatesEnabled;
    if (parsed.data.torrentEnabled !== undefined) updates.torrentEnabled = parsed.data.torrentEnabled;
    if (parsed.data.loggingEnabled !== undefined) updates.loggingEnabled = parsed.data.loggingEnabled;
    if (parsed.data.loggingMode !== undefined) updates.loggingMode = parsed.data.loggingMode;

    const row = await updateClientSettings(clientId, updates);
    return res.json({
      ok: true,
      row: {
        clientId: row.clientId,
        updatesEnabled: row.updatesEnabled,
        torrentEnabled: row.torrentEnabled,
        loggingEnabled: row.loggingEnabled,
        loggingMode: row.loggingMode,
        lastSeenAt: row.lastSeenAt ?? null,
        lastVersion: row.lastVersion ?? null,
        lastIp: row.lastIp ?? null,
        lastHostname: row.lastHostname ?? null,
        lastPlatform: row.lastPlatform ?? null,
        lastArch: row.lastArch ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminClientsRouter.post('/clients/:clientId/sync-request', async (req, res) => {
  const schema = z.object({
    type: z.enum([
      'sync_now',
      'force_full_pull',
      'entity_diff',
      'delete_local_entity',
      'force_full_pull_v2',
      'reset_sync_state_and_pull',
      'deep_repair',
    ]),
    payload: z.record(z.unknown()).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const clientId = String(req.params.clientId || '').trim();
  if (!clientId) return res.status(400).json({ ok: false, error: 'clientId обязателен' });

  try {
    if (parsed.data.type === 'force_full_pull' || parsed.data.type === 'force_full_pull_v2' || parsed.data.type === 'deep_repair') {
      await emitAllMasterdataSyncSnapshot().catch(() => null);
    }
    const payload = parsed.data.payload ? JSON.stringify(parsed.data.payload) : null;
    const row = await setClientSyncRequest(clientId, { id: randomUUID(), type: parsed.data.type, at: Date.now(), payload });
    return res.json({
      ok: true,
      row: {
        clientId: row.clientId,
        syncRequestId: row.syncRequestId ?? null,
        syncRequestType: row.syncRequestType ?? null,
        syncRequestAt: row.syncRequestAt ?? null,
        syncRequestPayload: row.syncRequestPayload ?? null,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
