import { beforeEach, describe, expect, it, vi } from 'vitest';

// Справочник узлов ведомостей (15.09.2026). Проверяем правила, которые не видят типы:
// код у существующего узла не меняется, у нового — из названия; дубль кода отбивается;
// колонки принимаются только через общий санитайзер; архив — не удаление.
//
// Правка существующего узла делает ДВА чтения: сам узел и строки, которыми он уже заполнен
// (гейт смены типа колонки). Поэтому в очередь `selects` кладутся оба.

const state = vi.hoisted(() => ({
  selects: [] as any[][],
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../database/db.js', () => {
  const chain = (rows: () => any[]) => {
    const c: any = {
      from: () => c,
      where: () => c,
      limit: () => c,
      orderBy: () => c,
      then: (res: (v: any[]) => any, rej?: (e: any) => any) => Promise.resolve(rows()).then(res, rej),
    };
    return c;
  };
  const db = {
    select: vi.fn(() => chain(() => state.selects.shift() ?? [])),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        state.updates.push(patch);
        const c: any = { where: () => c, returning: async () => [{ id: 'T1', code: 'obkatka', name: String(patch.name ?? 'x'), completesRepair: patch.completesRepair ?? false, columnsJson: patch.columnsJson ?? '[]', sortOrder: 40, updatedAt: 1, archivedAt: patch.archivedAt ?? null }], then: (r: any) => Promise.resolve(undefined).then(r) };
        return c;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        state.inserts.push(row);
        return { returning: async () => [{ id: 'NEW', ...row, archivedAt: null }] };
      }),
    })),
  };
  return { db };
});

import { archiveWorkSheetType, upsertWorkSheetType } from './workSheetTypeService.js';

beforeEach(() => {
  state.selects = [];
  state.updates = [];
  state.inserts = [];
});

describe('узел ведомости', () => {
  it('новый узел получает код из названия и следующий порядок', async () => {
    state.selects.push([]); // дубля кода нет
    state.selects.push([{ sortOrder: 40 }]); // максимум порядка
    const r = await upsertWorkSheetType({ name: 'Балансировка вала', columns: [{ label: 'Дисбаланс, г', type: 'number' }], actor: 'ivanov' });
    expect(r.ok).toBe(true);
    expect(state.inserts[0]?.code).toBe('balansirovka_vala');
    expect(state.inserts[0]?.sortOrder).toBe(50);
    expect(JSON.parse(String(state.inserts[0]?.columnsJson))).toEqual([{ code: 'disbalans_g', label: 'Дисбаланс, г', type: 'number' }]);
  });

  it('дубль кода отбивается словами', async () => {
    state.selects.push([{ id: 'X' }]);
    const r = await upsertWorkSheetType({ name: 'Обкатка', code: 'obkatka' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('obkatka');
  });

  it('у существующего узла код не трогается, а колонки чистятся', async () => {
    state.selects.push([{ id: 'T1', code: 'obkatka', updatedAt: 1 }]);
    state.selects.push([]); // строк этого узла ещё нет
    const r = await upsertWorkSheetType({ id: 'T1', name: 'Обкатка', code: 'other', completesRepair: true, columns: [{ code: 'hours', label: 'Часы', type: 'weird' }] });
    expect(r.ok).toBe(true);
    expect(state.updates[0]).not.toHaveProperty('code');
    expect(JSON.parse(String(state.updates[0]?.columnsJson))[0]?.type).toBe('text');
    if (r.ok) expect(r.row.completesRepair).toBe(true);
  });

  // Гейт спрашивает САМИ СТРОКИ, а не прежний набор колонок: сравнение с прежним набором
  // обходится в два сохранения (удалить колонку → завести заново с тем же кодом и другим
  // типом), и старые значения молча меняют смысл.
  it('смена типа колонки, которой уже заполнены строки, отбивается словами', async () => {
    state.selects.push([{ id: 'T1', code: 'obkatka', updatedAt: 1 }]);
    state.selects.push([
      { metaJson: JSON.stringify({ kind: 'repair_history', action: 'Обкатка', sheet: { typeId: 'T1', typeCode: 'obkatka', typeName: 'Обкатка', fields: [{ code: 'hours', label: 'Часы', type: 'number', value: 4 }] } }) },
      { metaJson: JSON.stringify({ kind: 'repair_history', action: 'Обкатка', sheet: { typeId: 'T1', typeCode: 'obkatka', typeName: 'Обкатка', fields: [{ code: 'hours', label: 'Часы', type: 'number', value: 6 }] } }) },
    ]);
    const r = await upsertWorkSheetType({ id: 'T1', name: 'Обкатка', columns: [{ code: 'hours', label: 'Часы', type: 'text' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Часы');
      expect(r.error, 'сказано, сколько строк уже заполнено').toContain('2');
      expect(r.error).toContain('Число');
    }
    expect(state.updates).toHaveLength(0);
  });

  it('удалить колонку и завести заново с другим типом — тот же отказ (обход в два сохранения)', async () => {
    state.selects.push([{ id: 'T1', code: 'obkatka', updatedAt: 1 }]);
    // Прежнего набора колонок у узла уже нет — колонку «удалили» первым сохранением.
    state.selects.push([
      { metaJson: JSON.stringify({ kind: 'repair_history', action: 'Обкатка', sheet: { typeId: 'T1', typeCode: 'obkatka', typeName: 'Обкатка', fields: [{ code: 'hours', label: 'Часы', type: 'number', value: 4 }] } }) },
    ]);
    const r = await upsertWorkSheetType({ id: 'T1', name: 'Обкатка', columns: [{ code: 'hours', label: 'Часы', type: 'text' }] });
    expect(r.ok).toBe(false);
  });

  it('тот же тип у заполненной колонки проходит — правится подпись, не смысл', async () => {
    state.selects.push([{ id: 'T1', code: 'obkatka', updatedAt: 1 }]);
    state.selects.push([
      { metaJson: JSON.stringify({ kind: 'repair_history', action: 'Обкатка', sheet: { typeId: 'T1', typeCode: 'obkatka', typeName: 'Обкатка', fields: [{ code: 'hours', label: 'Часы', type: 'number', value: 4 }] } }) },
    ]);
    const r = await upsertWorkSheetType({ id: 'T1', name: 'Обкатка', columns: [{ code: 'hours', label: 'Часы работы', type: 'number' }] });
    expect(r.ok).toBe(true);
    expect(JSON.parse(String(state.updates[0]?.columnsJson))[0]?.label).toBe('Часы работы');
  });

  it('узел успели изменить в другом месте — правка отбивается, а не затирает чужую', async () => {
    state.selects.push([{ id: 'T1', code: 'obkatka', updatedAt: 777 }]);
    const r = await upsertWorkSheetType({ id: 'T1', name: 'Обкатка', columns: [], expectedUpdatedAt: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('другом месте');
    expect(state.updates).toHaveLength(0);
  });

  it('без названия узел не создаётся', async () => {
    const r = await upsertWorkSheetType({ name: '   ' });
    expect(r.ok).toBe(false);
  });

  it('архив ставит archived_at, а не удаляет строку', async () => {
    const r = await archiveWorkSheetType('T1', 'ivanov');
    expect(r.ok).toBe(true);
    expect(state.updates[0]).toHaveProperty('archivedAt');
  });
});
