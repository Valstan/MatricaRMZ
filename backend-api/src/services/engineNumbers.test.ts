import { beforeEach, describe, expect, it, vi } from 'vitest';

// Сверка номеров РМЗ — единственная ветка, которая и выдаёт номера, и провожает удалённые
// карточки. Проверяем ровно два инварианта, ради которых она задумана:
//   1) номер выдаётся живому двигателю, а не строке реестра сама по себе;
//   2) удаление карточки НЕ удаляет строку реестра — номер остаётся навсегда со снимком.
// Слой БД подменён: запросы сервиса — цепочки drizzle, их форма проверяется побочно
// (если цепочка не соберётся, мок бросит), а поведение — по тому, что уходит в журнал.

const S = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    candidates: [] as Row[],
    stale: [] as Row[],
    audit: [] as Row[],
    creators: [] as Row[],
    deleters: [] as Row[],
    snapshots: [] as Row[],
    seqs: [] as number[],
    writes: [] as Array<{ inputs: Array<Record<string, unknown>>; opts: Record<string, unknown> }>,
  };

  const tableName = (table: unknown): string => {
    const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes('Name'));
    return sym ? String((table as Record<symbol, unknown>)[sym]) : '';
  };

  /** Значения из SQL-условия: по ним видно, какую операцию журнала спрашивают. */
  const collectStrings = (value: unknown, depth = 0, seen = new Set<unknown>()): string[] => {
    if (depth > 8 || value == null || typeof value === 'number') return [];
    if (typeof value === 'string') return [value];
    if (typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    const out: string[] = [];
    for (const v of Object.values(value as Record<string, unknown>)) {
      out.push(...collectStrings(v, depth + 1, seen));
    }
    return out;
  };

  const rowsFor = (name: string, whereArgs: unknown[]): Row[] => {
    switch (name) {
      case 'entities':
        return state.candidates;
      case 'erp_engine_numbers':
        return state.stale;
      case 'audit_log':
        return state.audit;
      case 'erp_engine_cards':
        return state.snapshots;
      case 'ledger_tx_index': {
        // Сервис спрашивает журнал дважды — авторы создания и авторы удаления строки
        // `entities`; различаем по значению op в условии, а не по порядку вызовов.
        const values = whereArgs.flatMap((a) => collectStrings(a));
        return values.includes('delete') ? state.deleters : state.creators;
      }
      default:
        throw new Error(`неожидаемый запрос к таблице ${name}`);
    }
  };

  const makeBuilder = (table: unknown) => {
    const b: Record<string, unknown> = {};
    const whereArgs: unknown[] = [];
    const self = () => b;
    b['from'] = (t: unknown) => {
      b['_table'] = t;
      return b;
    };
    b['innerJoin'] = self;
    b['leftJoin'] = self;
    b['where'] = (...args: unknown[]) => {
      whereArgs.push(...args);
      return b;
    };
    b['orderBy'] = self;
    b['limit'] = self;
    b['then'] = (resolve: (rows: Row[]) => void) => resolve(rowsFor(tableName(table), whereArgs));
    return b;
  };

  const db = {
    select: () => ({ from: (t: unknown) => makeBuilder(t) }),
    execute: async () => ({ rows: state.seqs.map((seq) => ({ seq })) }),
  };

  return { state, db };
});

vi.mock('../database/db.js', () => ({ db: S.db, pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock('./sync/syncWriteService.js', () => ({
  writeSyncChanges: vi.fn(
    async (inputs: Array<Record<string, unknown>>, _actor: unknown, opts: Record<string, unknown>) => {
      S.state.writes.push({ inputs, opts });
      return {
        dbApplied: inputs.length,
        ledgerApplied: inputs.length,
        lastSeq: 0,
        blockHeight: 0,
        appliedRows: [],
        idRemaps: { entity_types: {}, attribute_defs: {} },
        skipped: [],
      };
    },
  ),
}));

import { reconcileEngineNumbers } from './engineNumbersService.js';

const ALIVE_ID = '11111111-1111-4111-8111-111111111111';
const DEAD_ID = '22222222-2222-4222-8222-222222222222';

function reset() {
  const s = S.state;
  s.candidates = [];
  s.stale = [];
  s.audit = [];
  s.creators = [];
  s.deleters = [];
  s.snapshots = [];
  s.seqs = [];
  s.writes = [];
}

describe('reconcileEngineNumbers', () => {
  beforeEach(reset);

  it('выдаёт номер живому двигателю и провожает удалённый, не удаляя строку реестра', async () => {
    S.state.candidates = [
      { id: ALIVE_ID, createdAt: 1_700_000_000_000, arrivalDate: 1_600_000_000_000 },
    ];
    S.state.stale = [
      { id: DEAD_ID, seq: 7, createdAt: 1_650_000_000_000, createdBy: 'oper', deletedAt: 1_690_000_000_000 },
    ];
    S.state.audit = [
      { entityId: DEAD_ID, payload: JSON.stringify({ reason: 'Заведена дважды, ошиблись маркой' }) },
    ];
    S.state.creators = [{ rowId: ALIVE_ID, actor: 'buh' }];
    S.state.deleters = [{ rowId: DEAD_ID, actor: 'master' }];
    S.state.snapshots = [{ id: DEAD_ID, engineNumber: 'A-77' }];
    S.state.seqs = [42];

    const result = await reconcileEngineNumbers();

    expect(result).toMatchObject({ issued: 1, markedDeleted: 1, busy: false });

    const [deletedWrite, issuedWrite] = S.state.writes;
    expect(S.state.writes).toHaveLength(2);

    // Удаление — это статус строки реестра, а не tombstone: номер остаётся выданным.
    const deletedInput = deletedWrite!.inputs[0]!;
    expect(deletedInput['type']).toBe('upsert');
    expect(deletedInput['table']).toBe('erp_engine_numbers');
    expect(deletedInput['row_id']).toBe(DEAD_ID);
    const deletedRow = deletedInput['row'] as Record<string, unknown>;
    expect(deletedRow).toMatchObject({
      id: DEAD_ID,
      seq: 7,
      status: 'deleted',
      created_by: 'oper',
      card_deleted_at: 1_690_000_000_000,
      card_deleted_by: 'master',
      delete_reason: 'Заведена дважды, ошиблись маркой',
      deleted_at: null,
    });
    expect(String(deletedRow['snapshot_json'])).toContain('A-77');

    const issuedRow = issuedWrite!.inputs[0]!['row'] as Record<string, unknown>;
    expect(issuedRow).toMatchObject({
      id: ALIVE_ID,
      seq: 42,
      status: 'active',
      created_by: 'buh',
      created_at: 1_700_000_000_000,
      deleted_at: null,
    });

    // Обе записи идут штатным путём синхронизации и не служат поводом для новой сверки.
    for (const write of S.state.writes) {
      expect(write.opts['allowSyncConflicts']).toBe(true);
      expect(write.opts['skipEngineNumberReconcile']).toBe(true);
    }
  });

  it('ничего не пишет, когда выдавать и провожать некого', async () => {
    const result = await reconcileEngineNumbers();
    expect(result).toMatchObject({ issued: 0, markedDeleted: 0, busy: false });
    expect(S.state.writes).toHaveLength(0);
  });

  it('второй одновременный проход уступает первому, а не дублирует выдачу', async () => {
    S.state.candidates = [{ id: ALIVE_ID, createdAt: 1, arrivalDate: null }];
    S.state.seqs = [1];

    const [first, second] = await Promise.all([reconcileEngineNumbers(), reconcileEngineNumbers()]);

    const busy = [first, second].filter((r) => r.busy);
    expect(busy).toHaveLength(1);
    // Помечать было нечего — запись одна: выдача номера. Второй проход не выдал ничего.
    expect(S.state.writes).toHaveLength(1);
    expect(S.state.writes[0]!.inputs).toHaveLength(1);
  });
});
