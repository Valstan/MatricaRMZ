import { Router } from 'express';
import { z } from 'zod';

import {
  acknowledgeClientSyncRequest,
  getGlobalUiDefaults,
  getOrCreateClientSettings,
  recordClientActiveTime,
  touchClientSettings,
} from '../services/clientSettingsService.js';
import { ingestServerCriticalEvent } from '../services/criticalEventsService.js';

export const clientSettingsRouter = Router();

clientSettingsRouter.get('/settings', async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(2).max(200),
    version: z.string().max(50).optional().nullable(),
    hostname: z.string().max(200).optional().nullable(),
    platform: z.string().max(50).optional().nullable(),
    arch: z.string().max(50).optional().nullable(),
    username: z.string().max(200).optional().nullable(),
    activeMs: z.coerce.number().int().min(0).max(86_400_000).optional().nullable(),
    activeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  });
  const parsed = schema.safeParse({
    clientId: String(req.query.clientId ?? ''),
    version: req.query.version ? String(req.query.version) : null,
    hostname: req.query.hostname ? String(req.query.hostname) : null,
    platform: req.query.platform ? String(req.query.platform) : null,
    arch: req.query.arch ? String(req.query.arch) : null,
    username: req.query.username ? String(req.query.username) : null,
    activeMs: req.query.activeMs != null ? String(req.query.activeMs) : null,
    activeDate: req.query.activeDate ? String(req.query.activeDate) : null,
  });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  try {
    const row = await getOrCreateClientSettings(parsed.data.clientId);
    const globalUiDefaults = await getGlobalUiDefaults();
    const ip = req.ip || req.connection?.remoteAddress || null;
    await touchClientSettings(parsed.data.clientId, {
      version: parsed.data.version ?? null,
      hostname: parsed.data.hostname ?? null,
      platform: parsed.data.platform ?? null,
      arch: parsed.data.arch ?? null,
      ip: ip ? String(ip) : null,
      username: parsed.data.username ?? null,
    });
    if (parsed.data.username && parsed.data.activeDate && parsed.data.activeMs != null) {
      await recordClientActiveTime({
        clientId: parsed.data.clientId,
        login: parsed.data.username,
        activeDate: parsed.data.activeDate,
        activeMs: parsed.data.activeMs,
      }).catch(() => {});
    }
    return res.json({
      ok: true,
      settings: {
        clientId: row.clientId,
        updatesEnabled: row.updatesEnabled,
        torrentEnabled: row.torrentEnabled,
        loggingEnabled: row.loggingEnabled,
        loggingMode: row.loggingMode,
        uiGlobalSettingsJson: globalUiDefaults.settings,
        uiDefaultsVersion: globalUiDefaults.version,
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

// Unauthenticated ingest channel for the external watchdog process (a separate
// Go binary that runs when the app may be gone, so it has no session token).
// Mirrors the unauthenticated `/client/settings` heartbeat channel. Watchdog
// recovery outcomes surface in «Критические события» (per project policy that
// all critical signals land in the in-app section, not external channels).
clientSettingsRouter.post('/watchdog/report', async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(2).max(200),
    kind: z.enum(['recovered', 'failed']),
    version: z.string().max(50).optional().nullable(),
    detail: z.string().max(4000).optional().nullable(),
    exitCode: z.number().int().optional().nullable(),
    logTail: z.string().max(16_000).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const { clientId, kind, version, detail, exitCode, logTail } = parsed.data;
  try {
    const verSuffix = version ? ` (версия ${version})` : '';
    if (kind === 'failed') {
      ingestServerCriticalEvent({
        eventCode: 'client.watchdog.recovery_failed',
        title: 'Watchdog не смог восстановить клиент',
        humanMessage: `Watchdog не восстановил приложение на клиенте${verSuffix}.${detail ? ` ${detail}` : ''}`,
        category: 'storage',
        severity: 'error',
        clientId,
        aiDetails: { kind, version: version ?? null, exitCode: exitCode ?? null, detail: detail ?? null, logTail: logTail ?? null },
        dedupMessage: `watchdog-failed:${clientId}`,
      });
    } else {
      ingestServerCriticalEvent({
        eventCode: 'client.watchdog.recovered',
        title: 'Watchdog восстановил клиент',
        humanMessage: `Watchdog переустановил приложение на клиенте${verSuffix}.`,
        category: 'storage',
        severity: 'warn',
        clientId,
        aiDetails: { kind, version: version ?? null, exitCode: exitCode ?? null, detail: detail ?? null },
        dedupMessage: `watchdog-recovered:${clientId}`,
      });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
