import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

const state = vi.hoisted(() => ({
  /** Очередь ответов `select()`: [номенклатура, локация, остатки, …]. */
  queue: [] as unknown[][],
  createdDoc: { ok: true, id: 'doc-1' } as { ok: boolean; id?: string; error?: string },
  postedDoc: { ok: true, id: 'doc-1', posted: true } as { ok: boolean; id?: string; posted?: boolean; error?: string },
  createdNomenclature: [] as Array<{ id: string; code: string; name: string; category?: string | null }>,
  locationCreated: { ok: true, id: 'loc-1' } as { ok: boolean; id?: string; error?: string },
}));

function chain() {
  const c: any = {};
  c.from = () => c;
  c.where = () => c;
  c.limit = async () => state.queue.shift() ?? [];
  c.then = (resolve: (v: unknown[]) => unknown) => resolve(state.queue.shift() ?? []);
  return c;
}

vi.mock('../database/db.js', () => ({
  db: {
    select: () => chain(),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ select: () => chain() }),
  },
  pool: { query: async () => ({ rows: [] }), end: () => undefined },
}));

vi.mock('../services/warehouseService.js', () => ({
  createWarehouseDocument: vi.fn(async () => state.createdDoc),
  postWarehouseDocument: vi.fn(async () => state.postedDoc),
  upsertWarehouseNomenclature: vi.fn(async (args: { name: string; category?: string | null }) => {
    const id = `nom-${state.createdNomenclature.length + 1}`;
    state.createdNomenclature.push({ id, code: `PPE-ST-${id}`, name: args.name, category: args.category ?? null });
    return { ok: true, id };
  }),
}));

vi.mock('../services/warehouseLocationsService.js', () => ({
  upsertWarehouseLocation: vi.fn(async () => state.locationCreated),
}));

vi.mock('../services/ppeImportService.js', () => ({
  signPpePreviewToken: (hash: string) => `tok-${hash}`,
  verifyPpePreviewToken: () => ({ ok: true, issuedAt: Date.now() }),
  sha256Hex: (buffer: Buffer) => `hash-${buffer.length}`,
}));

import { applyPpeStockImport, previewPpeStockImport } from '../services/ppeStockImportService.js';
import { createWarehouseDocument, postWarehouseDocument, upsertWarehouseNomenclature } from '../services/warehouseService.js';
import { upsertWarehouseLocation } from '../services/warehouseLocationsService.js';

const ACTOR = { id: 'u-1', username: 'klad', role: 'storekeeper' };

/** Книга с шапкой отчёта владельца: организация, заголовок, отбор, колонки, позиции, «Итого». */
async function buildReportBase64(rows: Array<Array<string | number | null>>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Лист_1');
  for (const row of rows) ws.addRow(row);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return buffer.toString('base64');
}

const REPORT_ROWS: Array<Array<string | number | null>> = [
  ['Акционерное общество "МАЛМЫЖСКИЙ ЗАВОД ПО РЕМОНТУ ДИЗЕЛЬНЫХ ДВИГАТЕЛЕЙ"'],
  ['Остатки товаров на 1 ноября 2026 г.'],
  ['Отбор: Счет Равно "10.10"'],
  [],
  ['Номенклатура', 'Единица', 'Количество', 'Сумма'],
  ['Каска РОСОМЗ СОМЗ-55 FAVORIT 75514', 'шт', 39, 9884.16],
  ['Ботинки ТОФФ ТРУД МП (42)', 'пар', 17, 30518.4],
  ['Итого', null, null, 482531.79],
];

beforeEach(() => {
  vi.clearAllMocks();
  state.queue.length = 0;
  state.createdNomenclature.length = 0;
  state.createdDoc = { ok: true, id: 'doc-1' };
  state.postedDoc = { ok: true, id: 'doc-1', posted: true };
  state.locationCreated = { ok: true, id: 'loc-1' };
});

describe('импорт остатков склада СИЗ', () => {
  it('отчёт без шапки — понятный отказ, а не «нулевой остаток»', async () => {
    const contentBase64 = await buildReportBase64([['Организация'], ['Что-то ещё']]);

    const result = await previewPpeStockImport({ filename: 'остатки.xlsx', contentBase64 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Шапка не распознана');
  });

  it('план показывает: позиция найдена, позиция новая, позиция без изменений', async () => {
    const contentBase64 = await buildReportBase64(REPORT_ROWS);
    // номенклатура → локация → остатки
    state.queue.push(
      [
        { id: 'nom-1', name: 'Каска РОСОМЗ СОМЗ-55 FAVORIT 75514', code: 'СИЗ-006' },
        { id: 'nom-2', name: 'Ботинки ТОФФ ТРУД МП (42)', code: 'СИЗ-004' },
      ],
      [{ id: 'loc-1' }],
      [{ nomenclatureId: 'nom-1', qty: 39 }],
    );

    const result = await previewPpeStockImport({ filename: 'остатки.xlsx', contentBase64 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.preview.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.action).toBe('unchanged');
    expect(rows[0]?.delta).toBe(0);
    expect(rows[1]?.action).toBe('match');
    expect(rows[1]?.currentQty).toBe(0);
    expect(rows[1]?.delta).toBe(17);
    expect(result.preview.reportDate).not.toBeNull();
    expect(result.preview.warehouse.exists).toBe(true);
  });

  it('позиция, которой нет в справочнике, помечена как новая', async () => {
    const contentBase64 = await buildReportBase64(REPORT_ROWS);
    state.queue.push([], [{ id: 'loc-1' }], []);

    const result = await previewPpeStockImport({ filename: 'остатки.xlsx', contentBase64 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.summary.create).toBe(2);
    expect(result.preview.summary.changed).toBe(2);
  });

  it('повторная загрузка того же отчёта остаток не удваивает', async () => {
    const contentBase64 = await buildReportBase64(REPORT_ROWS);
    // локация → номенклатура → остатки (остатки уже равны отчёту по обеим позициям)
    state.queue.push(
      [{ id: 'loc-1' }],
      [
        { id: 'nom-1', name: 'Каска РОСОМЗ СОМЗ-55 FAVORIT 75514', code: 'СИЗ-006' },
        { id: 'nom-2', name: 'Ботинки ТОФФ ТРУД МП (42)', code: 'СИЗ-004' },
      ],
      [
        { nomenclatureId: 'nom-1', qty: 39 },
        { nomenclatureId: 'nom-2', qty: 17 },
      ],
    );

    const result = await applyPpeStockImport({ previewId: 'tok-hash', contentBase64, actor: ACTOR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.posted).toBe(0);
    expect(result.report.documentId).toBeNull();
    expect(createWarehouseDocument).not.toHaveBeenCalled();
    expect(postWarehouseDocument).not.toHaveBeenCalled();
  });

  it('загрузка с дельтой заводит склад и проводит документ корректировки', async () => {
    const contentBase64 = await buildReportBase64(REPORT_ROWS);
    // локация → номенклатура → остатки (остаток 10 при отчёте 39)
    state.queue.push([{ id: 'loc-1' }], [{ id: 'nom-1', name: 'Каска РОСОМЗ СОМЗ-55 FAVORIT 75514', code: 'СИЗ-006' }], [{ nomenclatureId: 'nom-1', qty: 10 }]);

    const result = await applyPpeStockImport({ previewId: 'tok-hash', contentBase64, actor: ACTOR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.posted).toBe(2);
    expect(result.report.documentId).toBe('doc-1');
    expect(upsertWarehouseLocation).not.toHaveBeenCalled();

    const created = vi.mocked(createWarehouseDocument).mock.calls[0]?.[0] as any;
    expect(created.docType).toBe('stock_inventory');
    expect(created.header.warehouseId).toBe('workwear');
    const line = created.lines.find((l: any) => l.nomenclatureId === 'nom-1');
    expect(line.adjustmentQty).toBe(29);
    expect(line.bookQty).toBe(10);
    expect(line.actualQty).toBe(39);
    expect(postWarehouseDocument).toHaveBeenCalledTimes(1);
  });

  it('склада СИЗ нет — он заводится при первой загрузке', async () => {
    const contentBase64 = await buildReportBase64(REPORT_ROWS);
    // локация (пусто) → номенклатура → остатки
    state.queue.push([], [{ id: 'nom-1', name: 'Каска РОСОМЗ СОМЗ-55 FAVORIT 75514', code: 'СИЗ-006' }], [{ nomenclatureId: 'nom-1', qty: 39 }]);

    const result = await applyPpeStockImport({ previewId: 'tok-hash', contentBase64, actor: ACTOR });

    expect(result.ok).toBe(true);
    expect(upsertWarehouseLocation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertWarehouseLocation).mock.calls[0]?.[0]).toMatchObject({ code: 'workwear', type: 'regular' });
  });

  it('новая позиция заводится с категорией workwear', async () => {
    const contentBase64 = await buildReportBase64(REPORT_ROWS);
    // локация → номенклатура (пусто) → остатки
    state.queue.push([{ id: 'loc-1' }], [], []);

    const result = await applyPpeStockImport({ previewId: 'tok-hash', contentBase64, actor: ACTOR });

    expect(result.ok).toBe(true);
    expect(vi.mocked(upsertWarehouseNomenclature).mock.calls[0]?.[0]).toMatchObject({ category: 'workwear' });
  });
});
