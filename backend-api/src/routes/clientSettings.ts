import { Router } from 'express';
import { z } from 'zod';

import { acknowledgeClientSyncRequest, getOrCreateClientSettings, touchClientSettings } from '../services/clientSettingsService.js';

export const clientSettingsRouter = Router();

clientSettingsRouter.get('/settings', async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(2).max(200),
    version: z.string().max(50).optional().nullable(),
    hostname: z.string().max(200).optional().nullable(),
    platform: z.string().max(50).optional().nullable(),
    arch: z.string().max(50).optional().nullable(),
    username: z.string().max(200).optional().nullable(),
  });
  const parsed = schema.safeParse({
    clientId: String(req.query.clientId ?? ''),
    version: req.query.version ? String(req.query.version) : null,
    hostname: req.query.hostname ? String(req.query.hostname) : null,
    platform: req.query.platform ? String(req.query.platform) : null,
    arch: req.query.arch ? String(req.query.arch) : null,
    username: req.query.username ? String(req.query.username) : null,
  });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  try {
    const row = await getOrCreateClientSettings(parsed.data.clientId);
    const ip = req.ip || req.connection?.remoteAddress || null;
    await touchClientSettings(parsed.data.clientId, {
      version: parsed.data.version ?? null,
      hostname: parsed.data.hostname ?? null,
      platform: parsed.data.platform ?? null,
      arch: parsed.data.arch ?? null,
      ip: ip ? String(ip) : null,
      username: parsed.data.username ?? null,
    });
    return res.json({
      ok: true,
      settings: {
        clientId: row.clientId,
        updatesEnabled: row.updatesEnabled,
        torrentEnabled: row.torrentEnabled,
        loggingEnabled: row.loggingEnabled,
        loggingMode: row.loggingMode,
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

clientSettingsRouter.post('/settings/sync-request/ack', async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(2).max(200),
    requestId: z.string().min(1),
    status: z.enum(['ok', 'error']),
    error: z.string().max(2000).optional().nullable(),
    at: z.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const row = await acknowledgeClientSyncRequest(parsed.data.clientId, {
      requestId: parsed.data.requestId,
      status: parsed.data.status,
      error: parsed.data.error ?? null,
      ...(parsed.data.at != null ? { at: parsed.data.at } : {}),
    });
    return res.json({
      ok: true,
      row: {
        clientId: row.clientId,
        syncRequestId: row.syncRequestId ?? null,
        syncRequestType: row.syncRequestType ?? null,
        syncRequestAt: row.syncRequestAt ?? null,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
