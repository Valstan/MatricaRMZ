import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectQueue: any[] = [];

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const chain: any = {
          where: vi.fn(() => chain),
          orderBy: vi.fn(async () => (selectQueue.length > 0 ? selectQueue.shift() : [])),
          limit: vi.fn(async () => (selectQueue.length > 0 ? selectQueue.shift() : [])),
        };
        return chain;
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => ({})),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => ({})),
      onConflictDoUpdate: vi.fn(async () => ({})),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => ({})),
    })),
  },
}));

vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed: vi.fn(),
}));

import {
  cancelWarehouseDocument,
  createWarehouseDocument,
  planWarehouseDocument,
  postWarehouseDocument,
} from '../services/warehouseService.js';

describe('warehouse service optimistic preconditions', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    vi.clearAllMocks();
  });

  it('createWarehouseDocument rejects stale expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd1', status: 'draft', updatedAt: 200 }]);
    const result = await createWarehouseDocument({
      id: 'd1',
      docType: 'stock_issue',
      status: 'draft',
      docNo: 'D-1',
      lines: [],
      expectedUpdatedAt: 100,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Конфликт обновления');
  });

  it('cancelWarehouseDocument rejects stale expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd2', docType: 'stock_issue', status: 'draft', updatedAt: 500 }]);
    const result = await cancelWarehouseDocument({
      documentId: 'd2',
      expectedUpdatedAt: 400,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Конфликт обновления');
  });

  it('planWarehouseDocument rejects stale expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd3', docType: 'stock_receipt', status: 'draft', payloadJson: '{}', updatedAt: 800 }]);
    const result = await planWarehouseDocument({
      documentId: 'd3',
      expectedUpdatedAt: 700,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Конфликт обновления');
  });

  it('postWarehouseDocument rejects stale expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd4', docType: 'stock_issue', status: 'draft', payloadJson: '{}', updatedAt: 900 }]);
    const result = await postWarehouseDocument({
      documentId: 'd4',
      expectedUpdatedAt: 1,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Конфликт обновления');
  });

  it('cancelWarehouseDocument allows matching expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd5', docType: 'stock_issue', status: 'draft', updatedAt: 777 }]);
    const result = await cancelWarehouseDocument({
      documentId: 'd5',
      expectedUpdatedAt: 777,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe('d5');
      expect(result.status).toBe('cancelled');
    }
  });

  it('createWarehouseDocument allows matching expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd7', status: 'draft', updatedAt: 456 }]);
    const result = await createWarehouseDocument({
      id: 'd7',
      docType: 'stock_issue',
      status: 'draft',
      docNo: 'D-7',
      lines: [],
      expectedUpdatedAt: 456,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBe('d7');
  });

  it('planWarehouseDocument allows matching expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd8', docType: 'purchase_receipt', status: 'draft', payloadJson: '{}', updatedAt: 654 }]);
    selectQueue.push([
      {
        id: 'l1',
        headerId: 'd8',
        lineNo: 1,
        partCardId: null,
        qty: 2,
        price: null,
        payloadJson: JSON.stringify({ nomenclatureId: 'nm-1', warehouseId: 'wh-1' }),
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    ]);
    const result = await planWarehouseDocument({
      documentId: 'd8',
      expectedUpdatedAt: 654,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe('d8');
      expect(result.planned).toBe(true);
    }
  });

  it('postWarehouseDocument allows matching expectedUpdatedAt', async () => {
    selectQueue.push([{ id: 'd6', docType: 'stock_issue', status: 'posted', payloadJson: '{}', updatedAt: 321 }]);
    const result = await postWarehouseDocument({
      documentId: 'd6',
      expectedUpdatedAt: 321,
      actor: { id: 'u1', username: 'u1', role: 'user' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe('d6');
      expect(result.posted).toBe(true);
    }
  });
});

