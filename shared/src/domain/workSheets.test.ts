import { describe, expect, it } from 'vitest';

import { applyFacets, facetOptions, sanitizeFacetSelection } from './listFacets.js';
import {
  DEFAULT_WORK_SHEET_TYPES,
  buildWorkSheetFields,
  formatWorkSheetValue,
  missingRequiredWorkSheetFields,
  normalizeWorkSheetValue,
  parseWorkSheetFields,
  sanitizeWorkSheetColumns,
  workSheetCodeFromName,
  workSheetFacets,
  workSheetFieldsSummary,
  WORK_SHEET_MAX_TEXT,
  type WorkSheetRow,
} from './workSheets.js';

// Этапы работ (владелец 15.09.2026): узел = вид этапа работ со своими колонками, строка =
// запись истории ремонта. Колонки заводит пользователь, поэтому набор чистится здесь, а не в UI.

// Обязательность — правило ВВОДА, а не проверка задним числом всего, что уже записано.
describe('обязательные колонки', () => {
  const cols = [
    { code: 'hours', label: 'Часы', type: 'number' as const, required: true },
    { code: 'note', label: 'Замечание', type: 'text' as const },
  ];

  it('новая строка требует все обязательные', () => {
    const fields = buildWorkSheetFields(cols, { note: 'ок' });
    expect(missingRequiredWorkSheetFields(cols, fields)).toEqual(['Часы']);
  });

  it('колонку сделали обязательной задним числом — старую строку всё ещё можно править', () => {
    const before = buildWorkSheetFields([{ code: 'note', label: 'Замечание', type: 'text' }], { note: 'старое' });
    const after = buildWorkSheetFields(cols, { note: 'исправленное' });
    expect(missingRequiredWorkSheetFields(cols, after, before)).toEqual([]);
  });

  it('очистить уже заполненное обязательное поле по-прежнему нельзя', () => {
    const before = buildWorkSheetFields(cols, { hours: 4 });
    const after = buildWorkSheetFields(cols, {});
    expect(missingRequiredWorkSheetFields(cols, after, before)).toEqual(['Часы']);
  });
});

describe('колонки узла', () => {
  it('код из подписи — латиница без пробелов, устойчивая к повтору', () => {
    expect(workSheetCodeFromName('Часы обкатки')).toBe('chasy_obkatki');
    expect(workSheetCodeFromName('  №  ')).toBe('');
    expect(workSheetCodeFromName('2-я проверка')).toBe('x_2_ya_proverka');
  });

  it('чужой тип уходит в текст, дубли и пустые коды — вон', () => {
    const cols = sanitizeWorkSheetColumns([
      { code: 'hours', label: 'Часы', type: 'number' },
      { code: 'hours', label: 'Дубль', type: 'text' },
      { label: 'Мастер', type: 'weird' },
      { code: 'BAD CODE', label: 'x', type: 'text' },
      { code: 'res', label: 'Результат', type: 'choice', options: ['годен', 'годен', 'брак', ''] },
    ]);
    expect(cols.map((c) => c.code)).toEqual(['hours', 'master', 'res']);
    expect(cols[1]?.type).toBe('text');
    expect(cols[2]?.options).toEqual(['годен', 'брак']);
  });
});

describe('значения полей', () => {
  it('нормализуются по типу: число с запятой, дата в мс, да/нет словами', () => {
    expect(normalizeWorkSheetValue('number', '4,5')).toBe(4.5);
    expect(normalizeWorkSheetValue('number', 'abc')).toBeNull();
    expect(normalizeWorkSheetValue('boolean', 'да')).toBe(true);
    expect(normalizeWorkSheetValue('boolean', 'нет')).toBe(false);
    expect(normalizeWorkSheetValue('boolean', '')).toBeNull();
    expect(normalizeWorkSheetValue('date', '2026-09-15')).toBe(Date.parse('2026-09-15T00:00:00'));
    expect(normalizeWorkSheetValue('text', '  x  ')).toBe('x');
  });

  it('поля собираются по колонкам и печатаются словами', () => {
    const cols = sanitizeWorkSheetColumns([
      { code: 'hours', label: 'Часы', type: 'number' },
      { code: 'ok', label: 'Годен', type: 'boolean', required: true },
      { code: 'stand_date', label: 'Дата стенда', type: 'date' },
    ]);
    const fields = buildWorkSheetFields(cols, { hours: 4, ok: true, stand_date: Date.parse('2026-09-15T00:00:00') });
    expect(workSheetFieldsSummary(fields)).toBe('Часы: 4 · Годен: да · Дата стенда: 15.09.2026');
    expect(formatWorkSheetValue({ type: 'number', value: 4.5 })).toBe('4,5');
    expect(missingRequiredWorkSheetFields(cols, buildWorkSheetFields(cols, { hours: 1 }))).toEqual(['Годен']);
  });

  it('разбор из meta терпит мусор и сохраняет подпись с типом', () => {
    const fields = parseWorkSheetFields([{ code: 'hours', label: 'Часы', type: 'number', value: '3' }, { code: '', value: 1 }, 'x']);
    expect(fields).toEqual([{ code: 'hours', label: 'Часы', type: 'number', value: 3 }]);
  });
});

describe('узлы по умолчанию', () => {
  it('обкатка завершает ремонт, коды уникальны и валидны', () => {
    const codes = DEFAULT_WORK_SHEET_TYPES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(DEFAULT_WORK_SHEET_TYPES.find((t) => t.code === 'obkatka')?.completesRepair).toBe(true);
    expect(DEFAULT_WORK_SHEET_TYPES.filter((t) => t.completesRepair)).toHaveLength(1);
  });
});

describe('ступени фильтра этапов работ', () => {
  const row = (over: Partial<WorkSheetRow>): WorkSheetRow => ({
    id: 'r',
    engineId: 'e',
    engineNumber: '001',
    engineBrand: 'В-46',
    internalNumber: '',
    at: 100,
    typeId: 't',
    typeCode: 'obkatka',
    typeName: 'Обкатка',
    workshopId: '',
    workshopName: '',
    performedBy: 'Иванов',
    note: '',
    fields: [],
    ...over,
  });

  it('на каждую колонку узла — своя ступень, по типу колонки', () => {
    const facets = workSheetFacets([
      { code: 'hours', label: 'Часы', type: 'number' },
      { code: 'stand_date', label: 'Дата стенда', type: 'date' },
    ]);
    expect(facets.map((f) => f.id)).toEqual([
      'type',
      'engineBrand',
      'customer',
      'contract',
      'workshop',
      'performedBy',
      'date',
      'f:hours',
      'f:stand_date',
    ]);
    expect(facets.find((f) => f.id === 'f:stand_date')?.kind).toBe('dateRange');
  });

  it('значения колонки отбирают строки и считаются словами', () => {
    const facets = workSheetFacets([{ code: 'res', label: 'Результат', type: 'choice' }]);
    const rows = [
      row({ id: 'a', fields: [{ code: 'res', label: 'Результат', type: 'choice', value: 'годен' }] }),
      row({ id: 'b', fields: [{ code: 'res', label: 'Результат', type: 'choice', value: 'брак' }] }),
      row({ id: 'c' }),
    ];
    const options = facetOptions(facets, rows, {}, 'f:res');
    expect(options.map((o) => [o.label, o.count])).toEqual(expect.arrayContaining([['годен', 1], ['брак', 1]]));
    expect(applyFacets(facets, rows, { 'f:res': ['брак'] }).map((r) => r.id)).toEqual(['b']);
  });

  // Пока потолок значения ступени был ниже потолка текстового поля, длинное значение резалось
  // при сохранении выбора, переставало совпадать со значением строки — и ступень молча
  // переставала отбирать: выбор в интерфейсе есть, отбора нет.
  it('длинное значение поля отбирается: потолок ступени не ниже потолка поля', () => {
    const long = 'я'.repeat(WORK_SHEET_MAX_TEXT);
    const facets = workSheetFacets([{ code: 'res', label: 'Результат', type: 'text' }]);
    const rows = [
      row({ id: 'a', fields: [{ code: 'res', label: 'Результат', type: 'text', value: long }] }),
      row({ id: 'b', fields: [{ code: 'res', label: 'Результат', type: 'text', value: 'коротко' }] }),
    ];
    const selection = sanitizeFacetSelection(facets, { 'f:res': [long] });
    expect((selection['f:res'] as string[])[0]).toHaveLength(WORK_SHEET_MAX_TEXT);
    expect(applyFacets(facets, rows, selection).map((r) => r.id)).toEqual(['a']);
  });

  it('подпись ступени «Цех» — имя из строки, а не uuid', () => {
    const facets = workSheetFacets([]);
    const rows = [
      row({ id: 'a', workshopId: '0f3f2a6e-0000-4000-8000-000000000001', workshopName: 'Цех № 4' }),
      row({ id: 'b', workshopId: '0f3f2a6e-0000-4000-8000-000000000002', workshopName: '' }),
    ];
    const labels = facetOptions(facets, rows, {}, 'workshop').map((o) => o.label);
    expect(labels).toContain('Цех № 4');
    expect(labels.some((l) => l.includes('0f3f2a6e'))).toBe(false);
  });
});
