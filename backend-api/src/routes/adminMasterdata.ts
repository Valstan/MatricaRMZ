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
import { mergeEmployeesByFullName } from '../services/employeeMergeService.js';

export const adminMasterdataRouter = Router();

adminMasterdataRouter.use(requireAuth);

function isAdminRole(role: string) {
  const r = String(role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}

async function requireAdmin(req: Request, res: Response) {
  const actor = (req as unknown as AuthenticatedRequest).user;
  const roleOk = isAdminRole(actor?.role ?? '');
  if (!roleOk) {
    res.status(403).json({ ok: false, error: 'admin only' });
    return null;
  }
  const canView = await hasPermission(actor.id, PermissionCode.MasterDataView).catch(() => false);
  if (!canView) {
    res.status(403).json({ ok: false, error: 'forbidden' });
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

adminMasterdataRouter.get('/entity-types/:id/delete-info', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getEntityTypeDeleteInfo(id);
  return res.json(r);
});

adminMasterdataRouter.post('/entity-types/:id/delete', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ deleteEntities: z.boolean().optional(), deleteDefs: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
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
  if (!entityTypeId) return res.status(400).json({ ok: false, error: 'entityTypeId required' });
  const rows = await listAttributeDefsByEntityType(entityTypeId);
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/attribute-defs', async (req, res) => {
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
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getAttributeDefDeleteInfo(id);
  return res.json(r);
});

adminMasterdataRouter.post('/attribute-defs/:id/delete', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ deleteValues: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await deleteAttributeDef({ id: actor.id, username: actor.username }, id, { deleteValues: !!parsed.data.deleteValues });
  return res.json(r);
});

adminMasterdataRouter.get('/entities', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const entityTypeId = String(req.query.entityTypeId || '');
  if (!entityTypeId) return res.status(400).json({ ok: false, error: 'entityTypeId required' });
  const rows = await listEntitiesByType(entityTypeId);
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/entities', async (req, res) => {
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
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getEntityDetails(id);
  return res.json({ ok: true, entity: r });
});

adminMasterdataRouter.post('/entities/:id/set-attr', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const schema = z.object({ code: z.string().min(1).max(200), value: z.any() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await setEntityAttribute({ id: actor.id, username: actor.username }, id, parsed.data.code, parsed.data.value);
  return res.json(r);
});

adminMasterdataRouter.get('/entities/:id/delete-info', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getIncomingLinksForEntity(id);
  return res.json(r);
});

adminMasterdataRouter.post('/entities/:id/soft-delete', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await softDeleteEntity({ id: actor.id, username: actor.username }, id);
  return res.json(r);
});

adminMasterdataRouter.post('/entities/:id/detach-links-delete', async (req, res) => {
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await detachIncomingLinksAndSoftDeleteEntity({ id: actor.id, username: actor.username }, id);
  return res.json(r);
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

