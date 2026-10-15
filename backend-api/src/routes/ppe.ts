import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { getIdempotentCommandResult, saveIdempotentCommandResult } from '../services/commandIdempotencyService.js';
import {
  assignCardNorms,
  closeCollective,
  closePpeCard,
  createPpeAbsence,
  createPpeGroup,
  deletePpeAbsence,
  deletePpeGroup,
  distributeCollective,
  getPpeCard,
  getPpeCollective,
  getPpeGroupMembers,
  getPpeGroupNorms,
  getPpeNormSet,
  issueDutyPpe,
  issuePpe,
  listPpeAbsences,
  listPpeCollectives,
  listPpeGroups,
  listPpeNormSets,
  openCollective,
  openPpeCard,
  resolveEmployeeNormSetIds,
  setPpeGroupMembers,
  setPpeGroupNorms,
  upsertPpeNormSet,
} from '../services/ppeService.js';
import { applyPpeImportPreview, previewPpeImport } from '../services/ppeImportService.js';

export const ppeRouter = Router();
ppeRouter.use(requireAuth);

type ReqUser = { id?: string; username?: string; role?: string } | undefined;

function actorOf(req: Request) {
  const user = (req as { user?: ReqUser }).user;
  return {
    id: String(user?.id ?? ''),
    username: String(user?.username ?? 'unknown'),
    role: String(user?.role ?? 'user'),
  };
}

function clientOf(req: Request) {
  const user = (req as { user?: ReqUser }).user;
  return String(req.header('x-client-id') || req.header('x-clientid') || user?.id || 'unknown');
}

async function idempotent<T extends Record<string, unknown>>(
  req: Request,
  res: Response,
  operationId: string,
  commandType: string,
  aggregateId: string,
  run: () => Promise<T & { ok: boolean }>,
): Promise<unknown> {
  if (operationId) {
    const clientId = clientOf(req);
    const cached = await getIdempotentCommandResult({ clientId, clientOperationId: operationId });
    if (cached && cached.ok === true) return res.json(cached);
  }
  const result = await run();
  if (!result.ok) return res.status(400).json(result);
  if (operationId) {
    await saveIdempotentCommandResult({
      clientId: clientOf(req),
      clientOperationId: operationId,
      commandType,
      aggregateId,
      request: req.body as Record<string, unknown>,
      response: result as Record<string, unknown>,
    });
  }
  return res.json(result);
}

ppeRouter.get('/norms', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const parsed = z
    .object({ postTitle: z.string().trim().min(1).optional(), gender: z.enum(['M', 'F']).optional(), season: z.enum(['winter', 'summer']).optional() })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listPpeNormSets({
    ...(parsed.data.postTitle ? { postTitle: parsed.data.postTitle } : {}),
    ...(parsed.data.gender ? { gender: parsed.data.gender } : {}),
    ...(parsed.data.season ? { season: parsed.data.season } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.get('/norms/:id', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getPpeNormSet(id);
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

ppeRouter.post('/norms', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const parsed = z
    .object({
      id: z.string().uuid().optional(),
      name: z.string().trim().min(1),
      postTitle: z.string().trim().min(1).nullable().optional(),
      departmentId: z.string().uuid().nullable().optional(),
      gender: z.enum(['M', 'F']).nullable().optional(),
      season: z.enum(['winter', 'summer']).nullable().optional(),
      isDuty: z.boolean().optional(),
      validFrom: z.coerce.number().int().positive().optional(),
      validTo: z.coerce.number().int().positive().nullable().optional(),
      clientOperationId: z.string().uuid().optional(),
      lines: z
        .array(
          z.object({
            nomenclatureId: z.string().uuid(),
            qty: z.coerce.number().int().positive(),
            wearMonths: z.coerce.number().int().positive(),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  return idempotent(
    req,
    res,
    parsed.data.clientOperationId ? String(parsed.data.clientOperationId) : '',
    'ppe_norm_upsert',
    parsed.data.id ?? 'new',
    () =>
      upsertPpeNormSet({
        ...(parsed.data.id ? { id: parsed.data.id } : {}),
        name: parsed.data.name,
        ...(parsed.data.postTitle !== undefined ? { postTitle: parsed.data.postTitle } : {}),
        ...(parsed.data.departmentId !== undefined ? { departmentId: parsed.data.departmentId } : {}),
        ...(parsed.data.gender !== undefined ? { gender: parsed.data.gender } : {}),
        ...(parsed.data.season !== undefined ? { season: parsed.data.season } : {}),
        ...(parsed.data.isDuty !== undefined ? { isDuty: parsed.data.isDuty } : {}),
        ...(parsed.data.validFrom !== undefined ? { validFrom: parsed.data.validFrom } : {}),
        ...(parsed.data.validTo !== undefined ? { validTo: parsed.data.validTo } : {}),
        lines: parsed.data.lines,
      }),
  );
});

ppeRouter.post('/cards/open', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const parsed = z.object({ employeeId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await openPpeCard({ employeeId: parsed.data.employeeId });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.get('/cards/by-employee/:employeeId', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const employeeId = String(req.params.employeeId ?? '').trim();
  if (!employeeId) return res.status(400).json({ ok: false, error: 'employeeId обязателен' });
  const result = await getPpeCard({ employeeId });
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

ppeRouter.get('/cards/:id', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getPpeCard({ cardId: id });
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

ppeRouter.post('/cards/:id/norms', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const parsed = z.object({ normSetIds: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await assignCardNorms({ cardId: id, normSetIds: parsed.data.normSetIds });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.post('/cards/:id/close', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await closePpeCard({ cardId: id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Выдача создаёт и СРАЗУ проводит stock_issue (один клик в карточке),
// поэтому гейт — по проведению, а не по черновику.
ppeRouter.post('/cards/:id/issue', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {  const id = String(req.params.id ?? '').trim();
  const parsed = z
    .object({
      warehouseId: z.string().min(1),
      docNo: z.string().trim().min(1).optional(),
      clientOperationId: z.string().uuid().optional(),
      lines: z
        .array(
          z.object({
            nomenclatureId: z.string().uuid(),
            qty: z.coerce.number().int().positive(),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  return idempotent(
    req,
    res,
    parsed.data.clientOperationId ? String(parsed.data.clientOperationId) : '',
    'ppe_issue',
    id,
    () =>
      issuePpe({
        cardId: id,
        warehouseId: parsed.data.warehouseId,
        ...(parsed.data.docNo ? { docNo: parsed.data.docNo } : {}),
        lines: parsed.data.lines,
        actor: actorOf(req),
      }),
  );
});

// ────────────────────────────────────────────────────────────
// Фаза 2: отпуска, группы, транзитивные нормы, импорт Excel/1С.
// ────────────────────────────────────────────────────────────

ppeRouter.get('/absences', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const parsed = z.object({ employeeId: z.string().uuid().optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listPpeAbsences({
    ...(parsed.data.employeeId ? { employeeId: parsed.data.employeeId } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.post('/absences', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const parsed = z
    .object({
      employeeId: z.string().uuid(),
      fromMs: z.coerce.number().int().positive(),
      toMs: z.coerce.number().int().positive(),
      kind: z.string().trim().min(1).max(32).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await createPpeAbsence({
    employeeId: parsed.data.employeeId,
    fromMs: parsed.data.fromMs,
    toMs: parsed.data.toMs,
    ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.delete('/absences/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await deletePpeAbsence(id);
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

ppeRouter.get('/groups', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await listPpeGroups();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.post('/groups', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await createPpeGroup({ name: parsed.data.name });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.delete('/groups/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await deletePpeGroup(id);
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

ppeRouter.get('/groups/:id/members', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getPpeGroupMembers(id);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.put('/groups/:id/members', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const parsed = z.object({ employeeIds: z.array(z.string().uuid()).max(5000) }).safeParse(req.body);
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await setPpeGroupMembers({ groupId: id, employeeIds: parsed.data.employeeIds });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.get('/groups/:id/norms', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getPpeGroupNorms(id);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.put('/groups/:id/norms', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const parsed = z.object({ normSetIds: z.array(z.string().uuid()).max(500) }).safeParse(req.body);
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await setPpeGroupNorms({ groupId: id, normSetIds: parsed.data.normSetIds });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.get('/employees/:id/norm-sets', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await resolveEmployeeNormSetIds(id);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// ────────────────────────────────────────────────────────────
// PR-3: коллективная выдача и дежурные.
// ────────────────────────────────────────────────────────────

ppeRouter.get('/collectives', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const parsed = z.object({ departmentId: z.string().uuid().optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listPpeCollectives({
    ...(parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.get('/collectives/:id', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getPpeCollective(id);
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

ppeRouter.post('/collectives', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const parsed = z
    .object({
      id: z.string().uuid().optional(),
      departmentId: z.string().uuid(),
      warehouseId: z.string().min(1),
      clientOperationId: z.string().uuid().optional(),
      lines: z
        .array(
          z.object({
            employeeId: z.string().uuid(),
            nomenclatureId: z.string().uuid(),
            qty: z.coerce.number().int().positive(),
          }),
        )
        .max(5000)
        .optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  return idempotent(
    req,
    res,
    parsed.data.clientOperationId ? String(parsed.data.clientOperationId) : '',
    'ppe_collective_upsert',
    parsed.data.id ?? 'new',
    () =>
      openCollective({
        ...(parsed.data.id ? { id: parsed.data.id } : {}),
        departmentId: parsed.data.departmentId,
        warehouseId: parsed.data.warehouseId,
        ...(parsed.data.lines ? { lines: parsed.data.lines } : {}),
      }),
  );
});

// «Провести»: черновик → stock_issue на подразделение (агрегат по позициям) +
// персональные следы на тот же документ. Повтор не двоит (documentId на коллективе).
ppeRouter.post('/collectives/:id/distribute', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const parsed = z
    .object({ docNo: z.string().trim().min(1).optional(), clientOperationId: z.string().uuid().optional() })
    .safeParse(req.body ?? {});
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  return idempotent(
    req,
    res,
    parsed.data.clientOperationId ? String(parsed.data.clientOperationId) : '',
    'ppe_collective_distribute',
    id,
    () =>
      distributeCollective({
        collectiveId: id,
        ...(parsed.data.docNo ? { docNo: parsed.data.docNo } : {}),
        actor: actorOf(req),
      }),
  );
});

// Отмена черновика; проведённая выдача не отменяется — только сторно документа склада.
ppeRouter.post('/collectives/:id/close', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await closeCollective(id);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Дежурные: документ расхода на подразделение набора без персональных следов;
// возврат — сторно документа склада (существующая операция).
ppeRouter.post('/duty/issue', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const parsed = z
    .object({
      normSetId: z.string().uuid(),
      warehouseId: z.string().min(1),
      docNo: z.string().trim().min(1).optional(),
      clientOperationId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  return idempotent(
    req,
    res,
    parsed.data.clientOperationId ? String(parsed.data.clientOperationId) : '',
    'ppe_duty_issue',
    parsed.data.normSetId,
    () =>
      issueDutyPpe({
        normSetId: parsed.data.normSetId,
        warehouseId: parsed.data.warehouseId,
        ...(parsed.data.docNo ? { docNo: parsed.data.docNo } : {}),
        actor: actorOf(req),
      }),
  );
});

// Импорт Excel/1С: файл едет base64 в JSON (multipart на бэкенде нет,
// лимит express.json 20мб покрывает выгрузки с запасом; кап сервиса — 10мб).
ppeRouter.post('/import/preview', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const parsed = z
    .object({ filename: z.string().trim().min(1).max(256), contentBase64: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await previewPpeImport({ filename: parsed.data.filename, contentBase64: parsed.data.contentBase64 });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

ppeRouter.post('/import/apply', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const parsed = z
    .object({ previewId: z.string().min(1), contentBase64: z.string().min(1), dryRun: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await applyPpeImportPreview({
    previewId: parsed.data.previewId,
    contentBase64: parsed.data.contentBase64,
    ...(parsed.data.dryRun === true ? { dryRun: true as const } : {}),
    actor: actorOf(req),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
