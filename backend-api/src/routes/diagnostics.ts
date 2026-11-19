import { Router } from 'express';
import { z } from 'zod';
import { compareAppVersion } from '@matricarmz/shared';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { getConsistencyReport, runServerSnapshot, storeClientSnapshot } from '../services/diagnosticsConsistencyService.js';
import { getLatestEntityDiff, storeEntityDiff } from '../services/diagnosticsEntityDiffService.js';
import { LEGACY_HIDDEN_COLUMNS, LEGACY_SCHEMA_SNAPSHOT_TABLES, SCHEMA_UNIQUE_SAFE_CLIENT_VERSION, getSyncSchemaSnapshot, hideSnapshotColumns } from '../services/diagnosticsSchemaService.js';
import { getSyncPipelineHealth } from '../services/diagnosticsSyncPipelineService.js';
import { evaluateAutohealForClient } from '../services/diagnosticsAutohealService.js';
import { deleteAllCriticalEvents, deleteCriticalEventById, listCriticalEvents } from '../services/criticalEventsService.js';
import { resolveLoginsToFullNames } from '../services/employeeAuthService.js';
import {
  raiseStuckPendingAlert,
  stuckPendingReportFromSnapshotTables,
} from '../services/stuckPendingAlertService.js';
import { STUCK_PENDING_MINUTES } from '@matricarmz/shared';

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
    syncRunId: z.string().min(1).max(120).optional(),
    serverSeq: z.number().int().nonnegative().optional(),
    tables: z.record(z.any()).optional(),
    entityTypes: z.record(z.any()).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(403).json({ ok: false, error: 'требуется авторизация' });
    const snapshot = await storeClientSnapshot(parsed.data.clientId, {
      syncRunId: parsed.data.syncRunId ?? null,
      serverSeq: parsed.data.serverSeq ?? null,
      tables: parsed.data.tables ?? {},
      entityTypes: parsed.data.entityTypes ?? {},
    });
    const autoheal = await evaluateAutohealForClient(parsed.data.clientId);
    // Очередь машины застряла — поднимаем аларм владельцу. Снимок приходит раз в
    // 10 минут, окно анти-флуда внутри сервиса не даст превратить одну беду в десяток
    // одинаковых сообщений.
    const stuckReport = stuckPendingReportFromSnapshotTables(parsed.data.tables ?? {}, STUCK_PENDING_MINUTES);
    let stuckAlert: { alerted: boolean; reason?: string } | null = null;
    if (stuckReport) {
      const raised = await raiseStuckPendingAlert({
        actor: { id: String(actor.id), username: String(actor.username ?? ''), role: actor.role ?? 'user' },
        clientId: parsed.data.clientId,
        stuck: stuckReport,
        trigger: 'auto',
      }).catch(() => null);
      if (raised) stuckAlert = { alerted: raised.alerted, ...(raised.reason ? { reason: raised.reason } : {}) };
    }
    return res.json({ ok: true, snapshot, autoheal, ...(stuckAlert ? { stuckAlert } : {}) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Кнопка «сообщить администратору» в баннере застрявшей очереди.
//
// Маршрут доступен любому авторизованному оператору: право писать в чат программы
// здесь не нужно — отчёт идёт администратору (в его чат и во внешние каналы), а не
// в общий чат парка.
diagnosticsRouter.post('/stuck-pending/report', async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1).max(200),
    count: z.number().int().nonnegative(),
    oldestPendingAt: z.number().int().nullable().optional(),
    thresholdMinutes: z.number().int().positive().max(1440).optional(),
    byTable: z
      .array(
        z.object({
          table: z.string().min(1).max(64),
          n: z.number().int().nonnegative(),
          oldestPendingAt: z.number().int().nullable().optional(),
        }),
      )
      .max(50)
      .optional(),
    lastError: z.string().max(2000).nullable().optional(),
    lastSyncAt: z.number().int().nullable().optional(),
    appVersion: z.string().max(40).nullable().optional(),
    hostName: z.string().max(120).nullable().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const actor = (req as unknown as AuthenticatedRequest).user;
  if (!actor?.id) return res.status(403).json({ ok: false, error: 'требуется авторизация' });
  try {
    const raised = await raiseStuckPendingAlert({
      actor: { id: String(actor.id), username: String(actor.username ?? ''), role: actor.role ?? 'user' },
      clientId: parsed.data.clientId,
      clientName: parsed.data.hostName ?? null,
      stuck: {
        count: parsed.data.count,
        oldestPendingAt: parsed.data.oldestPendingAt ?? null,
        thresholdMinutes: parsed.data.thresholdMinutes ?? STUCK_PENDING_MINUTES,
        byTable: (parsed.data.byTable ?? []).map((row) => ({
          table: row.table,
          n: row.n,
          oldestPendingAt: row.oldestPendingAt ?? null,
        })),
        lastError: parsed.data.lastError ?? null,
        lastSyncAt: parsed.data.lastSyncAt ?? null,
      },
      trigger: 'manual',
      appVersion: parsed.data.appVersion ?? null,
      force: true,
    });
    return res.json({
      ok: true,
      alerted: raised.alerted,
      reason: raised.reason ?? null,
      text: raised.text,
      chatSent: raised.chatSent,
    });
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
  if (!clientId) return res.status(400).json({ ok: false, error: 'clientId обязателен' });
  try {
    const { findLastClientSyncError } = await import('../services/diagnosticsLogsService.js');
    const result = findLastClientSyncError(clientId);
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Порог, ниже которого расхождение хеша схемы СНОСИТ локальную базу клиента
// (ветка 'rebuild' в ensureClientSchemaCompatible; с v3.5.0 она отвечает мягким
// 'server_schema_changed'). Таким сборкам отдаём прежний состав таблиц, иначе
// выкат стирает им неотправленную работу.
const SCHEMA_SNAPSHOT_SAFE_CLIENT_VERSION = '3.5.0';

diagnosticsRouter.get('/sync-schema', requirePermission(PermissionCode.SyncUse), async (req, res) => {
  try {
    // Отсутствие параметра — это НЕ «неизвестно», а «старая сборка»: версию
    // начали присылать вместе с расширенным снимком, и все, кто не присылает,
    // по определению его не переживут. Fail-safe направлен в сторону
    // сохранности данных на машине, а не полноты снимка.
    const raw = String((req.query as Record<string, unknown>)?.client_version ?? '').trim();
    const canTakeFullSnapshot = raw !== '' && compareAppVersion(raw, SCHEMA_SNAPSHOT_SAFE_CLIENT_VERSION) >= 0;
    const includeUniqueConstraints = raw !== '' && compareAppVersion(raw, SCHEMA_UNIQUE_SAFE_CLIENT_VERSION) >= 0;
    const schema = canTakeFullSnapshot
      ? await getSyncSchemaSnapshot({ includeUniqueConstraints })
      : hideSnapshotColumns(await getSyncSchemaSnapshot({ tables: LEGACY_SCHEMA_SNAPSHOT_TABLES }), LEGACY_HIDDEN_COLUMNS);
    return res.json({ ok: true, schema });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.get('/sync-pipeline-health', requirePermission(PermissionCode.ClientsManage), async (_req, res) => {
  try {
    const report = await getSyncPipelineHealth();
    return res.json(report);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Цепочки блоков больше нет (план ledger-journal-in-pg, 2026-09): «переиграть ledger в БД»
// нечем и незачем — истина и есть PG.
diagnosticsRouter.post('/ledger/replay', requirePermission(PermissionCode.ClientsManage), (_req, res) => {
  return res.status(410).json({ ok: false, error: 'ledger replay снят: журнал живёт в PostgreSQL, переигрывать нечего' });
});

diagnosticsRouter.get('/critical-events', requirePermission(PermissionCode.ClientsManage), async (req, res) => {
  const actor = (req as unknown as AuthenticatedRequest).user;
  const role = String(actor?.role ?? '').trim().toLowerCase();
  if (role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: 'только для superadmin' });
  }
  const parsed = z
    .object({
      days: z.coerce.number().int().min(1).max(30).optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
    })
    .safeParse(req.query ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const days = Number(parsed.data.days ?? 3);
    const limit = Number(parsed.data.limit ?? 300);
    const events = listCriticalEvents({ days, limit });
    const fullNames = await resolveLoginsToFullNames(events.map((e) => e.username));
    const enriched = events.map((e) => ({
      ...e,
      fullName: e.username ? (fullNames[e.username.trim().toLowerCase()] ?? null) : null,
    }));
    return res.json({ ok: true, days, limit, events: enriched });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.delete('/critical-events/:id', requirePermission(PermissionCode.ClientsManage), async (req, res) => {
  const actor = (req as unknown as AuthenticatedRequest).user;
  const role = String(actor?.role ?? '').trim().toLowerCase();
  if (role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: 'только для superadmin' });
  }
  const parsed = z
    .object({
      id: z.string().uuid(),
    })
    .safeParse(req.params ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const result = deleteCriticalEventById(parsed.data.id);
    return res.json({ ok: true, deleted: result.deleted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

diagnosticsRouter.delete('/critical-events', requirePermission(PermissionCode.ClientsManage), async (req, res) => {
  const actor = (req as unknown as AuthenticatedRequest).user;
  const role = String(actor?.role ?? '').trim().toLowerCase();
  if (role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: 'только для superadmin' });
  }
  try {
    const result = deleteAllCriticalEvents();
    return res.json({ ok: true, deleted: result.deleted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
