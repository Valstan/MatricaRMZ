import { Router } from 'express';
import { z } from 'zod';

import {
  createPart,
  createPartAttributeDef,
  deletePart,
  deletePartBrandLink,
  getPart,
  listPartBrandLinks,
  listParts,
  upsertPartBrandLink,
  updatePartAttribute,
} from '../services/partsService.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { logDebug, logError, logInfo } from '../utils/logger.js';

export const partsRouter = Router();
partsRouter.use(requireAuth);

function isErpStrictMode() {
  const raw = String(process.env.MATRICA_ERP_STRICT_MODE ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

partsRouter.get('/', requirePermission(PermissionCode.PartsView), async (req, res) => {
  try {
    logDebug('parts list', { method: req.method, query: req.query });
    const querySchema = z.object({
      q: z.string().optional(),
      limit: z.coerce.number().int().positive().max(5000).optional(),
      engineBrandId: z.string().optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const result = await listParts({
      ...(parsed.data.q !== undefined && { q: parsed.data.q }),
      ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
      ...(parsed.data.engineBrandId !== undefined && { engineBrandId: parsed.data.engineBrandId }),
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.get('/:id', requirePermission(PermissionCode.PartsView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const result = await getPart({ partId: id });
    if (!result.ok) {
      return res.status(result.error === 'деталь не найдена' ? 404 : 500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.post('/', requirePermission(PermissionCode.PartsCreate), async (req, res) => {
  if (isErpStrictMode()) {
    return res.status(409).json({ ok: false, error: 'Режим ERP strict: создание деталей доступно только через /erp API' });
  }
  try {
    logDebug('parts create', { method: req.method });
    const actor = (req as AuthenticatedRequest).user;
    const schema = z.object({
      attributes: z.record(z.unknown()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const result = await createPart({
      actor,
      ...(parsed.data.attributes !== undefined && { attributes: parsed.data.attributes }),
    });
    if (!result.ok) {
      return res.status(500).json(result);
    }
    logInfo('parts create ok', { part_id: result.part.id });
    return res.json(result);
  } catch (e) {
    logError('parts create failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Создать новое поле (attribute_def) для карточки детали (для расширения карты без миграций).
partsRouter.post('/attribute-defs', requirePermission(PermissionCode.PartsEdit), async (req, res) => {
  if (isErpStrictMode()) {
    return res.status(409).json({ ok: false, error: 'Режим ERP strict: определения атрибутов доступны только для чтения в legacy модуле деталей' });
  }
  try {
    const actor = (req as AuthenticatedRequest).user;
    const schema = z.object({
      code: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/i, 'code must match ^[a-z][a-z0-9_]*$'),
      name: z.string().min(1).max(200),
      dataType: z.enum(['text', 'number', 'boolean', 'date', 'json', 'link']),
      isRequired: z.boolean().optional(),
      sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
      metaJson: z.string().max(20_000).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const result = await createPartAttributeDef({
      actor,
      code: parsed.data.code,
      name: parsed.data.name,
      dataType: parsed.data.dataType,
      ...(parsed.data.isRequired !== undefined && { isRequired: parsed.data.isRequired }),
      ...(parsed.data.sortOrder !== undefined && { sortOrder: parsed.data.sortOrder }),
      ...(parsed.data.metaJson !== undefined && { metaJson: parsed.data.metaJson }),
    });

    if (!result.ok) {
      const status = result.error.includes('already exists') ? 409 : 500;
      return res.status(status).json(result);
    }

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.put('/:id/attributes/:code', requirePermission(PermissionCode.PartsEdit), async (req, res) => {
  if (isErpStrictMode()) {
    return res.status(409).json({ ok: false, error: 'Режим ERP strict: редактирование деталей доступно только через /erp API' });
  }
  try {
    const actor = (req as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    const code = String(req.params.code || '');
    if (!id || !code) return res.status(400).json({ ok: false, error: 'не указаны id или code' });

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
      actor,
    });
    if (!result.ok) {
      return res.status(result.error === 'деталь не найдена' || result.error === 'атрибут не найден' ? 404 : 500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.delete('/:id', requirePermission(PermissionCode.PartsDelete), async (req, res) => {
  if (isErpStrictMode()) {
    return res.status(409).json({ ok: false, error: 'Режим ERP strict: удаление деталей доступно только через /erp API' });
  }
  try {
    const actor = (req as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const result = await deletePart({ partId: id, actor });
    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.get('/:id/brand-links', requirePermission(PermissionCode.PartsView), async (req, res) => {
  try {
    const partId = String(req.params.id || '');
    if (!partId) return res.status(400).json({ ok: false, error: 'id не указан' });

    const querySchema = z.object({
      engineBrandId: z.string().optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const result = await listPartBrandLinks({
      partId,
      ...(parsed.data.engineBrandId !== undefined && { engineBrandId: parsed.data.engineBrandId }),
    });
    if (!result.ok) {
      if (result.error === 'partId не указан') return res.status(400).json(result);
      if (result.error === 'деталь не найдена') return res.status(404).json(result);
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.put('/:id/brand-links', requirePermission(PermissionCode.PartsEdit), async (req, res) => {
  if (isErpStrictMode()) {
    return res.status(409).json({ ok: false, error: 'Режим ERP strict: редактирование связей брендов доступно только через /erp API' });
  }
  try {
    const actor = (req as AuthenticatedRequest).user;
    const partId = String(req.params.id || '');
    if (!partId) return res.status(400).json({ ok: false, error: 'id не указан' });

    const schema = z.object({
      linkId: z.string().optional(),
      engineBrandId: z.string().min(1),
      assemblyUnitNumber: z.string().min(1),
      quantity: z.coerce.number().finite().nonnegative(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const result = await upsertPartBrandLink({
      actor,
      partId,
      ...(parsed.data.linkId !== undefined && { linkId: parsed.data.linkId }),
      engineBrandId: parsed.data.engineBrandId,
      assemblyUnitNumber: parsed.data.assemblyUnitNumber,
      quantity: parsed.data.quantity,
    });
    if (!result.ok) {
      if (result.error.startsWith('missing ') || result.error.startsWith('quantity')) return res.status(400).json(result);
      if (
        result.error === 'деталь не найдена' ||
        result.error === 'бренд двигателя не найден' ||
        result.error === 'связь не найдена' ||
        result.error === 'ссылка не относится к этой детали'
      )
        return res.status(404).json(result);
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

partsRouter.delete('/:id/brand-links/:linkId', requirePermission(PermissionCode.PartsEdit), async (req, res) => {
  if (isErpStrictMode()) {
    return res.status(409).json({ ok: false, error: 'Режим ERP strict: редактирование связей брендов доступно только через /erp API' });
  }
  try {
    const actor = (req as AuthenticatedRequest).user;
    const partId = String(req.params.id || '');
    const linkId = String(req.params.linkId || '');
    if (!partId) return res.status(400).json({ ok: false, error: 'id не указан' });
    if (!linkId) return res.status(400).json({ ok: false, error: 'linkId не указан' });

    const result = await deletePartBrandLink({ actor, partId, linkId });
    if (!result.ok) {
      if (result.error === 'partId не указан' || result.error === 'linkId не указан') return res.status(400).json(result);
      if (
        result.error === 'деталь не найдена' ||
        result.error === 'связь не найдена' ||
        result.error === 'ссылка не относится к этой детали'
      )
        return res.status(404).json(result);
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
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const partResult = await getPart({ partId: id });
    if (!partResult.ok) {
      return res.status(partResult.error === 'деталь не найдена' ? 404 : 500).json(partResult);
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

