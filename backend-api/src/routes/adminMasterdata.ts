import { Router } from 'express';
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

export const adminMasterdataRouter = Router();

adminMasterdataRouter.use(requireAuth);

function isAdminRole(role: string) {
  return String(role || '').toLowerCase() === 'admin';
}

async function requireAdmin(req: AuthenticatedRequest) {
  const roleOk = isAdminRole(req.user?.role ?? '');
  if (!roleOk) return false;
  // Optional extra check: must have masterdata.view/edit (admin will always have it).
  const canView = await hasPermission(req.user.id, PermissionCode.MasterDataView).catch(() => false);
  return roleOk && canView;
}

adminMasterdataRouter.get('/entity-types', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const rows = await listEntityTypes();
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/entity-types', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const schema = z.object({ id: z.string().uuid().optional(), code: z.string().min(1).max(200), name: z.string().min(1).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const actor = (req as AuthenticatedRequest).user;
  const r = await upsertEntityType({ id: actor.id, username: actor.username }, parsed.data);
  return res.json(r);
});

adminMasterdataRouter.get('/entity-types/:id/delete-info', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getEntityTypeDeleteInfo(id);
  return res.json(r);
});

adminMasterdataRouter.post('/entity-types/:id/delete', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const schema = z.object({ deleteEntities: z.boolean().optional(), deleteDefs: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const actor = (req as AuthenticatedRequest).user;
  const r = await deleteEntityType({ id: actor.id, username: actor.username }, id, {
    deleteEntities: !!parsed.data.deleteEntities,
    deleteDefs: !!parsed.data.deleteDefs,
  });
  return res.json(r);
});

adminMasterdataRouter.get('/attribute-defs', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const entityTypeId = String(req.query.entityTypeId || '');
  if (!entityTypeId) return res.status(400).json({ ok: false, error: 'entityTypeId required' });
  const rows = await listAttributeDefsByEntityType(entityTypeId);
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/attribute-defs', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
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
  const actor = (req as AuthenticatedRequest).user;
  const r = await upsertAttributeDef({ id: actor.id, username: actor.username }, parsed.data);
  return res.json(r);
});

adminMasterdataRouter.get('/attribute-defs/:id/delete-info', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getAttributeDefDeleteInfo(id);
  return res.json(r);
});

adminMasterdataRouter.post('/attribute-defs/:id/delete', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const schema = z.object({ deleteValues: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const actor = (req as AuthenticatedRequest).user;
  const r = await deleteAttributeDef({ id: actor.id, username: actor.username }, id, { deleteValues: !!parsed.data.deleteValues });
  return res.json(r);
});

adminMasterdataRouter.get('/entities', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const entityTypeId = String(req.query.entityTypeId || '');
  if (!entityTypeId) return res.status(400).json({ ok: false, error: 'entityTypeId required' });
  const rows = await listEntitiesByType(entityTypeId);
  return res.json({ ok: true, rows });
});

adminMasterdataRouter.post('/entities', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const schema = z.object({ entityTypeId: z.string().uuid() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const actor = (req as AuthenticatedRequest).user;
  const r = await createEntity({ id: actor.id, username: actor.username }, parsed.data.entityTypeId);
  return res.json(r);
});

adminMasterdataRouter.get('/entities/:id', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getEntityDetails(id);
  return res.json({ ok: true, entity: r });
});

adminMasterdataRouter.post('/entities/:id/set-attr', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const schema = z.object({ code: z.string().min(1).max(200), value: z.any() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const actor = (req as AuthenticatedRequest).user;
  const r = await setEntityAttribute({ id: actor.id, username: actor.username }, id, parsed.data.code, parsed.data.value);
  return res.json(r);
});

adminMasterdataRouter.get('/entities/:id/delete-info', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const r = await getIncomingLinksForEntity(id);
  return res.json(r);
});

adminMasterdataRouter.post('/entities/:id/soft-delete', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const actor = (req as AuthenticatedRequest).user;
  const r = await softDeleteEntity({ id: actor.id, username: actor.username }, id);
  return res.json(r);
});

adminMasterdataRouter.post('/entities/:id/detach-links-delete', async (req, res) => {
  const ok = await requireAdmin(req as AuthenticatedRequest);
  if (!ok) return res.status(403).json({ ok: false, error: 'admin only' });
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const actor = (req as AuthenticatedRequest).user;
  const r = await detachIncomingLinksAndSoftDeleteEntity({ id: actor.id, username: actor.username }, id);
  return res.json(r);
});

