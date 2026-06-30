import { describe, expect, it } from 'vitest';

import {
  buildEngineBomSkeletonBlockLines,
  sanitizeWarehouseBomRelationSchema,
  type WarehouseBomRelationSchema,
} from './warehouse.js';

function makeSchema(typeIds: string[]): WarehouseBomRelationSchema {
  return sanitizeWarehouseBomRelationSchema({
    format: 'bom_relation_schema_v1',
    rootTypeId: 'engine',
    nodes: [
      { typeId: 'engine', label: 'Двигатель', isActive: true, childTypeIds: typeIds, sortOrder: 5 },
      ...typeIds.map((typeId, idx) => ({
        typeId,
        label: typeId,
        isActive: true,
        childTypeIds: [],
        sortOrder: (idx + 1) * 10,
      })),
    ],
  });
}

describe('buildEngineBomSkeletonBlockLines', () => {
  it('включает все active типы схемы — без legacy whitelist (v1.21.5)', () => {
    // Тип crankshaft не входил в старый BOM_SKELETON_KNOWN_COMPONENT_TYPES,
    // но теперь skeleton должен содержать строку для него.
    const schema = makeSchema(['sleeve', 'piston', 'ring', 'crankshaft', 'jacket', 'head', 'carter']);
    const lines = buildEngineBomSkeletonBlockLines({
      schema,
      stubComponentNomenclatureId: '',
      variantGroupId: '__kit_test',
      lineKeyPrefix: 'b-test',
    });
    expect(lines.map((l) => l.componentType).sort()).toEqual(
      ['carter', 'crankshaft', 'head', 'jacket', 'piston', 'ring', 'sleeve'].sort(),
    );
  });

  it('включает полностью произвольные кастомные typeId (нет привязки к legacy whitelist)', () => {
    const schema = makeSchema(['turbocharger', 'fuel_pump', 'oil_cooler']);
    const lines = buildEngineBomSkeletonBlockLines({
      schema,
      stubComponentNomenclatureId: '',
      variantGroupId: '__kit_test',
      lineKeyPrefix: 'b-test',
    });
    expect(lines.map((l) => l.componentType).sort()).toEqual(['fuel_pump', 'oil_cooler', 'turbocharger']);
  });

  it('исключает root typeId и неактивные типы', () => {
    const schema: WarehouseBomRelationSchema = sanitizeWarehouseBomRelationSchema({
      format: 'bom_relation_schema_v1',
      rootTypeId: 'engine',
      nodes: [
        { typeId: 'engine', label: 'Двигатель', isActive: true, childTypeIds: ['sleeve', 'piston'], sortOrder: 5 },
        { typeId: 'sleeve', label: 'Гильза', isActive: true, childTypeIds: [], sortOrder: 10 },
        { typeId: 'piston', label: 'Поршень', isActive: false, childTypeIds: [], sortOrder: 20 },
      ],
    });
    const lines = buildEngineBomSkeletonBlockLines({
      schema,
      stubComponentNomenclatureId: '',
      variantGroupId: '__kit_test',
      lineKeyPrefix: 'b-test',
    });
    expect(lines.map((l) => l.componentType)).toEqual(['sleeve']);
  });

  it('возвращает priority из node.sortOrder (skeleton задаёт стартовое значение)', () => {
    const schema = makeSchema(['sleeve', 'piston']);
    const lines = buildEngineBomSkeletonBlockLines({
      schema,
      stubComponentNomenclatureId: '',
      variantGroupId: '__kit_test',
      lineKeyPrefix: 'b-test',
    });
    const sleeve = lines.find((l) => l.componentType === 'sleeve');
    const piston = lines.find((l) => l.componentType === 'piston');
    expect(sleeve?.priority).toBe(10);
    expect(piston?.priority).toBe(20);
  });

  it('сохраняет общий variantGroup и формирует уникальные lineKey по prefix', () => {
    const schema = makeSchema(['sleeve', 'piston']);
    const lines = buildEngineBomSkeletonBlockLines({
      schema,
      stubComponentNomenclatureId: '',
      variantGroupId: '__kit_abc',
      lineKeyPrefix: 'b-xyz',
    });
    expect(lines.every((l) => l.variantGroup === '__kit_abc')).toBe(true);
    const keys = lines.map((l) => l.lineKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => String(k).startsWith('b-xyz-'))).toBe(true);
  });
});
