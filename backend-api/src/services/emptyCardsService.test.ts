import { describe, expect, it, vi } from 'vitest';

// Модуль тянет db на импорте — для чистого хелпера соединение не нужно.
vi.mock('../database/db.js', () => ({ db: {} }));

import { selectEmptyAssemblyBomRows } from './emptyCardsService.js';

function bom(id: string, name: string, createdAt = 1_700_000_000_000) {
  return { id, name, createdAt };
}

describe('selectEmptyAssemblyBomRows', () => {
  it('BOM без строк попадает в пустые', () => {
    const rows = selectEmptyAssemblyBomRows([bom('a', 'BOM В-84')], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', kind: 'assembly_bom', label: 'BOM В-84' });
  });

  it('BOM со строками не попадает', () => {
    expect(selectEmptyAssemblyBomRows([bom('a', 'BOM В-84')], ['a'])).toHaveLength(0);
  });

  it('заполненная шапка не спасает: пустота BOM определяется ТОЛЬКО отсутствием строк', () => {
    // Ровно прод-случай 01.07–30.07: дубль «BOM В-84» имел имя и связку с маркой,
    // но 0 строк — и месяц не попадался ни одному детектору.
    const rows = selectEmptyAssemblyBomRows([bom('real', 'BOM В-84'), bom('dupe', 'BOM В-84')], ['real']);
    expect(rows.map((r) => r.id)).toEqual(['dupe']);
  });

  it('без имени подписывается хвостом id — оператору есть за что зацепиться', () => {
    const rows = selectEmptyAssemblyBomRows([bom('0123456789abcdef', '   ')], []);
    expect(rows[0]?.label).toBe('…abcdef');
  });

  it('id сравниваются как строки — сет строк не «теряет» BOM из-за типа', () => {
    expect(selectEmptyAssemblyBomRows([bom('7', 'BOM')], [7])).toHaveLength(0);
  });

  it('пустой список BOM ничего не даёт', () => {
    expect(selectEmptyAssemblyBomRows([], ['a'])).toEqual([]);
  });
});
