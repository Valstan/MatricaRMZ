import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getLastSheetByEngine } from './workSheets.js';

// Оба скана этого файла ходят по `operations` — таблице, где лежит вся история завода, и
// самая тяжёлая её колонка `meta_json`. Пока тип строки проверялся в цикле, а не в SQL,
// отчёт поднимал ВСЕ операции ради нескольких строк ведомостей (класс GOTCHAS M39), причём
// второй скан идёт при обычном построении отчёта «Двигатели», а не только по требованию.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const SRC = src('./workSheets.ts');

function metaJson(atMs: number, typeName: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'repair_history',
    action: `Ведомость: ${typeName}`,
    at: atMs,
    entryType: 'sheet',
    sheet: { typeId: `id-${typeName}`, typeCode: typeName, typeName, fields: [] },
    ...extra,
  });
}

function stubDb(rows: Array<Record<string, unknown>>) {
  return {
    select() {
      return {
        from() {
          const chain: any = {
            where() {
              return chain;
            },
            limit() {
              return Promise.resolve(rows);
            },
          };
          return chain;
        },
      };
    },
  } as any;
}

describe('отчёт «Ведомости работ» — сканы operations', () => {
  it('тип строки отбирается в SQL, а не в цикле, и колонки проецируются', () => {
    const scans = SRC.split('.from(operations)').length - 1;
    expect(scans, 'сканов operations в файле два — оба обязаны быть узкими').toBe(2);
    expect(
      SRC.split('eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE)').length - 1,
      'тип в where у обоих сканов',
    ).toBe(2);
    expect(SRC, 'звёздочка по operations поднимает meta_json всей истории').not.toContain('.select()\n    .from(operations)');
    expect(SRC).toContain('metaJson: operations.metaJson');
  });
});

describe('getLastSheetByEngine', () => {
  it('на двигатель — самая поздняя строка по дате строки, а не по времени правки', async () => {
    const rows = [
      { engineEntityId: 'e1', metaJson: metaJson(1_000, 'ukladka'), performedAt: 9_999, updatedAt: 9_999 },
      { engineEntityId: 'e1', metaJson: metaJson(5_000, 'obkatka'), performedAt: 1, updatedAt: 1 },
      { engineEntityId: 'e2', metaJson: metaJson(3_000, 'val'), performedAt: 0, updatedAt: 0 },
    ];
    const out = await getLastSheetByEngine(stubDb(rows));
    expect(out.get('e1')).toEqual({ node: 'obkatka', at: 5_000 });
    expect(out.get('e2')).toEqual({ node: 'val', at: 3_000 });
  });

  it('запись истории без ведомости в карту не попадает', async () => {
    const rows = [
      { engineEntityId: 'e1', metaJson: JSON.stringify({ kind: 'repair_history', action: 'Смена статуса', at: 7_000 }) },
      { engineEntityId: 'e1', metaJson: null },
    ];
    expect((await getLastSheetByEngine(stubDb(rows))).size).toBe(0);
  });
});
