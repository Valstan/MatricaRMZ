import { describe, expect, it } from 'vitest';

import { DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA } from '@matricarmz/shared';

import { componentTypeLabel, componentTypeLabelsFromSchema } from './componentTypeLabels.js';

describe('componentTypeLabel', () => {
  it('подписывает встроенные типы деталей', () => {
    expect(componentTypeLabel('sleeve')).toBe('Гильза');
    expect(componentTypeLabel('carter')).toBe('Картер');
  });

  // Диалог разборки печатал сюда сырой код: оператор видел «sleeve» в колонке «Тип».
  it('не отдаёт код, которого нет в словаре', () => {
    const text = componentTypeLabel('crankshaft');
    expect(text).toBe('—');
    expect(text).not.toContain('crankshaft');
  });

  it('пустой тип — прочерк, а не пустая ячейка', () => {
    expect(componentTypeLabel('')).toBe('—');
    expect(componentTypeLabel(null)).toBe('—');
    expect(componentTypeLabel(undefined)).toBe('—');
  });

  // Множество типов открыто: тип, заведённый оператором в схеме, словарь не знает —
  // подпись обязана прийти из живой схемы, а не превратиться в прочерк.
  it('живая схема подписывает и типы оператора, и переименованные встроенные', () => {
    const live = componentTypeLabelsFromSchema({
      ...DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
      nodes: [
        { typeId: 'sleeve', label: 'Гильза цилиндра', isActive: true, childTypeIds: [], sortOrder: 20 },
        { typeId: 'crankshaft', label: 'Коленвал', isActive: true, childTypeIds: [], sortOrder: 70 },
        { typeId: 'blank', label: '   ', isActive: true, childTypeIds: [], sortOrder: 80 },
      ],
    });
    expect(componentTypeLabel('crankshaft', live)).toBe('Коленвал');
    expect(componentTypeLabel('sleeve', live)).toBe('Гильза цилиндра');
    expect(componentTypeLabel('piston', live)).toBe('Поршень');
    expect(componentTypeLabel('blank', live)).toBe('—');
  });
});
