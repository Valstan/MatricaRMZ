import { describe, expect, it } from 'vitest';

import { attributeDefs, attributeValues, entities, entityTypes } from '../../database/schema.js';

import { loadSnapshot } from './context.js';
import { buildEngineOptions } from './options.js';

// Селектор «Комплектование двигателя» прячет утильные двигатели. Прежняя проверка читала
// флаги через normalizeText, а он возвращает СТРОКУ: у снятой галочки это 'false' —
// непустая, то есть истинная. Из списка выпадал каждый двигатель, у которого метку утиля
// когда-либо ставили и сняли: на проде 147 живых из 378 с такой отметкой.
type Row = Record<string, unknown>;

const typeRows: Row[] = [
  { id: 'T_ENGINE', code: 'engine' },
  { id: 'T_BRAND', code: 'engine_brand' },
];

const entityRows: Row[] = [
  { id: 'BR1', typeId: 'T_BRAND' },
  ...['E_PLAIN', 'E_SCRAP', 'E_UNMARKED', 'E_UNMARKED_STR', 'E_REWORK'].map((id) => ({ id, typeId: 'T_ENGINE' })),
];

const defRows: Row[] = ['name', 'engine_number', 'engine_brand_id', 'status_scrap_confirmed', 'status_rework_sent'].map(
  (code) => ({ id: code, code }),
);

const attrData: Record<string, Record<string, unknown>> = {
  BR1: { name: 'Д-245' },
  E_PLAIN: { engine_number: '001', engine_brand_id: 'BR1' },
  E_SCRAP: { engine_number: '002', engine_brand_id: 'BR1', status_scrap_confirmed: true },
  // Галочку ставили и сняли — в EAV остался честный булев false.
  E_UNMARKED: { engine_number: '003', engine_brand_id: 'BR1', status_scrap_confirmed: false },
  // То же «нет», но строкой: так лежит наследство импорта 11.06.2026.
  E_UNMARKED_STR: { engine_number: '004', engine_brand_id: 'BR1', status_rework_sent: 'false' },
  E_REWORK: { engine_number: '005', engine_brand_id: 'BR1', status_rework_sent: true },
};

const valueRows: Row[] = [];
for (const [entityId, attrs] of Object.entries(attrData)) {
  for (const [code, value] of Object.entries(attrs)) {
    valueRows.push({ entityId, attributeDefId: code, valueJson: JSON.stringify(value) });
  }
}

function stubDb(): any {
  return {
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === entityTypes
              ? typeRows
              : table === entities
                ? entityRows
                : table === attributeDefs
                  ? defRows
                  : table === attributeValues
                    ? valueRows
                    : [];
          const chain: any = { where: () => chain, limit: () => Promise.resolve(rows) };
          return chain;
        },
      };
    },
  };
}

describe('buildEngineOptions: утиль прячем по факту, а не по наличию отметки', () => {
  it('снятая галочка утиля не исключает двигатель — ни булевым false, ни строковым "false"', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const values = buildEngineOptions(snapshot)
      .map((o) => String(o.value))
      .filter(Boolean); // первая опция — пустой плейсхолдер

    expect(values).toContain('E_PLAIN');
    expect(values).toContain('E_UNMARKED');
    expect(values).toContain('E_UNMARKED_STR');
    expect(values).not.toContain('E_SCRAP');
    expect(values).not.toContain('E_REWORK');
    expect(values).toHaveLength(3);
  });
});
