import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';

import { auditLog } from '../database/schema.js';
import { db } from '../database/db.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { listEmployeesAuth } from '../services/employeeAuthService.js';

export const adminAuditRouter = Router();

adminAuditRouter.use(requireAuth);
adminAuditRouter.use(requirePermission(PermissionCode.AdminUsersManage));
adminAuditRouter.use((req, res, next) => {
  const role = String((req as AuthenticatedRequest).user?.role ?? '').toLowerCase();
  if (role !== 'superadmin') return res.status(403).json({ ok: false, error: 'superadmin only' });
  return next();
});

type ActionType = 'create' | 'update' | 'delete' | 'session' | 'other';

function parsePayload(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function sectionOf(actionRaw: string) {
  const action = String(actionRaw ?? '').toLowerCase();
  if (action.startsWith('app.session.')) return 'Сессия приложения';
  if (action.startsWith('auth.')) return 'Авторизация';
  if (action.startsWith('ui.supply_request.') || action.startsWith('supply_request.')) return 'Заявки';
  if (action.startsWith('ui.engine.') || action.startsWith('engine.')) return 'Двигатели';
  if (action.startsWith('part.')) return 'Детали';
  if (action.startsWith('tool.')) return 'Инструменты';
  if (action.startsWith('employee.')) return 'Сотрудники';
  if (action.startsWith('masterdata.') || action.startsWith('admin:')) return 'Справочники';
  if (action.startsWith('sync.')) return 'Синхронизация';
  if (action.startsWith('files.')) return 'Файлы';
  return 'Прочее';
}

function classifyActionType(actionRaw: string): ActionType {
  const action = String(actionRaw ?? '').toLowerCase();
  if (action.startsWith('app.session.')) return 'session';
  if (action.includes('.delete') || action.endsWith('_delete') || action.includes('soft_delete')) return 'delete';
  if (action.includes('.create') || action.endsWith('_create')) return 'create';
  if (
    action.includes('.update') ||
    action.includes('.edit') ||
    action.includes('.set_attr') ||
    action.includes('.upsert') ||
    action.includes('.transition') ||
    action.includes('.post') ||
    action.includes('.approve')
  ) {
    return 'update';
  }
  return 'other';
}

function actionText(actionRaw: string, payload: any): string {
  const action = String(actionRaw ?? '');
  if (action === 'app.session.start') return 'Включил программу';
  if (action === 'app.session.stop') return 'Выключил программу';
  if (action === 'ui.engine.edit_done') return payload?.summaryRu ? `Изменил карточку двигателя. ${String(payload.summaryRu)}` : 'Изменил карточку двигателя';
  if (action === 'ui.supply_request.edit_done') {
    return payload?.summaryRu ? `Изменил заявку. ${String(payload.summaryRu)}` : 'Изменил заявку';
  }
  if (action === 'engine.create') return 'Создал двигатель';
  if (action === 'part.create') return 'Создал деталь';
  if (action === 'part.delete') return 'Удалил деталь';
  if (action === 'supply_request.create') return 'Создал заявку';
  if (action === 'supply_request.delete') return 'Удалил заявку';
  if (action === 'supply_request.transition') {
    if (payload?.fromStatus && payload?.toStatus) return `Изменил статус заявки: ${String(payload.fromStatus)} -> ${String(payload.toStatus)}`;
    return 'Изменил статус заявки';
  }
  if (classifyActionType(action) === 'create') return 'Создал запись';
  if (classifyActionType(action) === 'update') return 'Изменил запись';
  if (classifyActionType(action) === 'delete') return 'Удалил запись';
  return action;
}

function docLabel(payload: any, section: string) {
  if (payload?.requestNumber) return `Заявка ${String(payload.requestNumber)}`;
  if (payload?.engineNumber) return `Двигатель ${String(payload.engineNumber)}`;
  if (payload?.name && section === 'Детали') return `Деталь ${String(payload.name)}`;
  if (payload?.docNo) return String(payload.docNo);
  return '';
}

function startOfDayMs(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime();
}

function dayAtHourMs(date: Date, hour: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0).getTime();
}

function parseDateInput(raw: string | undefined): Date {
  if (!raw) return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

function formatHours(ms: number) {
  return Math.max(0, Math.round((ms / (60 * 60 * 1000)) * 100) / 100);
}

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

  const mapped = rows
    .map((row) => {
      const payload = parsePayload(row.payloadJson);
      const section = sectionOf(row.action);
      const type = classifyActionType(row.action);
      return {
        id: row.id,
        createdAt: Number(row.createdAt),
        actor: row.actor,
        action: row.action,
        actionType: type,
        section,
        actionText: actionText(row.action, payload),
        documentLabel: docLabel(payload, section),
        clientId: payload?.clientId ? String(payload.clientId) : null,
        tableName: row.tableName,
      };
    })
    .filter((row) => (parsed.data.actionType ? row.actionType === parsed.data.actionType : true));

  return res.json({ ok: true, rows: mapped });
});

adminAuditRouter.get('/daily-summary', async (req, res) => {
  const parsed = z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      cutoffHour: z.coerce.number().int().min(0).max(23).optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  const day = parseDateInput(parsed.data.date);
  const cutoffHour = parsed.data.cutoffHour ?? 21;
  const rangeStart = startOfDayMs(day);
  const rangeEnd = dayAtHourMs(day, cutoffHour);
  const sessionFrom = rangeStart - 24 * 60 * 60 * 1000;

  const [allRows, sessionRows] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(and(isNull(auditLog.deletedAt), gte(auditLog.createdAt, rangeStart), lte(auditLog.createdAt, rangeEnd)))
      .orderBy(desc(auditLog.createdAt))
      .limit(200_000),
    db
      .select()
      .from(auditLog)
      .where(and(isNull(auditLog.deletedAt), gte(auditLog.createdAt, sessionFrom), lte(auditLog.createdAt, rangeEnd)))
      .orderBy(auditLog.createdAt)
      .limit(200_000),
  ]);

  const list = await listEmployeesAuth().catch(() => null);
  const nameByLogin = new Map<string, string>();
  if (list?.ok) {
    for (const row of list.rows) {
      const login = String(row.login ?? '').trim().toLowerCase();
      if (!login) continue;
      nameByLogin.set(login, String(row.fullName ?? '').trim() || String(row.login ?? '').trim());
    }
  }

  const byActor = new Map<
    string,
    {
      login: string;
      fullName: string;
      created: number;
      updated: number;
      deleted: number;
      onlineMs: number;
    }
  >();
  const ensureActor = (actorRaw: string) => {
    const login = String(actorRaw ?? '').trim();
    const key = login.toLowerCase();
    const existing = byActor.get(key);
    if (existing) return existing;
    const row = {
      login,
      fullName: nameByLogin.get(key) ?? login,
      created: 0,
      updated: 0,
      deleted: 0,
      onlineMs: 0,
    };
    byActor.set(key, row);
    return row;
  };

  for (const row of allRows) {
    const actor = ensureActor(row.actor);
    const type = classifyActionType(row.action);
    if (type === 'create') actor.created += 1;
    if (type === 'update') actor.updated += 1;
    if (type === 'delete') actor.deleted += 1;
  }

  const sessionEvents = sessionRows.filter((row) => {
    const action = String(row.action ?? '');
    return action === 'app.session.start' || action === 'app.session.stop';
  });

  const byActorClient = new Map<string, Array<{ at: number; action: string }>>();
  for (const row of sessionEvents) {
    const payload = parsePayload(row.payloadJson);
    const clientId = payload?.clientId ? String(payload.clientId) : 'unknown';
    const actor = String(row.actor ?? '').trim().toLowerCase();
    const key = `${actor}::${clientId}`;
    const listForKey = byActorClient.get(key) ?? [];
    listForKey.push({ at: Number(row.createdAt), action: String(row.action) });
    byActorClient.set(key, listForKey);
  }

  const clipAdd = (actor: string, startAt: number, endAt: number) => {
    const start = Math.max(rangeStart, startAt);
    const end = Math.min(rangeEnd, endAt);
    if (end <= start) return;
    ensureActor(actor).onlineMs += end - start;
  };

  for (const [key, events] of byActorClient.entries()) {
    const actor = key.split('::')[0] ?? '';
    if (!actor) continue;
    let openAt: number | null = null;
    for (const event of events) {
      if (event.action === 'app.session.start') {
        if (openAt != null) clipAdd(actor, openAt, event.at);
        openAt = event.at;
      } else if (event.action === 'app.session.stop') {
        if (openAt != null) {
          clipAdd(actor, openAt, event.at);
          openAt = null;
        }
      }
    }
    if (openAt != null) clipAdd(actor, openAt, rangeEnd);
  }

  const rows = Array.from(byActor.values())
    .filter((row) => row.login && (row.created + row.updated + row.deleted > 0 || row.onlineMs > 0))
    .map((row) => ({
      login: row.login,
      fullName: row.fullName,
      onlineMs: row.onlineMs,
      onlineHours: formatHours(row.onlineMs),
      created: row.created,
      updated: row.updated,
      deleted: row.deleted,
      totalChanged: row.created + row.updated + row.deleted,
    }))
    .sort((a, b) => String(a.fullName || a.login).localeCompare(String(b.fullName || b.login), 'ru'));

  return res.json({
    ok: true,
    rangeStart,
    rangeEnd,
    cutoffHour,
    rows,
  });
});
