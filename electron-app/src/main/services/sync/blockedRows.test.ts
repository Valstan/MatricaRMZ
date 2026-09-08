import { SyncTableName } from '@matricarmz/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  BLOCKED_ROWS_CAP,
  blockedIdsForTable,
  isRowBlocked,
  mergeBlockedRows,
  parseBlockedRows,
  releaseResolvedBlockedRows,
  serializeBlockedRows,
  type BlockedRowInput,
} from './blockedRows.js';
import { DEPENDENCY_TABLE } from './dependencyRequeue.js';

const input = (id: string, missingId: string): BlockedRowInput => ({
  table: SyncTableName.Operations,
  id,
  dependency: 'engine_entity',
  missingId,
});

describe('mergeBlockedRows', () => {
  it('новая строка попадает в карантин и возвращается как added — доклад шлётся один раз', () => {
    const first = mergeBlockedRows([], [input('op-1', 'eng-1')], 1000);
    expect(first.added).toHaveLength(1);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.since).toBe(1000);

    const second = mergeBlockedRows(first.rows, [input('op-1', 'eng-1')], 2000);
    expect(second.added).toHaveLength(0);
    expect(second.rows).toHaveLength(1);
    // повтор не сдвигает since: карантин помнит, когда строка залипла впервые
    expect(second.rows[0]?.since).toBe(1000);
  });

  it('одна и та же строка в разных таблицах — разные записи', () => {
    const { rows } = mergeBlockedRows(
      [],
      [input('row-1', 'eng-1'), { table: SyncTableName.Entities, id: 'row-1', dependency: 'entity_type', missingId: 't-1' }],
      1,
    );
    expect(rows).toHaveLength(2);
    expect(isRowBlocked(rows, SyncTableName.Operations, 'row-1')).toBe(true);
    expect(isRowBlocked(rows, SyncTableName.Entities, 'row-1')).toBe(true);
    expect(isRowBlocked(rows, SyncTableName.AuditLog, 'row-1')).toBe(false);
  });

  it('на потолке новые НЕ вытесняют старых: вытесненная строка вернулась бы в вечный цикл', () => {
    const existing = mergeBlockedRows(
      [],
      Array.from({ length: BLOCKED_ROWS_CAP }, (_, i) => input(`op-${i}`, 'eng-1')),
      1,
    ).rows;
    const { rows, added, overflow } = mergeBlockedRows(existing, [input('op-new', 'eng-2')], 2);
    expect(overflow).toBe(1);
    expect(added).toHaveLength(0);
    expect(rows).toHaveLength(BLOCKED_ROWS_CAP);
    expect(isRowBlocked(rows, SyncTableName.Operations, 'op-0')).toBe(true);
    expect(isRowBlocked(rows, SyncTableName.Operations, 'op-new')).toBe(false);
  });

  it('строка неизвестной таблицы игнорируется', () => {
    const { rows } = mergeBlockedRows([], [{ table: 'not_a_table' as never, id: 'x', dependency: 'd', missingId: 'm' }], 1);
    expect(rows).toHaveLength(0);
  });
});

describe('parseBlockedRows', () => {
  it('переживает круг сериализации', () => {
    const { rows } = mergeBlockedRows([], [input('op-1', 'eng-1')], 42);
    expect(parseBlockedRows(serializeBlockedRows(rows))).toEqual(rows);
  });

  it('битое или чужое значение читается как пустой карантин, а не роняет синк', () => {
    expect(parseBlockedRows(null)).toEqual([]);
    expect(parseBlockedRows('')).toEqual([]);
    expect(parseBlockedRows('{ не json')).toEqual([]);
    expect(parseBlockedRows('{"a":1}')).toEqual([]);
    expect(parseBlockedRows('[{"table":"operations"}]')).toEqual([]);
  });

  it('дубли в хранилище схлопываются', () => {
    const raw = JSON.stringify([
      { table: SyncTableName.Operations, id: 'op-1', dependency: 'engine_entity', missingId: 'eng-1', since: 1 },
      { table: SyncTableName.Operations, id: 'op-1', dependency: 'engine_entity', missingId: 'eng-1', since: 2 },
    ]);
    expect(parseBlockedRows(raw)).toHaveLength(1);
  });
});

describe('blockedIdsForTable', () => {
  it('отдаёт id только своей таблицы — по нему recoverErroredRows пропускает карантин', () => {
    const { rows } = mergeBlockedRows(
      [],
      [input('op-1', 'eng-1'), { table: SyncTableName.Entities, id: 'ent-1', dependency: 'entity_type', missingId: 't-1' }],
      1,
    );
    expect([...blockedIdsForTable(rows, SyncTableName.Operations)]).toEqual(['op-1']);
    expect([...blockedIdsForTable(rows, SyncTableName.Entities)]).toEqual(['ent-1']);
    expect([...blockedIdsForTable(rows, SyncTableName.ChatMessages)]).toEqual([]);
  });
});

describe('releaseResolvedBlockedRows', () => {
  it('зависимость появилась локально → строка отпускается обратно в очередь', async () => {
    const { rows } = mergeBlockedRows([], [input('op-1', 'eng-1')], 1);
    const { blocked, released } = await releaseResolvedBlockedRows(rows, async () => true, DEPENDENCY_TABLE);
    expect(released).toHaveLength(1);
    expect(blocked).toHaveLength(0);
  });

  it('зависимости по-прежнему нет → строка остаётся в карантине', async () => {
    const { rows } = mergeBlockedRows([], [input('op-1', 'eng-1')], 1);
    const { blocked, released } = await releaseResolvedBlockedRows(rows, async () => false, DEPENDENCY_TABLE);
    expect(released).toHaveLength(0);
    expect(blocked).toHaveLength(1);
  });

  it('одна зависимость — одна проверка, сколько бы строк на неё ни ссылалось', async () => {
    const { rows } = mergeBlockedRows([], [input('op-1', 'eng-1'), input('op-2', 'eng-1')], 1);
    const exists = vi.fn(async () => true);
    const { released } = await releaseResolvedBlockedRows(rows, exists, DEPENDENCY_TABLE);
    expect(released).toHaveLength(2);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('зависимость, которую клиент не создаёт (аккаунт), из карантина не выходит', async () => {
    const { rows } = mergeBlockedRows(
      [],
      [{ table: SyncTableName.ChatMessages, id: 'm-1', dependency: 'recipient_user', missingId: 'u-1' }],
      1,
    );
    const exists = vi.fn(async () => true);
    const { blocked, released } = await releaseResolvedBlockedRows(rows, exists, DEPENDENCY_TABLE);
    expect(exists).not.toHaveBeenCalled();
    expect(released).toHaveLength(0);
    expect(blocked).toHaveLength(1);
  });

  it('падение проверки существования не отпускает строку', async () => {
    const { rows } = mergeBlockedRows([], [input('op-1', 'eng-1')], 1);
    const { blocked, released } = await releaseResolvedBlockedRows(
      rows,
      async () => {
        throw new Error('db is busy');
      },
      DEPENDENCY_TABLE,
    );
    expect(released).toHaveLength(0);
    expect(blocked).toHaveLength(1);
  });
});
