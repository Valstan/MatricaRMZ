import { describe, expect, it, vi } from 'vitest';

import { directoryPartIdentityKey } from '@matricarmz/shared';

// Блок «In-place присвоение артикула» не должен усыновлять строку-родителя
// (у неё есть варианты): присвоение артикула сняло бы родительский статус.
// Родитель пропускается и печатается «родитель пропущен», остальные правила
// владельца (первый артикул имени — существующей без артикула) не меняются.

vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { selectAdoptions } = await import('./importBasePartsList.js');

function normName(s: string): string {
  return directoryPartIdentityKey(s, null).split('|')[0] ?? '';
}

function targetsOf(rows: Array<{ name: string; code: string | null }>) {
  return new Map(rows.map((t) => [directoryPartIdentityKey(t.name, t.code), { name: t.name, code: t.code }]));
}

describe('selectAdoptions — родитель не усыновляется', () => {
  it('строка с вариантами пропускается и попадает в отчёт', () => {
    const name = 'Прокладка';
    const { adoptions, adoptedKeys, skippedParents } = selectAdoptions({
      targets: targetsOf([{ name, code: 'A-123' }]),
      existingByName: new Map([[normName(name), [{ id: 'p1', name, code: null }]]]),
      existingByKey: new Map(),
      parentIds: new Set(['p1']),
    });
    expect(adoptions).toEqual([]);
    expect(adoptedKeys.size).toBe(0);
    expect(skippedParents).toEqual([{ existingId: 'p1', name, codes: ['A-123'] }]);
  });

  it('обычная деталь без артикула усыновляется как раньше', () => {
    const name = 'Прокладка';
    const key = directoryPartIdentityKey(name, 'A-123');
    const { adoptions, adoptedKeys, skippedParents } = selectAdoptions({
      targets: targetsOf([{ name, code: 'A-123' }]),
      existingByName: new Map([[normName(name), [{ id: 'p1', name, code: null }]]]),
      existingByKey: new Map(),
      parentIds: new Set(),
    });
    expect(adoptions).toEqual([{ existingId: 'p1', name, code: 'A-123', targetKey: key }]);
    expect([...adoptedKeys]).toEqual([key]);
    expect(skippedParents).toEqual([]);
  });

  it('без parentIds — прежнее поведение побайтово', () => {
    const name = 'Прокладка';
    const key = directoryPartIdentityKey(name, 'A-123');
    const args = {
      targets: targetsOf([{ name, code: 'A-123' }]),
      existingByName: new Map([[normName(name), [{ id: 'p1', name, code: null }]]]),
      existingByKey: new Map(),
    };
    const r = selectAdoptions(args);
    expect(r.adoptions).toEqual([{ existingId: 'p1', name, code: 'A-123', targetKey: key }]);
    expect(r.skippedParents).toEqual([]);
  });

  it('родитель первым в очереди — второй пустой ряд не подхватывается молча', () => {
    const name = 'Прокладка';
    const { adoptions, skippedParents } = selectAdoptions({
      targets: targetsOf([{ name, code: 'A-123' }]),
      existingByName: new Map([
        [normName(name), [{ id: 'p1', name, code: null }, { id: 'p2', name, code: null }]],
      ]),
      existingByKey: new Map(),
      parentIds: new Set(['p1']),
    });
    expect(adoptions).toEqual([]);
    expect(skippedParents).toHaveLength(1);
  });
});
