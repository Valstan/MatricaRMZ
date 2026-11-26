import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth/middleware.js';
import { globalSearch } from '../services/globalSearchService.js';

export const searchRouter = Router();

// GET /search?q=...&limit=...  — unified server-side search (L3) over heavy datasets.
// Mounted behind requireAuth; per-kind permission filtering happens inside globalSearch.
//
// ПРО РЕЕСТР ПОЛЕЙ (промт КАРМАНА #138, 25.11.2026): серверный поиск ищет «везде» —
// по всем полям строки сразу, и назвать поле совпадения он НЕ умеет. Поэтому при
// выбранном поле («где искать») клиент этот слой ВЫКЛЮЧАЕТ и говорит об этом прямо:
// иначе в суженной выдаче окажутся вхождения вне выбранного поля — ровно то, чего
// владелец просил не показывать.
//
// Ставить серверному поиску «имя поля» — работа на бэкенде (каждый источник отдаёт
// своё поле совпадения). Пока такого поля нет, честное поведение — не показывать
// серверный слой при суженном поиске.
searchRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user;
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json({ query: '', hits: [], truncated: false });
    return;
  }
  const rawLimit = Number(req.query.limit);
  const opts = Number.isFinite(rawLimit) && rawLimit > 0 ? { perKindLimit: rawLimit } : {};
  const result = await globalSearch(user.id, q, opts);
  res.json(result);
});
