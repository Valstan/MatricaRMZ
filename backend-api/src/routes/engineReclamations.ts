import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requirePermission } from '../auth/middleware.js';
import { listEngineReclamations, replaceEngineReclamations } from '../services/engineReclamationService.js';

/**
 * Рекламации двигателя — REST-дверь очереди заездов.
 *
 * Читать очередь может тот, кто видит двигатели (`engines.view`), вести —
 * тот, кто правит карточки (`engines.edit`). Клиентский push в таблицу закрыт
 * безусловным backstop'ом (владение server) — эта дверь единственный путь записи.
 */
export const engineReclamationsRouter = Router();

const reclamationBody = z.object({
  id: z.string().trim().nullable().optional(),
  queueNo: z.number().int().optional(),
  acceptedAt: z.number().nullable().optional(),
  shippedAt: z.number().nullable().optional(),
  customerReason: z.string().nullable().optional(),
  actualDefect: z.string().nullable().optional(),
  defectNature: z.string().nullable().optional(),
  actNumber: z.string().nullable().optional(),
  actDate: z.number().nullable().optional(),
  comment: z.string().nullable().optional(),
});

const queueBody = z.object({
  rows: z.array(reclamationBody),
  /** Даты основного цикла — для гейта «заезды не пересекаются». */
  mainArrivalDate: z.number().nullable().optional(),
  mainShippingDate: z.number().nullable().optional(),
  /**
   * Подтверждение очистки: пустой `rows` без этого флага НЕ удаляет очередь (жалоба
   * владельца 11.11.2026, Е02АТ5382: клиент с отставшей репликой прислал пустую очередь
   * — и сервер смягко удалил рекламацию, которую оператор только что записал).
   */
  clear: z.boolean().optional(),
});

engineReclamationsRouter.get(
  '/:engineId',
  requirePermission(PermissionCode.EnginesView),
  async (req: Request, res: Response) => {
    const result = await listEngineReclamations(String(req.params.engineId ?? ''));
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

engineReclamationsRouter.put(
  '/:engineId',
  requirePermission(PermissionCode.EnginesEdit),
  async (req: Request, res: Response) => {
    const parsed = queueBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'неверные данные рекламаций', issues: parsed.error.issues });
    }
    const result = await replaceEngineReclamations(
      String(req.params.engineId ?? ''),
      parsed.data.rows,
      {
        mainArrivalDate: parsed.data.mainArrivalDate ?? null,
        mainShippingDate: parsed.data.mainShippingDate ?? null,
      },
      { clear: parsed.data.clear === true },
    );
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);
