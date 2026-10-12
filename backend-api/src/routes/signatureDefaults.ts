import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { listSignatureDefaults, setSignatureDefault } from '../services/signatureDefaultsService.js';
import { requireAuth } from '../auth/middleware.js';

export const signatureDefaultsRouter = Router();
signatureDefaultsRouter.use(requireAuth);

type ReqUser = { id?: string; username?: string; role?: string } | undefined;

function roleOf(req: Request): string {
  const user = (req as { user?: ReqUser }).user;
  return String(user?.role ?? '').toLowerCase();
}

/**
 * Умолчания подписей (PR-5). Читать — всем аутентифицированным (подстановка
 * в актах нужна каждому оператору), писать — только админам. Клиентский push
 * в таблицу закрыт безусловным backstop'ом (владение server) — эта дверь
 * единственный путь записи.
 */
signatureDefaultsRouter.get('/', async (_req: Request, res: Response) => {
  const result = await listSignatureDefaults();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

signatureDefaultsRouter.post('/', async (req: Request, res: Response) => {
  const role = roleOf(req);
  if (role !== 'admin' && role !== 'superadmin') return res.status(403).json({ ok: false, error: 'только для админов' });
  const parsed = z
    .object({
      fieldKey: z.string().trim().min(1).max(120),
      employeeId: z.string().trim().uuid().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await setSignatureDefault({
    fieldKey: parsed.data.fieldKey,
    employeeId: parsed.data.employeeId ?? null,
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
