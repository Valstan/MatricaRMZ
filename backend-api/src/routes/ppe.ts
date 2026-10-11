import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { getIdempotentCommandResult, saveIdempotentCommandResult } from '../services/commandIdempotencyService.js';
import {
  assignCardNorms,
  closePpeCard,
  getPpeCard,
  getPpeNormSet,
  issuePpe,
  listPpeNormSets,
  openPpeCard,
  upsertPpeNormSet,
} from '../services/ppeService.js';

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
  const parsed = z.object({ postTitle: z.string().trim().min(1).optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listPpeNormSets({
    ...(parsed.data.postTitle ? { postTitle: parsed.data.postTitle } : {}),
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
ppeRouter.post('/cards/:id/issue', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
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
