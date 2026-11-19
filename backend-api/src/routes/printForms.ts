/**
 * Модуль печатных форм: шаблоны форм и документы (промты КАРМАНА #4/#5).
 *
 * Границы прав:
 *  - читать шаблоны (`print_forms.view`) — всякий, кто печатает;
 *  - править СВОЙ личный шаблон (`print_forms.edit`) — под свой набор блоков;
 *  - править ОБЩИЙ шаблон — как справочник (`erp.dictionary.edit`), тем же правом,
 *    что и общие шаблоны печати СИЗ;
 *  - документ создаёт и отправляет автор, а принимает или отклоняет — получатель.
 *
 * Таблицы вне sync-контракта: клиентский push в них невозможен, эти двери —
 * единственный путь записи.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '@matricarmz/shared';

import { requireAuth } from '../auth/middleware.js';
import { hasPermission } from '../auth/permissions.js';
import {
  countIncomingPrintDocuments,
  createPrintDocument,
  decidePrintDocument,
  deletePrintDocument,
  deletePrintTemplate,
  listAllPrintTemplates,
  listPrintDocuments,
  listPrintTemplates,
  savePrintTemplate,
  sendPrintDocument,
} from '../services/printFormsService.js';

export const printFormsRouter = Router();
printFormsRouter.use(requireAuth);

type ReqUser = { id?: string; username?: string; role?: string } | undefined;

function actorOf(req: Request) {
  const user = (req as { user?: ReqUser }).user;
  return {
    id: String(user?.id ?? ''),
    username: String(user?.username ?? 'unknown'),
    role: String(user?.role ?? 'user'),
  };
}

async function can(req: Request, code: string): Promise<boolean> {
  const actor = actorOf(req);
  if (!actor.id) return false;
  try {
    return await hasPermission(actor.id, code);
  } catch {
    return false;
  }
}

// ── Шаблоны ─────────────────────────────────────────────────────────────────

/**
 * Шаблоны печатных форм. Без `entityKey` — все шаблоны оператора (для раздела
 * «Печатные формы»), с `entityKey` — шаблоны одного вида объекта (для печати).
 */
printFormsRouter.get('/templates', async (req: Request, res: Response) => {
  if (!(await can(req, PermissionCode.PrintFormsView))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const actor = actorOf(req);
  const entityKey = String(req.query.entityKey ?? '').trim();
  const rows = entityKey
    ? await listPrintTemplates({ entityKey, ownerId: actor.id })
    : await listAllPrintTemplates({ ownerId: actor.id });
  return res.json({ ok: true, rows });
});

const templateBody = z.object({
  id: z.string().uuid().optional(),
  ownerId: z.enum(['shared', 'personal']).optional(),
  entityKey: z.string().min(1),
  formKey: z.string().min(1).optional(),
  name: z.string().min(1).max(200),
  layoutJson: z.string().min(1),
  isDefault: z.boolean().optional(),
});

printFormsRouter.put('/templates', async (req: Request, res: Response) => {
  const parsed = templateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }
  const actor = actorOf(req);
  const ownerId = parsed.data.ownerId === 'shared' ? 'shared' : actor.id;
  // Общий шаблон — как справочник: его правит не всякий, кто печатает.
  if (ownerId === 'shared' && !(await can(req, PermissionCode.ErpDictionaryEdit))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (ownerId !== 'shared' && !(await can(req, PermissionCode.PrintFormsEdit))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const result = await savePrintTemplate({
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    ownerId,
    entityKey: parsed.data.entityKey,
    formKey: parsed.data.formKey ?? parsed.data.entityKey,
    name: parsed.data.name,
    layoutJson: parsed.data.layoutJson,
    ...(parsed.data.isDefault !== undefined ? { isDefault: parsed.data.isDefault } : {}),
    updatedBy: actor.username,
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

printFormsRouter.delete('/templates/:id', async (req: Request, res: Response) => {
  const actor = actorOf(req);
  if (!(await can(req, PermissionCode.PrintFormsEdit))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const canEditShared = await can(req, PermissionCode.ErpDictionaryEdit);
  const result = await deletePrintTemplate(String(req.params.id ?? ''), {
    id: actor.id,
    canEditShared,
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// ── Документы ───────────────────────────────────────────────────────────────

/** Документы: `scope=inbox` (пришедшие) | `sent` (отправленные) | `drafts` (черновики). */
printFormsRouter.get('/documents', async (req: Request, res: Response) => {
  const actor = actorOf(req);
  const scopeRaw = String(req.query.scope ?? 'inbox');
  const scope = scopeRaw === 'sent' ? 'sent' : scopeRaw === 'drafts' ? 'drafts' : 'inbox';
  const rows = await listPrintDocuments({ actorUsername: actor.username, actorId: actor.id, scope });
  return res.json({ ok: true, rows });
});

/** Счётчик входящих — для кнопки «Документы» в меню. */
printFormsRouter.get('/documents/incoming-count', async (req: Request, res: Response) => {
  const actor = actorOf(req);
  const count = await countIncomingPrintDocuments(actor.username);
  return res.json({ ok: true, count });
});

const documentBody = z.object({
  entityKey: z.string().min(1),
  formKey: z.string().min(1).optional(),
  templateId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(300),
  valuesJson: z.string().optional(),
  layoutJson: z.string().optional(),
  note: z.string().max(5000).optional(),
  recipientId: z.string().nullable().optional(),
  recipientUsername: z.string().nullable().optional(),
});

printFormsRouter.post('/documents', async (req: Request, res: Response) => {
  const parsed = documentBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }
  const actor = actorOf(req);
  const result = await createPrintDocument({
    entityKey: parsed.data.entityKey,
    formKey: parsed.data.formKey ?? parsed.data.entityKey,
    templateId: parsed.data.templateId ?? null,
    title: parsed.data.title,
    valuesJson: parsed.data.valuesJson ?? '{}',
    layoutJson: parsed.data.layoutJson ?? '{}',
    note: parsed.data.note ?? '',
    recipientId: parsed.data.recipientId ?? null,
    recipientUsername: parsed.data.recipientUsername ?? null,
    authorId: actor.id,
    authorUsername: actor.username,
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

const sendBody = z.object({
  recipientId: z.string().nullable().optional(),
  recipientUsername: z.string().min(1),
  note: z.string().max(5000).optional(),
});

printFormsRouter.post('/documents/:id/send', async (req: Request, res: Response) => {
  const parsed = sendBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }
  const result = await sendPrintDocument(String(req.params.id ?? ''), {
    recipientId: parsed.data.recipientId ?? null,
    recipientUsername: parsed.data.recipientUsername,
    note: parsed.data.note ?? '',
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

const decideBody = z.object({
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().max(5000).optional(),
});

printFormsRouter.post('/documents/:id/decide', async (req: Request, res: Response) => {
  const parsed = decideBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }
  const actor = actorOf(req);
  const result = await decidePrintDocument(String(req.params.id ?? ''), {
    decision: parsed.data.decision,
    note: parsed.data.note ?? '',
    actorUsername: actor.username,
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

printFormsRouter.delete('/documents/:id', async (req: Request, res: Response) => {
  const actor = actorOf(req);
  const result = await deletePrintDocument(String(req.params.id ?? ''), { id: actor.id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
