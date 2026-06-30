import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Регресс-тест атомарности `createWarehouseDocument` (parts-chain-audit Stage C).
 *
 * Баг: header + lines + planned_incoming писались тремя отдельными запросами без
 * транзакции. Если planned_incoming падал на FK `erp_planned_incoming_nomenclature_id_fkey`
 * (строка ссылается на orphan-id, у которого нет `erp_nomenclature`), шапка и строки уже
 * были закоммичены → «висячий» документ без planned_incoming.
 *
 * Стратегия мока: моделируем семантику транзакции и FK.
 *  • Глобальный `db.insert(...).values(...)` пишет «сразу» в `state.committed` (имитация
 *    записи вне транзакции — так делал баг).
 *  • `db.transaction(fn)` копит записи в локальный staged-буфер и переносит их в
 *    `state.committed` только если `fn` зарезолвился; на throw — отбрасывает (откат).
 *  • Любой insert строки planned_incoming с orphan-`nomenclatureId` бросает FK-ошибку —
 *    одинаково и для глобального `db`, и для `tx` (FK в БД срабатывает независимо от пути).
 *
 * За счёт этого тест ловит регресс: при возврате к не-транзакционной записи шапка попадёт
 * в `state.committed` до падения planned_incoming → в сторе окажется 1 строка → тест упадёт.
 */

const state = vi.hoisted(() => ({
  ORPHAN: 'orphan-no-nomenclature-row',
  committed: [] as Array<{ table: unknown; values: unknown }>,
}));

vi.mock('../database/db.js', () => {
  function makeSelectChain() {
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(async () => []),
      limit: vi.fn(async () => []),
      then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => Promise.resolve([]).then(resolve, reject),
    };
    return chain;
  }
  // planned_incoming строки имеют top-level nomenclatureId; lines/headers/journal — нет.
  function failsForeignKey(values: unknown): boolean {
    const rows = Array.isArray(values) ? values : [values];
    return rows.some((r) => r != null && typeof r === 'object' && (r as Record<string, unknown>).nomenclatureId === state.ORPHAN);
  }
  const FK_ERROR =
    'Failed query: insert into erp_planned_incoming ... violates foreign key constraint "erp_planned_incoming_nomenclature_id_fkey"';

  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        if (failsForeignKey(values)) throw new Error(FK_ERROR);
        state.committed.push({ table, values });
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Array<{ table: unknown; values: unknown }> = [];
      const tx: any = {
        select: vi.fn(() => makeSelectChain()),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn(async (values: unknown) => {
            if (failsForeignKey(values)) throw new Error(FK_ERROR);
            staged.push({ table, values });
          }),
        })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
        delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      };
      const result = await fn(tx); // throw здесь → откат: staged отбрасывается, ошибка наружу
      state.committed.push(...staged);
      return result;
    }),
  };
  return { db };
});

vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed: vi.fn(),
}));

import { erpDocumentHeaders, erpDocumentLines, erpJournalDocuments, erpPlannedIncoming } from '../database/schema.js';
import { createWarehouseDocument } from '../services/warehouseService.js';

const actor = { id: 'u1', username: 'tester', role: 'admin' };

function committedFor(table: unknown): unknown[] {
  return state.committed.filter((c) => c.table === table).map((c) => c.values);
}

beforeEach(() => {
  state.committed.length = 0;
  vi.clearAllMocks();
});

describe('createWarehouseDocument — атомарность header/lines/planned_incoming', () => {
  it('orphan nomenclatureId: FK на planned_incoming откатывает весь документ (0 строк в erp_document_headers)', async () => {
    const result = await createWarehouseDocument({
      docType: 'production_release',
      status: 'planned',
      docNo: 'REP-ORPHAN-1',
      docDate: 1_700_000_000_000,
      payloadJson: JSON.stringify({ warehouseId: 'default', expectedDate: 1_700_000_000_000 }),
      lines: [{ qty: 1, nomenclatureId: state.ORPHAN }],
      actor,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('erp_planned_incoming');
    // Главное: документ не остался «висячим».
    expect(committedFor(erpDocumentHeaders)).toHaveLength(0);
    expect(committedFor(erpDocumentLines)).toHaveLength(0);
    expect(committedFor(erpPlannedIncoming)).toHaveLength(0);
    expect(committedFor(erpJournalDocuments)).toHaveLength(0);
  });

  it('валидный nomenclatureId: документ коммитится целиком (header + planned_incoming + journal)', async () => {
    const result = await createWarehouseDocument({
      docType: 'production_release',
      status: 'planned',
      docNo: 'REP-OK-1',
      docDate: 1_700_000_000_000,
      payloadJson: JSON.stringify({ warehouseId: 'default', expectedDate: 1_700_000_000_000 }),
      lines: [{ qty: 1, nomenclatureId: 'real-nomenclature-id' }],
      actor,
    });

    expect(result.ok).toBe(true);
    expect(committedFor(erpDocumentHeaders)).toHaveLength(1);
    expect(committedFor(erpPlannedIncoming)).toHaveLength(1);
    expect(committedFor(erpJournalDocuments)).toHaveLength(1);
  });
});
