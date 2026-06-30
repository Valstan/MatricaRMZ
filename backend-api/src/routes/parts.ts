import { Router, type RequestHandler } from 'express';

import { requireAuth } from '../auth/middleware.js';

export const partsRouter = Router();
partsRouter.use(requireAuth);

// Phase 3 Stage H + Phase 3.5: legacy parts EAV API полностью выведено из эксплуатации (HTTP 410 Gone).
// Карточка детали переехала в directory: nomenclature + directory_parts. Ось «шаблон детали»
// (`/parts/templates/*`) выпилена как рудимент (Phase 3.5, plans/parts-templates-deprecation-2026-06.md) —
// раньше оставалась живой по Решению C, теперь 410. Других живых потребителей `/parts/*` нет.
const PARTS_GONE = {
  ok: false as const,
  error:
    'API деталей (/parts) выведено из эксплуатации: используйте /warehouse/nomenclature и /warehouse/nomenclature/:id/part-spec',
};
const gone: RequestHandler = (_req, res) => {
  res.status(410).json(PARTS_GONE);
};

partsRouter.get('/', gone);
partsRouter.post('/', gone);
partsRouter.post('/attribute-defs', gone);

partsRouter.get('/templates', gone);
partsRouter.post('/templates', gone);
partsRouter.get('/templates/:id', gone);
partsRouter.put('/templates/:id/attributes/:code', gone);
partsRouter.delete('/templates/:id', gone);
partsRouter.post('/templates/:id/create-part', gone);

partsRouter.get('/:id', gone);
partsRouter.put('/:id/attributes/:code', gone);
partsRouter.delete('/:id', gone);
partsRouter.get('/:id/brand-links', gone);
partsRouter.put('/:id/brand-links', gone);
partsRouter.delete('/:id/brand-links/:linkId', gone);
partsRouter.get('/:id/files', gone);
