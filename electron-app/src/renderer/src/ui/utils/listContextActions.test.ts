import { describe, expect, it, vi } from 'vitest';

import {
  buildListContextMenuItems,
  listDeleteAction,
  listPrintAction,
  type ListActionDeclaration,
} from './listContextActions.js';

type Row = { id: string; name: string };

const rows: Row[] = [
  { id: 'a', name: 'А' },
  { id: 'b', name: 'Б' },
];

describe('меню списка собирается из объявления действий', () => {
  it('недоступное действие в меню ОТСУТСТВУЕТ, а не гасится серым', () => {
    const items = buildListContextMenuItems<Row>({
      rows: [rows[0]!],
      bulk: false,
      getId: (row) => row.id,
      actions: [
        listPrintAction({ available: true, print: vi.fn() }),
        // Удаление запрещено — пункта «Удалить» быть не должно вовсе (промт #67).
        listDeleteAction({ available: false, remove: vi.fn(), getId: (row) => row.id }),
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['print']);
    expect(items.some((i) => i.label === 'Удалить')).toBe(false);
    expect(items.every((i) => i.disabled !== true)).toBe(true);
  });

  it('доступное удаление появляется и в одиночном, и в папочном меню', () => {
    const single = buildListContextMenuItems<Row>({
      rows: [rows[0]!],
      bulk: false,
      getId: (row) => row.id,
      actions: [listDeleteAction({ available: true, remove: vi.fn(), getId: (row) => row.id })],
    });
    expect(single.map((i) => i.label)).toContain('Удалить');
    expect(single.find((i) => i.id === 'delete')?.danger).toBe(true);

    const bulk = buildListContextMenuItems<Row>({
      rows,
      bulk: true,
      getId: (row) => row.id,
      actions: [listDeleteAction({ available: true, remove: vi.fn(), getId: (row) => row.id })],
    });
    expect(bulk.map((i) => i.label)).toContain('Удалить выделенные (2)');
  });

  it('одно объявление обслуживает и одну строку, и пачку — с разными подписями', () => {
    const single = buildListContextMenuItems<Row>({
      rows: [rows[0]!],
      bulk: false,
      getId: (row) => row.id,
      actions: [listPrintAction({ available: true, print: vi.fn() })],
    });
    expect(single.map((i) => i.label)).toContain('Распечатать');

    const bulk = buildListContextMenuItems<Row>({
      rows,
      bulk: true,
      getId: (row) => row.id,
      actions: [listPrintAction({ available: true, print: vi.fn() })],
    });
    expect(bulk.map((i) => i.label)).toContain('Распечатать выделенные (2)');
  });

  it('scope: действие только для пачки не попадает в меню одной строки (и наоборот)', () => {
    const bulkOnly: ListActionDeclaration<Row> = {
      id: 'bulk-only',
      label: 'Только пачкой',
      available: true,
      scope: 'bulk',
      run: vi.fn(),
    };
    const singleOnly: ListActionDeclaration<Row> = {
      id: 'single-only',
      label: 'Только одной строкой',
      available: true,
      scope: 'single',
      run: vi.fn(),
    };
    const single = buildListContextMenuItems<Row>({
      rows: [rows[0]!],
      bulk: false,
      getId: (row) => row.id,
      actions: [bulkOnly, singleOnly],
    });
    expect(single.map((i) => i.id)).toEqual(['single-only']);

    const bulk = buildListContextMenuItems<Row>({
      rows,
      bulk: true,
      getId: (row) => row.id,
      actions: [bulkOnly, singleOnly],
    });
    expect(bulk.map((i) => i.id)).toEqual(['bulk-only']);
  });

  it('действие получает выбранные строки и отрабатывает по клику', () => {
    const print = vi.fn();
    const items = buildListContextMenuItems<Row>({
      rows,
      bulk: true,
      getId: (row) => row.id,
      actions: [listPrintAction({ available: true, print })],
    });
    items.find((i) => i.id === 'print')!.onClick();
    expect(print).toHaveBeenCalledWith(rows);
  });

  it('«Выделить» и «Снять выделение» — только когда список умеет выделять', () => {
    const withSelect = buildListContextMenuItems<Row>({
      rows: [rows[0]!],
      bulk: false,
      getId: (row) => row.id,
      onSelect: vi.fn(),
      onClearSelection: vi.fn(),
      hasSelection: true,
      actions: [],
    });
    expect(withSelect.map((i) => i.id)).toEqual(['select-row', 'clear-selected']);

    const withoutSelect = buildListContextMenuItems<Row>({
      rows: [rows[0]!],
      bulk: false,
      getId: (row) => row.id,
      actions: [],
    });
    expect(withoutSelect).toEqual([]);
  });

  it('пустой список — меню пустое', () => {
    expect(buildListContextMenuItems<Row>({ rows: [], bulk: false, getId: (r) => r.id, actions: [] })).toEqual([]);
  });
});
