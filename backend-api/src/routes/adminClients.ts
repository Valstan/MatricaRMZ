import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { listClientSettings, updateClientSettings } from '../services/clientSettingsService.js';

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
  if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });

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
