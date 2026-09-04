import { relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  backupDirAllowed,
  buildProjectionFromPg,
  diffStates,
  formatTableDiff,
  parseResnapshotArgs,
  projectionRow,
} from './resnapshotLedgerStatePlan.js';

const LEDGER = 'D:\\srv\\matricarmz-ledger';

describe('parseResnapshotArgs', () => {
  it('по умолчанию — только сверка, без записи', () => {
    expect(parseResnapshotArgs([])).toEqual({ apply: false, backupDir: '', chainRebuiltPath: '', reportPath: '' });
  });

  it('--apply без --backup-dir отвергается: запись без бэкапа не делается', () => {
    expect(() => parseResnapshotArgs(['--apply'])).toThrow(/--backup-dir/);
  });

  it('неизвестный аргумент — ошибка, а не молчаливое игнорирование', () => {
    expect(() => parseResnapshotArgs(['--force'])).toThrow(/неизвестный аргумент/);
  });
});

describe('backupDirAllowed — бэкап только снаружи каталога леджера', () => {
  it('сам каталог и его подкаталоги отвергаются', () => {
    expect(backupDirAllowed(LEDGER, LEDGER, relative)).toBe(false);
    expect(backupDirAllowed(`${LEDGER}\\backup`, LEDGER, relative)).toBe(false);
  });
  it('соседний каталог и другой диск разрешены', () => {
    expect(backupDirAllowed('D:\\srv\\ledger-fix-backup', LEDGER, relative)).toBe(true);
    expect(backupDirAllowed('E:\\tmp', LEDGER, relative)).toBe(true);
  });
});

describe('projectionRow — форма строки как после applyTx', () => {
  it('updated_at берётся из строки', () => {
    expect(projectionRow({ id: 'a', updated_at: 5 })).toEqual({ id: 'a', updated_at: 5 });
  });
  it('без updated_at — performed_at, затем created_at, чтобы поле не стало null', () => {
    expect(projectionRow({ id: 'm', performed_at: 7, created_at: 3 }).updated_at).toBe(7);
    expect(projectionRow({ id: 'm', created_at: 3 }).updated_at).toBe(3);
  });
});

const enc = (row: Record<string, unknown>) =>
  typeof row.meta_json === 'string' && !String(row.meta_json).startsWith('enc:') ? { ...row, meta_json: `enc:${row.meta_json}` } : row;
const dec = (row: Record<string, unknown>) =>
  typeof row.meta_json === 'string' && String(row.meta_json).startsWith('enc:') ? { ...row, meta_json: String(row.meta_json).slice(4) } : row;

describe('buildProjectionFromPg', () => {
  const live = {
    tables: {
      operations: { o1: { id: 'o1', meta_json: 'enc:{"old":1}', updated_at: 1 }, o2: { id: 'o2', updated_at: 1 } },
      release_registry: { r1: { id: 'r1', updated_at: 10 } },
      empty_one: {},
    },
  } as any;

  it('PG-таблицы берутся из PostgreSQL целиком: лишнее из проекции уходит, недостающее приходит, чувствительные поля шифруются', () => {
    const r = buildProjectionFromPg({
      pgTables: { operations: [{ id: 'o1', meta_json: '{"new":1}', updated_at: 2 }, { id: 'o3', meta_json: '{}', updated_at: 3 }] },
      live,
      encryptRow: enc,
    });
    expect(r.fromPg).toEqual(['operations']);
    expect(Object.keys(r.state.tables.operations as any).sort()).toEqual(['o1', 'o3']);
    expect((r.state.tables.operations as any).o1).toEqual({ id: 'o1', meta_json: 'enc:{"new":1}', updated_at: 2 });
  });

  it('таблицы без PG-источника сохраняются из живой проекции как есть, включая пустые', () => {
    const r = buildProjectionFromPg({ pgTables: { operations: [] }, live, encryptRow: enc });
    expect(r.keptFromLive).toEqual(['empty_one', 'release_registry']);
    expect(r.state.tables.release_registry).toEqual(live.tables.release_registry);
    expect((r.state.tables as any).empty_one).toEqual({});
    expect(r.mergedFromChain).toEqual({});
  });

  it('пересборка из цепочки добирает в ledger-only таблицы только недостающее или более новое — и не трогает PG-таблицы', () => {
    const chain = {
      tables: {
        release_registry: { r1: { id: 'r1', updated_at: 5 }, r2: { id: 'r2', updated_at: 20 }, r3: { id: 'r3', updated_at: 1 } },
        operations: { ghost: { id: 'ghost', updated_at: 99 } },
      },
    } as any;
    const r = buildProjectionFromPg({ pgTables: { operations: [] }, live, chainRebuilt: chain, encryptRow: enc });
    const rr = r.state.tables.release_registry as any;
    expect(rr.r1.updated_at).toBe(10);
    expect(rr.r2.updated_at).toBe(20);
    expect(rr.r3.updated_at).toBe(1);
    expect(r.mergedFromChain).toEqual({ release_registry: 2 });
    expect(r.state.tables.operations).toEqual({});
  });

  it('строка без id пропускается', () => {
    const r = buildProjectionFromPg({ pgTables: { operations: [{ updated_at: 1 } as any] }, live, encryptRow: enc });
    expect(r.state.tables.operations).toEqual({});
  });
});

describe('diffStates — сверка по открытому тексту', () => {
  it('разный шифротекст одного и того же значения — не расхождение', () => {
    const a = { tables: { operations: { o1: { id: 'o1', meta_json: 'enc:{"x":1}', updated_at: 1 } } } } as any;
    const b = { tables: { operations: { o1: { id: 'o1', meta_json: '{"x":1}', updated_at: 1 } } } } as any;
    expect(diffStates(a, b, dec)).toEqual([]);
  });

  it('считает только-слева, только-справа и разные строки, называет поля', () => {
    const a = { tables: { t: { a: { id: 'a', v: 1 }, b: { id: 'b', v: 1 } } } } as any;
    const b = { tables: { t: { b: { id: 'b', v: 2 }, c: { id: 'c', v: 1 } }, u: { x: { id: 'x' } } } } as any;
    const d = diffStates(a, b, (r) => r);
    expect(d.map((x) => x.table)).toEqual(['t', 'u']);
    expect(d[0]).toMatchObject({ onlyLeft: 1, onlyRight: 1, differing: 1, fields: { v: 1 }, sampleDiffering: ['b'] });
    expect(d[1]).toMatchObject({ left: 0, right: 1, onlyRight: 1 });
    expect(formatTableDiff(d[0]!)).toContain('толькоPG=1 толькоState=1 разных=1');
  });
});
