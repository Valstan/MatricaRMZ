import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { createErpDocument, listErpCards, listErpDictionary, listErpDocuments, postErpDocument, upsertErpCard, upsertErpDictionary } from '../services/erpService.js';

export const erpRouter = Router();
erpRouter.use(requireAuth);

erpRouter.get('/dictionary/:module', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const moduleName = String(req.params.module || '').trim();
  const result = await listErpDictionary(moduleName);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

erpRouter.post('/dictionary/:module', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const moduleName = String(req.params.module || '').trim();
  const schema = z.object({
    id: z.string().uuid().optional(),
    code: z.string().min(1),
    name: z.string().min(1),
    payloadJson: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertErpDictionary(moduleName, {
    code: parsed.data.code,
    name: parsed.data.name,
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    ...(parsed.data.payloadJson !== undefined ? { payloadJson: parsed.data.payloadJson } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

erpRouter.get('/cards/:module', requirePermission(PermissionCode.ErpCardsView), async (req, res) => {
  const moduleName = String(req.params.module || '').trim();
  const result = await listErpCards(moduleName);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

erpRouter.post('/cards/:module', requirePermission(PermissionCode.ErpCardsEdit), async (req, res) => {
  const moduleName = String(req.params.module || '').trim();
  const schema = z.object({
    id: z.string().uuid().optional(),
    templateId: z.string().uuid().nullable().optional(),
    serialNo: z.string().nullable().optional(),
    cardNo: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    payloadJson: z.string().nullable().optional(),
    fullName: z.string().nullable().optional(),
    personnelNo: z.string().nullable().optional(),
    roleCode: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertErpCard(moduleName, {
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    ...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
    ...(parsed.data.serialNo !== undefined ? { serialNo: parsed.data.serialNo } : {}),
    ...(parsed.data.cardNo !== undefined ? { cardNo: parsed.data.cardNo } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.payloadJson !== undefined ? { payloadJson: parsed.data.payloadJson } : {}),
    ...(parsed.data.fullName !== undefined ? { fullName: parsed.data.fullName } : {}),
    ...(parsed.data.personnelNo !== undefined ? { personnelNo: parsed.data.personnelNo } : {}),
    ...(parsed.data.roleCode !== undefined ? { roleCode: parsed.data.roleCode } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

erpRouter.get('/documents', requirePermission(PermissionCode.ErpDocumentsView), async (req, res) => {
  const schema = z.object({
    status: z.string().optional(),
    docType: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listErpDocuments({
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.docType !== undefined ? { docType: parsed.data.docType } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

erpRouter.post('/documents', requirePermission(PermissionCode.ErpDocumentsEdit), async (req, res) => {
  const schema = z.object({
    docType: z.string().min(1),
    docNo: z.string().min(1),
    docDate: z.coerce.number().int().optional(),
    departmentId: z.string().nullable().optional(),
    authorId: z.string().uuid().nullable().optional(),
    payloadJson: z.string().nullable().optional(),
    lines: z
      .array(
        z.object({
          partCardId: z.string().uuid().nullable().optional(),
          qty: z.coerce.number().int(),
          price: z.coerce.number().int().nullable().optional(),
          payloadJson: z.string().nullable().optional(),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const lines = parsed.data.lines.map((line) => ({
    qty: line.qty,
    ...(line.partCardId !== undefined ? { partCardId: line.partCardId } : {}),
    ...(line.price !== undefined ? { price: line.price } : {}),
    ...(line.payloadJson !== undefined ? { payloadJson: line.payloadJson } : {}),
  }));
  const result = await createErpDocument({
    docType: parsed.data.docType,
    docNo: parsed.data.docNo,
    lines,
    ...(parsed.data.docDate !== undefined ? { docDate: parsed.data.docDate } : {}),
    ...(parsed.data.departmentId !== undefined ? { departmentId: parsed.data.departmentId } : {}),
    ...(parsed.data.authorId !== undefined ? { authorId: parsed.data.authorId } : {}),
    ...(parsed.data.payloadJson !== undefined ? { payloadJson: parsed.data.payloadJson } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

erpRouter.post('/documents/:id/post', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const documentId = String(req.params.id || '').trim();
  if (!documentId) return res.status(400).json({ ok: false, error: 'documentId обязателен' });
  const user = (req as any).user;
  const result = await postErpDocument({
    documentId,
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
