import { afterEach, describe, expect, it, vi } from 'vitest';

import React from 'react';

import { buildReportContextColumns, buildReportListActions } from './reportListKit.js';

type Row = { id: string; name: string; note: string };

const rows: Row[] = [
  { id: 'a', name: 'А', note: 'первый' },
  { id: 'b', name: 'Б', note: 'второй' },
];

const columns = [
  { id: 'name', label: 'Название', render: (row: Row) => row.name },
  { id: 'note', label: 'Примечание', render: (row: Row) => row.note, printValue: (row: Row) => `заметка: ${row.note}` },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('отчётный список объявляет свои действия', () => {
  it('удалять в отчёте нечего — пункта «Удалить» в объявлении нет ВООБЩЕ', () => {
    const actions = buildReportListActions<Row>({
      contextColumns: buildReportContextColumns(columns),
      onPrint: vi.fn(),
    });
    expect(actions.map((a) => a.id)).toEqual(['print', 'copy']);
    expect(actions.some((a) => a.label === 'Удалить')).toBe(false);
    // Не «гасится серым», а отсутствует: объявления «удалить» здесь просто нет.
    expect(actions.some((a) => a.available === false)).toBe(false);
  });

  it('печать отдаёт ровно те строки, к которым открыто меню', () => {
    const onPrint = vi.fn();
    const actions = buildReportListActions<Row>({
      contextColumns: buildReportContextColumns(columns),
      onPrint,
    });
    actions.find((a) => a.id === 'print')!.run([rows[1]!]);
    expect(onPrint).toHaveBeenCalledWith([rows[1]]);
  });

  it('копирование кладёт в буфер видимые колонки и докладывает оператору, сколько строк', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onStatus = vi.fn();
    const actions = buildReportListActions<Row>({
      contextColumns: buildReportContextColumns(columns),
      onPrint: vi.fn(),
      onStatus,
    });
    await actions.find((a) => a.id === 'copy')!.run(rows);
    // Копирование асинхронно (буфер), а действие меню возвращает void — ждём микротакты.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('Название: А');
    expect(writeText.mock.calls[0]![0]).toContain('заметка: первый');
    expect(onStatus).toHaveBeenCalledWith('Скопировано строк: 2');
  });
});

describe('колонки копирования — те же, что на экране', () => {
  it('текст берётся из того же render, что и печать', () => {
    const contextColumns = buildReportContextColumns(columns);
    expect(contextColumns.map((c) => c.title)).toEqual(['Название', 'Примечание']);
    expect(contextColumns[0]!.value(rows[0]!)).toBe('А');
  });

  it('явный printValue важнее разметки — как в печати', () => {
    const contextColumns = buildReportContextColumns(columns);
    expect(contextColumns[1]!.value(rows[0]!)).toBe('заметка: первый');
  });

  it('вложенная разметка читается как текст, а не теряется', () => {
    const contextColumns = buildReportContextColumns([
      {
        id: 'x',
        label: 'Помечен',
        render: (row: Row) => React.createElement('span', { title: 'рекламация' }, row.name),
      },
    ]);
    expect(contextColumns[0]!.value(rows[0]!)).toBe('А');
  });
});
