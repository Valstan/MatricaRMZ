import { describe, expect, it } from 'vitest';

import {
  buildEngineCardTransferPreview,
  classifyTransferValue,
  engineCardMissingCharacteristics,
  matchExcelSheet,
  matchWordDocument,
  parseTransferDate,
  suggestTransferTargetCode,
  type EngineCardTransferTarget,
} from './fileSearch.js';

const SHEET = {
  sheetName: 'Лист1',
  headers: ['№ двигателя', 'Контракт', 'Дата прихода'],
  rows: [
    { rowNumber: 2, values: ['41/26', 'Д-100', '15.11.2026'] },
    { rowNumber: 3, values: ['77/26', 'Д-101', '16.11.2026'] },
  ],
};

describe('matchExcelSheet', () => {
  it('находит строку целиком вместе с наименованиями столбцов', () => {
    const matches = matchExcelSheet({
      sourceId: 's1',
      sourceName: 'акты.xlsx',
      sheet: SHEET,
      query: '41/26',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].rowNumber).toBe(2);
    expect(matches[0].headers).toEqual(['№ двигателя', 'Контракт', 'Дата прихода']);
    expect(matches[0].values).toEqual(['41/26', 'Д-100', '15.11.2026']);
    expect(matches[0].matchedColumnIndex).toBe(0);
  });

  it('пустой запрос не находит ничего', () => {
    expect(matchExcelSheet({ sourceId: 's1', sourceName: 'акты.xlsx', sheet: SHEET, query: '   ' })).toHaveLength(0);
  });

  it('ищет без учёта регистра и по любому столбцу', () => {
    const matches = matchExcelSheet({
      sourceId: 's1',
      sourceName: 'акты.xlsx',
      sheet: SHEET,
      query: 'д-101',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedColumnIndex).toBe(1);
  });
});

describe('matchWordDocument', () => {
  const paragraphs = ['Первая строка', 'Акт по двигателю 41/26 от 15.11.2026', 'Подпись мастера'];

  it('возвращает найденный абзац и признак «ниже есть текст»', () => {
    const matches = matchWordDocument({ sourceId: 's2', sourceName: 'акт.docx', paragraphs, query: '41/26' });
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toContain('Акт по двигателю 41/26');
    expect(matches[0].hasMoreBelow).toBe(true);
    expect(matches[0].snippet).toContain('41/26');
  });

  it('последнее совпадение — строк ниже нет', () => {
    const matches = matchWordDocument({
      sourceId: 's2',
      sourceName: 'акт.docx',
      paragraphs: ['строка с 41/26'],
      query: '41/26',
    });
    expect(matches[0].hasMoreBelow).toBe(false);
  });
});

describe('classifyTransferValue / parseTransferDate', () => {
  it('различает дату, число и текст', () => {
    expect(classifyTransferValue('15.11.2026')).toBe('date');
    expect(classifyTransferValue('2026-11-15')).toBe('date');
    expect(classifyTransferValue('41')).toBe('number');
    expect(classifyTransferValue('Д-100')).toBe('text');
  });

  it('дату приводит к мс, мусор — к null', () => {
    expect(parseTransferDate('15.11.2026')).toBe(Date.UTC(2026, 10, 15));
    expect(parseTransferDate('31.02.2026')).toBeNull();
    expect(parseTransferDate('вчера')).toBeNull();
  });
});

const TARGETS: Record<string, EngineCardTransferTarget> = {
  arrival_date: { code: 'arrival_date', label: 'Дата прихода', kind: 'date' },
  engine_number: { code: 'engine_number', label: 'Номер двигателя', kind: 'text' },
};

describe('buildEngineCardTransferPreview', () => {
  it('дата в поле даты: совместимо, payload — мс', () => {
    const preview = buildEngineCardTransferPreview({
      card: {},
      target: TARGETS.arrival_date,
      candidateValue: '15.11.2026',
      candidateLabel: 'Дата прихода',
    });
    expect(preview.compatible).toBe(true);
    expect(preview.payload).toBe(Date.UTC(2026, 10, 15));
    expect(preview.reason).toBeNull();
  });

  it('дата в текстовое поле: объяснение, а не молчаливая запись', () => {
    const preview = buildEngineCardTransferPreview({
      card: {},
      target: TARGETS.engine_number,
      candidateValue: '15.11.2026',
      candidateLabel: 'Дата прихода',
    });
    expect(preview.compatible).toBe(false);
    expect(preview.payload).toBeNull();
    expect(preview.reason).toContain('Тип не совпадает');
  });

  it('занятое поле требует явного выбора оператора', () => {
    const preview = buildEngineCardTransferPreview({
      card: { engine_number: '41/26' },
      target: TARGETS.engine_number,
      candidateValue: '77/26',
      candidateLabel: '№ двигателя',
    });
    expect(preview.compatible).toBe(false);
    expect(preview.currentValue).toBe('41/26');
    expect(preview.reason).toContain('уже заполнено');
  });
});

describe('suggestTransferTargetCode', () => {
  it('угадывает поле по заголовку столбца', () => {
    expect(suggestTransferTargetCode('№ двигателя')).toBe('engine_number');
    expect(suggestTransferTargetCode('Дата прихода')).toBe('arrival_date');
    expect(suggestTransferTargetCode('Внутренний номер')).toBe('engine_internal_number');
    expect(suggestTransferTargetCode('Примечание')).toBe('engine_note');
    expect(suggestTransferTargetCode('Что-то ещё')).toBeNull();
  });
});

describe('engineCardMissingCharacteristics', () => {
  it('перечисляет незаполненные характеристики', () => {
    const missing = engineCardMissingCharacteristics({
      card: { engine_number: '41/26', engine_note: '   ' },
      known: [
        { code: 'engine_number', label: 'Номер двигателя' },
        { code: 'engine_note', label: 'Примечание' },
        { code: 'arrival_date', label: 'Дата прихода' },
      ],
    });
    expect(missing.map((m) => m.code)).toEqual(['engine_note', 'arrival_date']);
  });
});
