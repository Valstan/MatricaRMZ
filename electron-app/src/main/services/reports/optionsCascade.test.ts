import { cascadeVisibleOptions } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { attributeDefs, attributeValues, entities, entityTypes } from '../../database/schema.js';

import { loadSnapshot } from './context.js';
import { attachOptionLinks, buildFilterCascadeLinks, buildOptions, buildCounterpartyOptions } from './options.js';

// Тот же синтетический снапшот, что у отчёта «Движение двигателей по заказчикам»:
//   CP1: договоры C1 (марки BR1, BR2) и C2 (BR1, заказчик у двигателя пуст — берётся с договора)
//   CP2: договор C3 (BR2)
//   BR3 — марка из справочника, ни на одном двигателе не стоит
type Row = Record<string, unknown>;

const typeRows: Row[] = [
  { id: 'T_ENGINE', code: 'engine' },
  { id: 'T_CONTRACT', code: 'contract' },
  { id: 'T_BRAND', code: 'engine_brand' },
  { id: 'T_CP', code: 'counterparty' },
];

const entityRows: Row[] = [
  { id: 'BR1', typeId: 'T_BRAND' },
  { id: 'BR2', typeId: 'T_BRAND' },
  { id: 'BR3', typeId: 'T_BRAND' },
  { id: 'CP1', typeId: 'T_CP' },
  { id: 'CP2', typeId: 'T_CP' },
  { id: 'C1', typeId: 'T_CONTRACT' },
  { id: 'C2', typeId: 'T_CONTRACT' },
  { id: 'C3', typeId: 'T_CONTRACT' },
  ...['E1', 'E2', 'E3', 'E4'].map((id) => ({ id, typeId: 'T_ENGINE' })),
];

const defRows: Row[] = [
  'name',
  'engine_brand_id',
  'contract_id',
  'counterparty_id',
  'contract_sections',
].map((code) => ({ id: code, code }));

const contractSections = (number: string, customerId: string) => ({
  primary: { number, internalNumber: '', customerId, signedAt: null, dueAt: null, engineBrands: [], parts: [] },
  addons: [],
});

const attrData: Record<string, Record<string, unknown>> = {
  BR1: { name: 'Д-245' },
  BR2: { name: 'ЯМЗ-238' },
  BR3: { name: 'КамАЗ-740' },
  CP1: { name: 'АО «Первый заказчик»' },
  CP2: { name: 'ООО «Второй заказчик»' },
  C1: { contract_sections: contractSections('125/2026', 'CP1') },
  C2: { contract_sections: contractSections('РМЗ-2026-0158', 'CP1') },
  C3: { contract_sections: contractSections('7/2026', 'CP2') },
  E1: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1' },
  E2: { engine_brand_id: 'BR2', contract_id: 'C1', counterparty_id: 'CP1' },
  E3: { engine_brand_id: 'BR1', contract_id: 'C2' },
  E4: { engine_brand_id: 'BR2', contract_id: 'C3', counterparty_id: 'CP2' },
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
  };
}

describe('каскад фильтров отбора: заказчик → договор → марка', () => {
  it('договор связан со своим заказчиком, марка — с договорами и заказчиками своих двигателей', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const links = buildFilterCascadeLinks(snapshot);

    expect(links.contractParents.get('C1')).toEqual(['CP1']);
    expect(links.contractParents.get('C3')).toEqual(['CP2']);
    expect(new Set(links.brandParents.get('BR1'))).toEqual(new Set(['C1', 'C2', 'CP1']));
    expect(new Set(links.brandParents.get('BR2'))).toEqual(new Set(['C1', 'C3', 'CP1', 'CP2']));
    // Марка из справочника без единого двигателя связей не имеет — при выбранном родителе выпадет.
    expect(links.brandParents.get('BR3')).toBeUndefined();
  });

  it('заказчик двигателя пуст — берётся с договора, иначе марка выпала бы из каскада', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const links = buildFilterCascadeLinks(snapshot);
    // E3 (BR1, договор C2) заказчика в карточке не имеет; CP1 приходит с договора.
    expect(links.brandParents.get('BR1')).toContain('CP1');
  });

  it('выбор заказчика сужает договоры, а договор — марки', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const links = buildFilterCascadeLinks(snapshot);
    const contracts = attachOptionLinks(buildOptions(snapshot, 'contract'), links.contractParents);
    const brands = attachOptionLinks(buildOptions(snapshot, 'engine_brand'), links.brandParents);
    expect(buildCounterpartyOptions(snapshot).map((o) => o.value).sort()).toEqual(['CP1', 'CP2']);

    const byCp1 = cascadeVisibleOptions(contracts, ['counterpartyIds'], { counterpartyIds: ['CP1'] });
    expect(byCp1.map((o) => o.value).sort()).toEqual(['C1', 'C2']);

    const brandsOfCp1 = cascadeVisibleOptions(brands, ['counterpartyIds', 'contractIds'], { counterpartyIds: ['CP1'] });
    expect(brandsOfCp1.map((o) => o.value).sort()).toEqual(['BR1', 'BR2']);

    const brandsOfC2 = cascadeVisibleOptions(brands, ['counterpartyIds', 'contractIds'], {
      counterpartyIds: ['CP1'],
      contractIds: ['C2'],
    });
    expect(brandsOfC2.map((o) => o.value)).toEqual(['BR1']);
  });

  it('ничего не выбрано — списки полные', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const links = buildFilterCascadeLinks(snapshot);
    const brands = attachOptionLinks(buildOptions(snapshot, 'engine_brand'), links.brandParents);
    expect(cascadeVisibleOptions(brands, ['counterpartyIds', 'contractIds'], {}).length).toBe(3);
  });
});
