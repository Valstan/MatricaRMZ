import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  addWorkOrderSignatureCaption,
  listWorkOrderSignatureCaptions,
} from '../services/workOrderSignatureCaptionService.js';

export const workOrderSignatureCaptionsRouter = Router();
workOrderSignatureCaptionsRouter.use(requireAuth);

workOrderSignatureCaptionsRouter.get(
  '/',
  requirePermission(PermissionCode.WorkOrdersCreate),
  async (_req, res) => {
    const result = await listWorkOrderSignatureCaptions();
    return res.json(result);
  },
);

workOrderSignatureCaptionsRouter.post(
  '/',
  requirePermission(PermissionCode.WorkOrdersCreate),
  async (req, res) => {
    const schema = z.object({ text: z.string().min(1).max(200) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await addWorkOrderSignatureCaption({ text: parsed.data.text, actor });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);
