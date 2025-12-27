import { Router } from 'express';
import { z } from 'zod';

import { createPart, deletePart, getPart, listParts, updatePartAttribute } from '../services/partsService.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';

export const partsRouter = Router();
partsRouter.use(requireAuth);

partsRouter.get('/', requirePermission(PermissionCode.PartsView), async (req, res) => {
  try {
    const querySchema = z.object({
      q: z.string().optional(),
      limit: z.coerce.number().int().positive().max(5000).optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const result = await listParts({ q: parsed.data.q, limit: parsed.data.limit });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.get('/:id', requirePermission(PermissionCode.PartsView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const result = await getPart({ partId: id });
    if (!result.ok) {
      return res.status(result.error === 'part not found' ? 404 : 500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.post('/', requirePermission(PermissionCode.PartsCreate), async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const schema = z.object({
      attributes: z.record(z.unknown()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const result = await createPart({
      actor: actor.username,
      attributes: parsed.data.attributes,
    });
    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.put('/:id/attributes/:code', requirePermission(PermissionCode.PartsEdit), async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    const code = String(req.params.code || '');
    if (!id || !code) return res.status(400).json({ ok: false, error: 'missing id or code' });

    const schema = z.object({
      value: z.unknown(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const result = await updatePartAttribute({
      partId: id,
      attributeCode: code,
      value: parsed.data.value,
      actor: actor.username,
    });
    if (!result.ok) {
      return res.status(result.error === 'part not found' || result.error === 'attribute not found' ? 404 : 500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.delete('/:id', requirePermission(PermissionCode.PartsDelete), async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const result = await deletePart({ partId: id, actor: actor.username });
    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Получить файлы, привязанные к детали (через атрибуты типа 'link')
partsRouter.get('/:id/files', requirePermission(PermissionCode.PartsView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const partResult = await getPart({ partId: id });
    if (!partResult.ok) {
      return res.status(partResult.error === 'part not found' ? 404 : 500).json(partResult);
    }

    // Фильтруем атрибуты типа 'link', которые содержат FileRef
    const files = partResult.part.attributes
      .filter((attr) => attr.dataType === 'link' && attr.value && typeof attr.value === 'object')
      .map((attr) => attr.value);

    return res.json({ ok: true, files });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

