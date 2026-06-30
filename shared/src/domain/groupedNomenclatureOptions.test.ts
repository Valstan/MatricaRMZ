import { describe, expect, it } from 'vitest';

import {
  buildGroupedNomenclatureOptions,
  DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
  type WarehouseBomRelationSchema,
} from './warehouse.js';

describe('buildGroupedNomenclatureOptions', () => {
  const schema = DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA;

  it('groups items by componentTypeId, ordered by schema sortOrder', () => {
    const groups = buildGroupedNomenclatureOptions({
      items: [
        { id: '1', label: 'Поршень A', componentTypeId: 'piston' },
        { id: '2', label: 'Гильза 100', componentTypeId: 'sleeve' },
        { id: '3', label: 'Гильза 50', componentTypeId: 'sleeve' },
        { id: '4', label: 'Кольцо', componentTypeId: 'ring' },
      ],
      schema,
    });
    expect(groups.map((g) => g.groupId)).toEqual(['sleeve', 'piston', 'ring']);
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['Гильза 50', 'Гильза 100']);
  });

  it('puts items with null/unknown componentTypeId into "Прочее" group at the end', () => {
    const groups = buildGroupedNomenclatureOptions({
      items: [
        { id: 'a', label: 'Болт', componentTypeId: null },
        { id: 'b', label: 'Гильза', componentTypeId: 'sleeve' },
        { id: 'c', label: 'Loose', componentTypeId: 'unknown_type' },
      ],
      schema,
    });
    expect(groups.map((g) => g.groupId)).toEqual(['sleeve', 'other']);
    const other = groups.find((g) => g.groupId === 'other');
    expect(other?.items.map((i) => i.label).slice().sort()).toEqual(['Loose', 'Болт']);
    expect(other?.items.every((i) => i.componentTypeId === null)).toBe(true);
  });

  it('skips groups for active schema types that have no items', () => {
    const groups = buildGroupedNomenclatureOptions({
      items: [{ id: '1', label: 'Поршень', componentTypeId: 'piston' }],
      schema,
    });
    expect(groups.map((g) => g.groupId)).toEqual(['piston']);
  });

  it('excludes items whose typeId is inactive in schema, treats them as "Прочее"', () => {
    const customSchema: WarehouseBomRelationSchema = {
      format: 'bom_relation_schema_v1',
      rootTypeId: 'engine',
      nodes: [
        { typeId: 'engine', label: 'Двигатель', isActive: true, childTypeIds: ['sleeve'], sortOrder: 10 },
        { typeId: 'sleeve', label: 'Гильза', isActive: true, childTypeIds: [], sortOrder: 20 },
        { typeId: 'piston', label: 'Поршень', isActive: false, childTypeIds: [], sortOrder: 30 },
      ],
    };
    const groups = buildGroupedNomenclatureOptions({
      items: [
        { id: '1', label: 'Гильза', componentTypeId: 'sleeve' },
        { id: '2', label: 'Поршень', componentTypeId: 'piston' },
      ],
      schema: customSchema,
    });
    expect(groups.map((g) => g.groupId)).toEqual(['sleeve', 'other']);
  });

  it('uses custom otherGroupLabel when provided', () => {
    const groups = buildGroupedNomenclatureOptions({
      items: [{ id: '1', label: 'Болт', componentTypeId: null }],
      schema,
      otherGroupLabel: 'Без типа',
    });
    expect(groups[0]!.groupLabel).toBe('Без типа');
  });

  it('preserves hintText when provided', () => {
    const groups = buildGroupedNomenclatureOptions({
      items: [{ id: '1', label: 'Гильза', hintText: 'SKU-001', componentTypeId: 'sleeve' }],
      schema,
    });
    expect(groups[0]!.items[0]!.hintText).toBe('SKU-001');
  });
});
