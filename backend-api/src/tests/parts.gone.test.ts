import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../auth/middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'u-admin', username: 'admin', role: 'admin' };
    next();
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import { partsRouter } from '../routes/parts.js';
import express from 'express';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/parts', partsRouter);
  return app;
}

// Phase 3 Stage H + Phase 3.5: the entire /parts/* surface is 410 Gone, including the
// part-template axis (deprecated as a rudiment — plans/parts-templates-deprecation-2026-06.md).
const GONE_ROUTES: Array<[string, string]> = [
  ['get', '/parts'],
  ['post', '/parts'],
  ['post', '/parts/attribute-defs'],
  ['get', '/parts/templates'],
  ['post', '/parts/templates'],
  ['get', '/parts/templates/t-1'],
  ['put', '/parts/templates/t-1/attributes/name'],
  ['delete', '/parts/templates/t-1'],
  ['post', '/parts/templates/t-1/create-part'],
  ['get', '/parts/p-1'],
  ['put', '/parts/p-1/attributes/material'],
  ['delete', '/parts/p-1'],
  ['get', '/parts/p-1/brand-links'],
  ['put', '/parts/p-1/brand-links'],
  ['delete', '/parts/p-1/brand-links/l-1'],
  ['get', '/parts/p-1/files'],
];

describe('parts legacy data API — 410 Gone (Stage H + Phase 3.5 part-template removal)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(GONE_ROUTES)('%s %s returns 410 with directory pointer', async (method, path) => {
    const app = makeApp();
    const res = await (request(app) as any)[method](path).send({});
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('/warehouse/nomenclature');
  });
});
