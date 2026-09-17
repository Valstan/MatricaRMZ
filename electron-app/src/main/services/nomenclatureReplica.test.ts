import { describe, expect, it } from 'vitest';

import { decorateNomenclatureReplicaRow, masterdataLookupLabel, normalizeItemTypeToCategory } from './nomenclatureReplica.js';

// E1 программы осень-2026: список номенклатуры читается из реплики клиента, а не с сервера.
// Строка реплики — голая таблица; подписи группы/единицы/склада/родителя и производные поля
// собираются здесь по тому же правилу, что у сервера (`listWarehouseNomenclature`). Разойдётся
// правило — оператор увидит разные списки в зависимости от того, была ли сеть при первом запуске.

const refs = {
  groupById: new Map([['g1', 'Поршневая']]),
  unitById: new Map([['u1', 'шт']]),
  warehouseByCode: new Map([['MAIN', 'Основной склад']]),
  parentNameById: new Map([['p1', 'Поршень (обобщ.)']]),
};

describe('decorateNomenclatureReplicaRow', () => {
  it('подставляет подписи справочников и родителя по id', () => {
    const row = decorateNomenclatureReplicaRow(
      { id: 'n1', name: 'Поршень Д-240', code: 'A-1', groupId: 'g1', unitId: 'u1', defaultWarehouseId: 'MAIN', parentNomenclatureId: 'p1', itemType: 'component' },
      refs,
    );
    expect(row.groupName).toBe('Поршневая');
    expect(row.unitName).toBe('шт');
    expect(row.defaultWarehouseName).toBe('Основной склад');
    expect(row.parentNomenclatureName).toBe('Поршень (обобщ.)');
  });

  it('неизвестный или пустой id даёт null, а не «undefined» в ячейке', () => {
    const row = decorateNomenclatureReplicaRow({ id: 'n1', name: 'X', groupId: 'нет-такой', unitId: null, defaultWarehouseId: '' }, refs);
    expect(row.groupName).toBeNull();
    expect(row.unitName).toBeNull();
    expect(row.defaultWarehouseName).toBeNull();
    expect(row.parentNomenclatureName).toBeNull();
    expect(row.defaultBrandName).toBeNull();
  });

  it('производные поля — как у сервера: sku из кода, категория из типа, серийный учёт у двигателя', () => {
    const engine = decorateNomenclatureReplicaRow({ id: 'e', name: 'Д-240', code: 'D240', itemType: 'engine' }, refs);
    expect(engine.sku).toBe('D240');
    expect(engine.category).toBe('engine');
    expect(engine.isSerialTracked).toBe(true);

    const product = decorateNomenclatureReplicaRow({ id: 'p', name: 'Насос', code: 'N1', sku: 'SKU-9', itemType: 'product', isSerialTracked: false }, refs);
    expect(product.sku).toBe('SKU-9');
    expect(product.category).toBe('assembly');
    expect(product.isSerialTracked).toBe(false);
    // Явная категория строки важнее выведенной из типа.
    expect(decorateNomenclatureReplicaRow({ id: 'c', name: 'X', itemType: 'engine', category: 'component' }, refs).category).toBe('component');
  });

  it('componentTypeId: колонка → specJson → эвристика по названию', () => {
    expect(decorateNomenclatureReplicaRow({ id: '1', name: 'Что угодно', componentTypeId: 'sleeve' }, refs).componentTypeId).toBe('sleeve');
    expect(
      decorateNomenclatureReplicaRow({ id: '2', name: 'Что угодно', specJson: JSON.stringify({ componentTypeId: 'piston' }) }, refs).componentTypeId,
    ).toBe('piston');
    expect(decorateNomenclatureReplicaRow({ id: '3', name: 'Гильза цилиндра', itemType: 'component' }, refs).componentTypeId).toBe('sleeve');
  });
});

describe('masterdataLookupLabel', () => {
  it('берёт name, иначе title/label/full_name, иначе code, иначе id — порядок сервера', () => {
    expect(masterdataLookupLabel('id', { name: ' Группа ', code: 'G' })).toBe('Группа');
    expect(masterdataLookupLabel('id', { full_name: 'Иванова Мария Петровна' })).toBe('Иванова Мария Петровна');
    expect(masterdataLookupLabel('id', { code: 'G' })).toBe('G');
    expect(masterdataLookupLabel('id', { name: '' })).toBe('id');
    expect(masterdataLookupLabel('id', {})).toBe('id');
  });
});

describe('normalizeItemTypeToCategory', () => {
  it('повторяет серверную таблицу соответствий', () => {
    expect(normalizeItemTypeToCategory('engine')).toBe('engine');
    for (const t of ['product', 'semi_product', 'assembly']) expect(normalizeItemTypeToCategory(t)).toBe('assembly');
    for (const t of ['component', 'material', '', null, undefined]) expect(normalizeItemTypeToCategory(t)).toBe('component');
  });
});
