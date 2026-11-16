import { describe, expect, it } from 'vitest';

import {
  FILE_SEARCH_LABEL_MATCH_THRESHOLD,
  compareFindingsWithCard,
  compareValuesEqual,
  labelSimilarity,
  normalizeCompareValue,
} from './fileSearchCompare.js';

describe('сверка найденного с карточкой', () => {
  it('значение нормализуется: регистр, «ё», кавычки, «№» и лишние пробелы', () => {
    expect(normalizeCompareValue('  АО   «РТ  "Гранит"» ')).toBe('ао рт гранит');
    expect(normalizeCompareValue('Ёлка')).toBe('елка');
    expect(normalizeCompareValue('№ 303')).toBe('303');
  });

  it('дата из карточки (мс) и дата из файла — одно и то же значение', () => {
    const ms = Date.UTC(2026, 5, 24, 9, 0, 0);
    expect(compareValuesEqual(ms, '24.06.2026')).toBe(true);
    expect(compareValuesEqual('24.06.2026', '24.06.2026')).toBe(true);
    expect(compareValuesEqual('24.06.2026', '25.06.2026')).toBe(false);
  });

  it('дата приводится к «ДД.ММ.ГГГГ» без конвертации — иначе часовой пояс машины ломает сверку', () => {
    expect(normalizeCompareValue('24.06.2026')).toBe('24.06.2026');
    expect(normalizeCompareValue('2026-06-24')).toBe('24.06.2026');
    expect(normalizeCompareValue('4.6.2026')).toBe('04.06.2026');
  });

  it('короткие значения не ловятся «по вхождению»', () => {
    expect(compareValuesEqual('2', '2026')).toBe(false);
    expect(compareValuesEqual('41', '41/26')).toBe(false);
  });

  it('номер накладной в карточке и в файле — совпадают', () => {
    expect(compareValuesEqual('№ 074/2501 от 16.06.2026', '074/2501')).toBe(true);
  });

  it('названия похожи, когда одно входит в другое', () => {
    expect(labelSimilarity('Марка двигателя', 'Марка двигателя (справочник)')).toBeGreaterThanOrEqual(
      FILE_SEARCH_LABEL_MATCH_THRESHOLD,
    );
    expect(labelSimilarity('Номер накладной (приход)', 'Номер накладной (отгрузка)')).toBeLessThan(
      FILE_SEARCH_LABEL_MATCH_THRESHOLD,
    );
    expect(labelSimilarity('Заказчик', 'рекламация')).toBeLessThan(FILE_SEARCH_LABEL_MATCH_THRESHOLD);
  });

  it('пункт, названный иначе, находится по значению', () => {
    const rows = compareFindingsWithCard({
      findings: [{ label: 'Номер договора', value: '№ 303' }],
      cardFields: [{ code: 'contract_id', label: 'Контракт', value: '303' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'same', matchedBy: 'value', cardLabel: 'Контракт' });
  });

  it('расхождение: в карточке другое значение', () => {
    const rows = compareFindingsWithCard({
      findings: [{ label: 'Номер двигателя', value: 'Э06АТ0889' }],
      cardFields: [{ code: 'engine_number', label: 'Номер двигателя', value: 'Э06АТ0888' }],
    });
    expect(rows[0]).toMatchObject({ state: 'different', matchedBy: 'label', cardValue: 'Э06АТ0888' });
  });

  it('пустое поле карточки — есть что переносить', () => {
    const rows = compareFindingsWithCard({
      findings: [{ label: 'Внутренний номер', value: '41' }],
      cardFields: [{ code: 'engine_internal_number', label: 'Внутренний номер', value: null }],
    });
    expect(rows[0]).toMatchObject({ state: 'card_empty', matchedBy: 'label' });
  });

  it('пустые поля карточки без находок не выглядят как «только в карточке»', () => {
    const rows = compareFindingsWithCard({
      findings: [],
      cardFields: [
        { code: 'engine_number', label: 'Номер двигателя', value: 'Э06АТ0889' },
        { code: 'engine_note', label: 'Примечание', value: null },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'card_only', cardCode: 'engine_number' });
  });

  it('пункт без пары в карточке виден как «нет такого пункта»', () => {
    const rows = compareFindingsWithCard({
      findings: [{ label: 'рекламация', value: 'да' }],
      cardFields: [{ code: 'engine_number', label: 'Номер двигателя', value: 'Э06АТ0889' }],
    });
    expect(rows[0]).toMatchObject({ state: 'no_match', cardLabel: null });
  });

  it('пункт, которого нет в файлах, остаётся в списке карточки', () => {
    const rows = compareFindingsWithCard({
      findings: [],
      cardFields: [{ code: 'engine_number', label: 'Номер двигателя', value: 'Э06АТ0889' }],
    });
    expect(rows).toEqual([
      {
        key: 'c0',
        findingLabel: null,
        findingValue: null,
        cardCode: 'engine_number',
        cardLabel: 'Номер двигателя',
        cardValue: 'Э06АТ0889',
        state: 'card_only',
        matchedBy: null,
      },
    ]);
  });

  it('одно поле карточки достаётся первой находке, а не двумя', () => {
    const rows = compareFindingsWithCard({
      findings: [
        { label: 'Номер двигателя', value: 'Э06АТ0889' },
        { label: 'Номер двигателя (дубль)', value: 'Э06АТ0889' },
      ],
      cardFields: [{ code: 'engine_number', label: 'Номер двигателя', value: 'Э06АТ0889' }],
    });
    expect(rows.filter((r) => r.state === 'same')).toHaveLength(1);
    expect(rows.filter((r) => r.state === 'no_match')).toHaveLength(1);
  });
});
