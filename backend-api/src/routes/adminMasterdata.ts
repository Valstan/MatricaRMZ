import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode, hasPermission } from '../auth/permissions.js';
import {
  createEntity,
  deleteAttributeDef,
  deleteEntityType,
  detachIncomingLinksAndSoftDeleteEntity,
  getAttributeDefDeleteInfo,
  getEntityDetails,
  getEntityTypeDeleteInfo,
  getIncomingLinksForEntity,
  listAttributeDefsByEntityType,
  listEntitiesByType,
  listEntityTypes,
  setEntityAttribute,
  softDeleteEntity,
  upsertAttributeDef,
  upsertEntityType,
} from '../services/adminMasterdataService.js';
import { analyzeEmployeeDuplicates, findEmployeeDuplicates, findEmployeeDuplicatesByKey, mergeEmployeeGroup, recordEmployeeDuplicateOverride, removeDuplicateEmployee } from '../services/employeeDedupeService.js';
import { mergeEmployeesByFullName } from '../services/employeeMergeService.js';
import { emitAllMasterdataSyncSnapshot, emitEntityTypeSyncSnapshot } from '../services/masterdataSyncService.js';

export const adminMasterdataRouter = Router();

adminMasterdataRouter.use(requireAuth);

function isAdminRole(role: string) {
  const r = String(role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}

function isErpStrictMode() {
  const raw = String(process.env.MATRICA_ERP_STRICT_MODE ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function blockLegacyEavWrites(res: Response) {
  if (!isErpStrictMode()) return false;
  res.status(409).json({ ok: false, error: 'Режим ERP strict: legacy EAV-записи отключены' });
  return true;
}

async function requireAdmin(req: Request, res: Response) {
  const actor = (req as unknown as AuthenticatedRequest).user;
  const roleOk = isAdminRole(actor?.role ?? '');
  if (!roleOk) {
    res.status(403).json({ ok: false, error: 'только для админов' });
    return null;
  }
  const canView = await hasPermission(actor.id, PermissionCode.MasterDataView).catch(() => false);
  if (!canView) {
    res.status(403).json({ ok: false, error: 'доступ запрещен' });
    return null;
  }
  return actor;
}

adminMasterdataRouter.get('/entity-types', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const rows = await listEntityTypes();
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/entity-types', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ id: z.string().uuid().optional(), code: z.string().min(1).max(200), name: z.string().min(1).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const data = parsed.data;
  const args = { code: data.code, name: data.name, ...(data.id ? { id: data.id } : {}) };
  const r = await upsertEntityType({ id: actor.id, username: actor.username }, args);
  return res.json(r);
});

adminMasterdataRouter.post('/entity-types/:id/sync-snapshot', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  try {
    const r = await emitEntityTypeSyncSnapshot(id);
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminMasterdataRouter.post('/sync-snapshot/all', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  try {
    const r = await emitAllMasterdataSyncSnapshot();
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminMasterdataRouter.get('/entity-types/:id/delete-info', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await getEntityTypeDeleteInfo(id);
  return res.json(r);
});

adminMasterdataRouter.post('/entity-types/:id/delete', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ deleteEntities: z.boolean().optional(), deleteDefs: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await deleteEntityType({ id: actor.id, username: actor.username }, id, {
    deleteEntities: !!parsed.data.deleteEntities,
    deleteDefs: !!parsed.data.deleteDefs,
  });
  return res.json(r);
});

adminMasterdataRouter.get('/attribute-defs', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const entityTypeId = String(req.query.entityTypeId || '');
  if (!entityTypeId) return res.status(400).json({ ok: false, error: 'entityTypeId обязателен' });
  const rows = await listAttributeDefsByEntityType(entityTypeId);
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/attribute-defs', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({
    id: z.string().uuid().optional(),
    entityTypeId: z.string().uuid(),
    code: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    dataType: z.enum(['text', 'number', 'boolean', 'date', 'json', 'link']),
    isRequired: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    metaJson: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const data = parsed.data;
  const args = {
    entityTypeId: data.entityTypeId,
    code: data.code,
    name: data.name,
    dataType: data.dataType,
    ...(data.isRequired !== undefined ? { isRequired: data.isRequired } : {}),
    ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
    ...(data.metaJson !== undefined ? { metaJson: data.metaJson } : {}),
    ...(data.id ? { id: data.id } : {}),
  };
  const r = await upsertAttributeDef({ id: actor.id, username: actor.username }, args);
  return res.json(r);
});

adminMasterdataRouter.get('/attribute-defs/:id/delete-info', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await getAttributeDefDeleteInfo(id);
  return res.json(r);
});

adminMasterdataRouter.post('/attribute-defs/:id/delete', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ deleteValues: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await deleteAttributeDef({ id: actor.id, username: actor.username }, id, { deleteValues: !!parsed.data.deleteValues });
  return res.json(r);
});

adminMasterdataRouter.get('/entities', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const entityTypeId = String(req.query.entityTypeId || '');
  if (!entityTypeId) return res.status(400).json({ ok: false, error: 'entityTypeId обязателен' });
  const rows = await listEntitiesByType(entityTypeId);
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/entities', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ entityTypeId: z.string().uuid() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const r = await createEntity({ id: actor.id, username: actor.username }, parsed.data.entityTypeId);
  return res.json(r);
});

adminMasterdataRouter.get('/entities/:id', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await getEntityDetails(id);
  return res.json({ ok: true, entity: r });
});

adminMasterdataRouter.post('/entities/:id/set-attr', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ code: z.string().min(1).max(200), value: z.any() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await setEntityAttribute({ id: actor.id, username: actor.username }, id, parsed.data.code, parsed.data.value);
  return res.json(r);
});

adminMasterdataRouter.get('/entities/:id/delete-info', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await getIncomingLinksForEntity(id);
  return res.json(r);
});

adminMasterdataRouter.post('/entities/:id/soft-delete', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await softDeleteEntity({ id: actor.id, username: actor.username }, id);
  return res.json(r);
});

adminMasterdataRouter.post('/entities/:id/detach-links-delete', async (req, res) => {
  if (blockLegacyEavWrites(res)) return;
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
  const r = await detachIncomingLinksAndSoftDeleteEntity({ id: actor.id, username: actor.username }, id);
  return res.json(r);
});

/**
 * Гейт обработки дублей сотрудников.
 *
 * Отдельно от `requireAdmin`: разбор дублей — операторская работа (решение владельца
 * 09.11.2026), право на неё выдаётся ролью кладовщика и точечными разрешениями.
 * Кадровую карточку целиком это право не открывает — только дубли.
 */
async function requireDedupeAccess(req: Request, res: Response) {
  const actor = (req as unknown as AuthenticatedRequest).user;
  if (!actor?.id) {
    res.status(403).json({ ok: false, error: 'требуется авторизация' });
    return null;
  }
  const [dedupe, hr] = await Promise.all([
    hasPermission(actor.id, PermissionCode.EmployeesDedupe).catch(() => false),
    hasPermission(actor.id, PermissionCode.EmployeesCreate).catch(() => false),
  ]);
  if (!dedupe && !hr) {
    res.status(403).json({ ok: false, error: 'нет права на обработку дублей сотрудников' });
    return null;
  }
  return actor;
}

/**
 * Доступ к ПРОВЕРКЕ ключа личности (без записи и без разбора дублей).
 *
 * Проверка только читает срез сотрудников, но она нужна тому, кто пишет карточку:
 * кадровику (employees.create), кладовщику с правом на должность
 * (employees.position.edit), разбирающему дубли (employees.dedupe) и админу, который
 * правит справочник «Сотрудники» (masterdata.edit). Без этого гейт на админ-пути
 * молча выключался бы: сервер отвечал бы 403, клиент счёл бы это «сервера нет» и
 * записал бы карточку без проверки.
 */
async function requireKeyCheckAccess(req: Request, res: Response) {
  const actor = (req as unknown as AuthenticatedRequest).user;
  if (!actor?.id) {
    res.status(403).json({ ok: false, error: 'требуется авторизация' });
    return null;
  }
  const [dedupe, hr, position, masterdata] = await Promise.all([
    hasPermission(actor.id, PermissionCode.EmployeesDedupe).catch(() => false),
    hasPermission(actor.id, PermissionCode.EmployeesCreate).catch(() => false),
    hasPermission(actor.id, PermissionCode.EmployeesPositionEdit).catch(() => false),
    hasPermission(actor.id, PermissionCode.MasterDataEdit).catch(() => false),
  ]);
  if (!dedupe && !hr && !position && !masterdata) {
    res.status(403).json({ ok: false, error: 'нет права на проверку карточки сотрудника' });
    return null;
  }
  return actor;
}

// Дубли сотрудников (владелец 08.09.2026). Анализ ничего не меняет; слияние — необратимая
// правка живых данных, поэтому у него есть dryRun: сперва отчёт, потом решение.
adminMasterdataRouter.get('/employees/dedupe/analyze', async (req, res) => {
  const actor = await requireDedupeAccess(req, res);
  if (!actor) return;
  const result = await analyzeEmployeeDuplicates();
  return res.json(result);
});

adminMasterdataRouter.get('/employees/dedupe/check', async (req, res) => {
  const actor = await requireDedupeAccess(req, res);
  if (!actor) return;
  // Точечная проверка при создании/правке карточки: «есть ли уже такой сотрудник».
  // По ФИО — предупреждение (однофамильцы бывают), по табельному номеру — дубль
  // всегда (номер идентифицирует человека).
  const result = await findEmployeeDuplicates({
    fullName: String(req.query.fullName ?? ''),
    personnelNumber: String(req.query.personnelNumber ?? ''),
    excludeId: String(req.query.excludeId ?? ''),
  });
  return res.json(result);
});

adminMasterdataRouter.post('/employees/dedupe/key-check', async (req, res) => {
  const actor = await requireKeyCheckAccess(req, res);
  if (!actor) return;
  // Проверка карточки по ПОЛНОМУ ключу личности (ФИО + табельный + должность +
  // дата приёма + ДР). Принимает ключ ДО и ПОСЛЕ записи: блокируется только связь,
  // которую запись сама создала, — иначе нельзя было бы поправить дубль, пришедший
  // из импорта ЗУП (см. `isNewRelation` в `shared/domain/employeeCardKey`).
  const parsed = z
    .object({
      before: z.record(z.string(), z.unknown()).default({}),
      after: z.record(z.string(), z.unknown()),
      excludeId: z.string().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await findEmployeeDuplicatesByKey({
    before: parsed.data.before,
    after: parsed.data.after,
    excludeId: parsed.data.excludeId ?? null,
  });
  return res.json(result);
});

adminMasterdataRouter.post('/employees/dedupe/override', async (req, res) => {
  const actor = await requireDedupeAccess(req, res);
  if (!actor) return;
  const parsed = z
    .object({
      employeeId: z.string().min(1),
      reason: z.string().min(1).max(500),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await recordEmployeeDuplicateOverride({
    employeeId: parsed.data.employeeId,
    reason: parsed.data.reason,
    actor: { id: actor.id, username: actor.username, role: String(actor.role ?? '') },
  });
  return res.json(result);
});

adminMasterdataRouter.post('/employees/dedupe/merge', async (req, res) => {
  const actor = await requireDedupeAccess(req, res);
  if (!actor) return;
  const schema = z.object({
    survivorId: z.string().min(1),
    /** Несколько дублей за раз (просьба владельца 07.11.2026). Старое `loserId` — одна запись. */
    loserIds: z.array(z.string().min(1)).optional(),
    loserId: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const loserIds = parsed.data.loserIds ?? (parsed.data.loserId ? [parsed.data.loserId] : []);
  if (loserIds.length === 0) {
    return res.status(400).json({ ok: false, error: 'не выбрано ни одного дубля для слияния' });
  }
  const result = await mergeEmployeeGroup({
    survivorId: parsed.data.survivorId,
    loserIds,
    ...(parsed.data.dryRun === true ? { dryRun: true } : {}),
    actor: { id: actor.id, username: actor.username, role: String(actor.role ?? '') },
  });
  return res.json(result);
});

// «Удалить карточку-дубль» (план владельца 09.11.2026): удаление дубля — это СЛИЯНИЕ с
// настоящей карточкой (ссылки перевешиваются, карточка гасится и уходит из реплики),
// а не стирание. Стирание кадровой карточки остаётся за администратором.
adminMasterdataRouter.post('/employees/dedupe/remove', async (req, res) => {
  const actor = await requireDedupeAccess(req, res);
  if (!actor) return;
  const schema = z.object({ employeeId: z.string().min(1), dryRun: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await removeDuplicateEmployee({
    employeeId: parsed.data.employeeId,
    actor: { id: actor.id, username: actor.username, role: String(actor.role ?? '') },
    ...(parsed.data.dryRun === true ? { dryRun: true } : {}),
  });
  if (!result.ok) return res.json({ ok: false, error: result.error, reason: result.reason });
  return res.json({ ok: true, survivorId: result.survivorId, report: result.report, conflicts: result.conflicts });
});

adminMasterdataRouter.post('/employees/merge', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({
    employees: z.array(
      z.object({
        fullName: z.string().nullable().optional(),
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
        middleName: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        departmentId: z.string().nullable().optional(),
        employmentStatus: z.string().nullable().optional(),
        personnelNumber: z.string().nullable().optional(),
      }),
    ),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const employees = (parsed.data.employees ?? []).map((e) => ({
    fullName: e.fullName ?? null,
    firstName: e.firstName ?? null,
    lastName: e.lastName ?? null,
    middleName: e.middleName ?? null,
    role: e.role ?? null,
    departmentId: e.departmentId ?? null,
    employmentStatus: e.employmentStatus ?? null,
    personnelNumber: e.personnelNumber ?? null,
  }));
  const result = await mergeEmployeesByFullName({ id: actor.id, username: actor.username }, employees);
  return res.json(result);
});

