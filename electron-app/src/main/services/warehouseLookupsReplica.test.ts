import { describe, expect, it } from 'vitest';

import {
  contractLookupOption,
  counterpartyLookupOption,
  engineBrandLookupOption,
  lookupLabelFromAttrs,
  masterdataLookupOption,
  sortLookupOptions,
} from './warehouseLookupsReplica.js';

// Справочники склада собираются на клиенте из реплики (владелец 18.09.2026: «всё, дак
// всё — пусть будет на клиенте»). Подписи ОБЯЗАНЫ совпадать с серверными: один и тот же
// выпадающий список не должен выглядеть по-разному в зависимости от источника.

describe('подписи справочников из реплики', () => {
  it('общая подпись берётся по приоритету name → title → label → full_name', () => {
    expect(lookupLabelFromAttrs('id-1', { full_name: 'Иванова Мария Петровна' })).toBe('Иванова Мария Петровна');
    expect(lookupLabelFromAttrs('id-2', { name: 'Штуки', title: 'не эта' })).toBe('Штуки');
    expect(lookupLabelFromAttrs('id-3', { label: 'Метка' })).toBe('Метка');
  });

  it('пустая строка подписью не считается — падаем на code, потом на id', () => {
    expect(lookupLabelFromAttrs('id-4', { name: '   ', code: 'KG' })).toBe('KG');
    expect(lookupLabelFromAttrs('id-5', {})).toBe('id-5');
  });

  it('meta отдаётся только когда в ней что-то есть', () => {
    expect(masterdataLookupOption('id-6', { name: 'Склад', address: 'Цех 3' })).toEqual({
      id: 'id-6',
      label: 'Склад',
      code: null,
      meta: { address: 'Цех 3' },
    });
    expect(masterdataLookupOption('id-7', { name: 'Без адреса' })).toEqual({ id: 'id-7', label: 'Без адреса', code: null });
  });

  it('договор подписывается внутренним номером, затем номером, затем ГОЗ', () => {
    expect(contractLookupOption('c1', { internal_number: '20/ГОЗ-25', number: '1234' })).toEqual({
      id: 'c1',
      label: '20/ГОЗ-25',
      code: '1234',
    });
    expect(contractLookupOption('c2', { number: '1234', goz_name: 'Тема' }).label).toBe('1234');
    expect(contractLookupOption('c3', { goz_name: 'Тема' })).toEqual({ id: 'c3', label: 'Тема', code: null });
    expect(contractLookupOption('c4', {}).label).toBe('c4');
  });

  it('контрагент: подпись — наименование, код — краткое имя', () => {
    expect(counterpartyLookupOption('k1', { name: 'АО «Русские краски»', short_name: 'РК' })).toEqual({
      id: 'k1',
      label: 'АО «Русские краски»',
      code: 'РК',
    });
    expect(counterpartyLookupOption('k2', { name: 'Без краткого' }).code).toBeNull();
  });

  it('марка двигателя — без кода', () => {
    expect(engineBrandLookupOption('b1', { name: 'ЯМЗ-238' })).toEqual({ id: 'b1', label: 'ЯМЗ-238', code: null });
  });

  it('порядок — по подписи по-русски, «ё» не улетает в конец', () => {
    const sorted = sortLookupOptions([
      { id: '1', label: 'Ящик', code: null },
      { id: '2', label: 'ёмкость', code: null },
      { id: '3', label: 'Ампер', code: null },
    ]).map((o) => o.label);
    expect(sorted).toEqual(['Ампер', 'ёмкость', 'Ящик']);
  });

  it('сортировка не меняет входной массив', () => {
    const input = [
      { id: '1', label: 'Б', code: null },
      { id: '2', label: 'А', code: null },
    ];
    sortLookupOptions(input);
    expect(input.map((o) => o.label)).toEqual(['Б', 'А']);
  });
});
