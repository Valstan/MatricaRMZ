import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createWarehouseDocument: vi.fn(),
  cancelWarehouseDocument: vi.fn(),
  planWarehouseDocument: vi.fn(),
  postWarehouseDocument: vi.fn(),
  getIdempotentCommandResult: vi.fn(),
  saveIdempotentCommandResult: vi.fn(),
}));

vi.mock('../auth/middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'u-admin', username: 'admin', role: 'admin' };
    next();
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/warehouseService.js', () => ({
  listWarehouseLookups: vi.fn().mockResolvedValue({ ok: true, lookups: {} }),
  listWarehouseNomenclature: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  upsertWarehouseNomenclature: vi.fn().mockResolvedValue({ ok: true, id: 'n1' }),
  deleteWarehouseNomenclature: vi.fn().mockResolvedValue({ ok: true, id: 'n1' }),
  listWarehouseNomenclatureEngineBrands: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  upsertWarehouseNomenclatureEngineBrand: vi.fn().mockResolvedValue({ ok: true, id: 'neb1' }),
  deleteWarehouseNomenclatureEngineBrand: vi.fn().mockResolvedValue({ ok: true, id: 'neb1' }),
  listWarehouseStock: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  listWarehouseDocuments: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  listWarehouseEngineInstances: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  upsertWarehouseEngineInstance: vi.fn().mockResolvedValue({ ok: true, id: 'ei1' }),
  deleteWarehouseEngineInstance: vi.fn().mockResolvedValue({ ok: true, id: 'ei1' }),
  getWarehouseDocument: vi.fn().mockResolvedValue({ ok: true, document: { header: {}, lines: [] } }),
  createWarehouseDocument: mocks.createWarehouseDocument,
  postWarehouseDocument: mocks.postWarehouseDocument,
  planWarehouseDocument: mocks.planWarehouseDocument,
  cancelWarehouseDocument: mocks.cancelWarehouseDocument,
  listWarehouseMovements: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  listWarehouseForecastIncoming: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
}));

vi.mock('../services/warehouseBomService.js', () => ({
  listWarehouseAssemblyBoms: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  getWarehouseAssemblyBom: vi.fn().mockResolvedValue({ ok: true, bom: {} }),
  getWarehouseAssemblyBomPrintPayload: vi.fn().mockResolvedValue({ ok: true, payload: {} }),
  getWarehouseAssemblyBomComponentTypeUsage: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  listWarehouseAssemblyBomHistory: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
  deleteWarehouseAssemblyBom: vi.fn().mockResolvedValue({ ok: true, id: 'b1' }),
  renameWarehouseBomComponentTypes: vi.fn().mockResolvedValue({ ok: true, renamedLineCount: 0 }),
  upsertWarehouseAssemblyBom: vi.fn().mockResolvedValue({ ok: true, id: 'b1' }),
  buildWarehouseBomExpandedForecast: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
}));

vi.mock('../services/warehouseForecastService.js', () => ({
  computeAssemblyForecastFromServer: vi.fn().mockResolvedValue({ rows: [], warnings: [], deficitRecommendations: [] }),
}));

vi.mock('../services/clientSettingsService.js', () => ({
  getGlobalWarehouseBomRelationSchema: vi.fn().mockResolvedValue({ schemaJson: '{}', updatedAt: Date.now() }),
  setGlobalWarehouseBomRelationSchema: vi.fn().mockResolvedValue({}),
}));

vi.mock('../services/commandIdempotencyService.js', () => ({
  getIdempotentCommandResult: mocks.getIdempotentCommandResult,
  saveIdempotentCommandResult: mocks.saveIdempotentCommandResult,
}));

import { createApp } from '../app.js';

describe('warehouse route idempotency and preconditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWarehouseDocument.mockResolvedValue({ ok: true, id: 'd1' });
    mocks.cancelWarehouseDocument.mockResolvedValue({ ok: true, id: 'd1', status: 'cancelled' });
    mocks.planWarehouseDocument.mockResolvedValue({ ok: true, id: 'd1', planned: true });
    mocks.postWarehouseDocument.mockResolvedValue({ ok: true, id: 'd1', posted: true });
    mocks.getIdempotentCommandResult.mockResolvedValue(null);
    mocks.saveIdempotentCommandResult.mockResolvedValue(undefined);
  });

  it('replays cached response for document upsert by clientOperationId', async () => {
    mocks.getIdempotentCommandResult.mockResolvedValueOnce({ ok: true, id: 'cached-doc' });
    const app = createApp();
    const res = await request(app)
      .post('/warehouse/documents')
      .set('x-client-id', 'client-1')
      .send({
        docType: 'stock_receipt',
        docNo: 'D-1',
        lines: [],
        clientOperationId: '5f72e5dc-bd28-4cf9-b7e1-3e59ee5adf5c',
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('cached-doc');
    expect(mocks.createWarehouseDocument).not.toHaveBeenCalled();
  });

  it('passes expectedUpdatedAt to postWarehouseDocument', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/warehouse/documents/d-1/post')
      .send({ expectedUpdatedAt: 123456 });
    expect(res.status).toBe(200);
    expect(mocks.postWarehouseDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'd-1',
        expectedUpdatedAt: 123456,
      }),
    );
  });

  it('passes expectedUpdatedAt to cancelWarehouseDocument', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/warehouse/documents/d-1/cancel')
      .send({ expectedUpdatedAt: 9001 });
    expect(res.status).toBe(200);
    expect(mocks.cancelWarehouseDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'd-1',
        expectedUpdatedAt: 9001,
      }),
    );
  });
});

