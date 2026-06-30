import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit-тесты для reserveAssemblyDraftReservation / releaseAssemblyDraftReservation
 * (Stage 1 плана assembly-work-order-from-forecast).
 *
 * Mock БД: общий FIFO-queue для select-результатов (как в warehouse.service.precondition.test.ts).
 * Порядок select-ов в reserve: header → lines → balance (по одному на каждую группу).
 * Порядок select-ов в release: header → lines → balance (по одному на каждую группу).
 */

const selectQueue: any[] = [];
const insertCalls: Array<{ table: unknown; values: unknown }> = [];
const updateCalls: Array<{ table: unknown; set: unknown }> = [];

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(async () => (selectQueue.length > 0 ? selectQueue.shift() : [])),
        limit: vi.fn(async () => (selectQueue.length > 0 ? selectQueue.shift() : [])),
      };
      return chain;
    }),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: unknown) => {
        updateCalls.push({ table, set });
        return {
          where: vi.fn(async () => ({})),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        insertCalls.push({ table, values });
        return {};
      }),
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
  reserveAssemblyDraftReservation,
  releaseAssemblyDraftReservation,
} from '../services/warehouseService.js';

const actor = { id: 'u1', username: 'u1', role: 'user' };

function pushHeader(overrides?: Partial<{ status: string; docType: string; payloadJson: string }>) {
  selectQueue.push([
    {
      id: 'd1',
      docType: overrides?.docType ?? 'assembly_consumption',
      status: overrides?.status ?? 'draft',
      payloadJson: overrides?.payloadJson ?? JSON.stringify({ module: 'parts_movement_v1', workshopWarehouseId: '11111111-1111-1111-1111-111111111111' }),
      updatedAt: 100,
      deletedAt: null,
    },
  ]);
}

function pushLines(lines: Array<{ lineNo: number; qty: number; nomenclatureId: string; sourceWarehouseId?: string }>) {
  selectQueue.push(
    lines.map((line) => ({
      id: `line-${line.lineNo}`,
      headerId: 'd1',
      lineNo: line.lineNo,
      qty: line.qty,
      partCardId: null,
      payloadJson: JSON.stringify({
        nomenclatureId: line.nomenclatureId,
        ...(line.sourceWarehouseId ? { sourceWarehouseId: line.sourceWarehouseId } : {}),
      }),
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    })),
  );
}

function pushBalance(rows: Array<{ qty: number; reservedQty: number } | null>) {
  for (const row of rows) {
    selectQueue.push(row ? [{ id: 'bal-1', qty: row.qty, reservedQty: row.reservedQty }] : []);
  }
}

describe('reserveAssemblyDraftReservation', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    insertCalls.length = 0;
    updateCalls.length = 0;
    vi.clearAllMocks();
  });

  it('инкрементирует reservedQty по группе (nomenclatureId, sourceWarehouseId)', async () => {
    pushHeader();
    pushLines([{ lineNo: 1, qty: 3, nomenclatureId: 'nm-1', sourceWarehouseId: '11111111-1111-1111-1111-111111111111' }]);
    pushBalance([{ qty: 10, reservedQty: 2 }]);
    const result = await reserveAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reserved).toBe(true);
      expect(result.alreadyReserved).toBe(false);
    }
    const balanceUpdate = updateCalls.find((c) => (c.set as any).reservedQty != null);
    expect(balanceUpdate).toBeDefined();
    expect((balanceUpdate!.set as any).reservedQty).toBe(5); // 2 + 3
    expect((balanceUpdate!.set as any).qty).toBe(10); // qty не меняется
    const journalInsert = insertCalls.find((c) => (c.values as any).eventType === 'reserved');
    expect(journalInsert).toBeDefined();
  });

  it('идемпотентен через флаг reservedAt в payloadJson', async () => {
    pushHeader({ payloadJson: JSON.stringify({ module: 'parts_movement_v1', reservedAt: 999 }) });
    const result = await reserveAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyReserved).toBe(true);
    expect(updateCalls.find((c) => (c.set as any).reservedQty != null)).toBeUndefined();
  });

  it('error если документ не assembly_consumption', async () => {
    pushHeader({ docType: 'stock_issue' });
    const result = await reserveAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('assembly_consumption');
  });

  it('error если документ не в статусе draft', async () => {
    pushHeader({ status: 'posted' });
    const result = await reserveAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('черновик');
  });

  it('error если недостаточно деталей для резерва', async () => {
    pushHeader();
    pushLines([{ lineNo: 1, qty: 10, nomenclatureId: 'nm-1', sourceWarehouseId: '11111111-1111-1111-1111-111111111111' }]);
    pushBalance([{ qty: 5, reservedQty: 1 }]); // available = 4 < 10
    const result = await reserveAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Недостаточно деталей');
  });

  it('error если документ не найден', async () => {
    selectQueue.push([]); // header не найден
    const result = await reserveAssemblyDraftReservation({ documentId: 'd-missing', actor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('не найден');
  });
});

describe('releaseAssemblyDraftReservation', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    insertCalls.length = 0;
    updateCalls.length = 0;
    vi.clearAllMocks();
  });

  it('декрементирует reservedQty на величину сохранённого резерва', async () => {
    pushHeader({ payloadJson: JSON.stringify({ module: 'parts_movement_v1', workshopWarehouseId: '11111111-1111-1111-1111-111111111111', reservedAt: 50 }) });
    pushLines([{ lineNo: 1, qty: 3, nomenclatureId: 'nm-1', sourceWarehouseId: '11111111-1111-1111-1111-111111111111' }]);
    pushBalance([{ qty: 10, reservedQty: 5 }]);
    const result = await releaseAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.released).toBe(true);
    const balanceUpdate = updateCalls.find((c) => (c.set as any).reservedQty != null);
    expect(balanceUpdate).toBeDefined();
    expect((balanceUpdate!.set as any).reservedQty).toBe(2); // 5 - 3
  });

  it('идемпотентен: если нет reservedAt — no-op', async () => {
    pushHeader({ payloadJson: JSON.stringify({ module: 'parts_movement_v1' }) });
    const result = await releaseAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.released).toBe(false);
    expect(updateCalls.find((c) => (c.set as any).reservedQty != null)).toBeUndefined();
  });

  it('clamp reservedQty к 0 если резерв уже был частично снят', async () => {
    pushHeader({ payloadJson: JSON.stringify({ module: 'parts_movement_v1', workshopWarehouseId: '11111111-1111-1111-1111-111111111111', reservedAt: 50 }) });
    pushLines([{ lineNo: 1, qty: 10, nomenclatureId: 'nm-1', sourceWarehouseId: '11111111-1111-1111-1111-111111111111' }]);
    pushBalance([{ qty: 20, reservedQty: 3 }]); // меньше чем нужно снять
    const result = await releaseAssemblyDraftReservation({ documentId: 'd1', actor });
    expect(result.ok).toBe(true);
    const balanceUpdate = updateCalls.find((c) => (c.set as any).reservedQty != null);
    expect((balanceUpdate!.set as any).reservedQty).toBe(0);
  });
});
