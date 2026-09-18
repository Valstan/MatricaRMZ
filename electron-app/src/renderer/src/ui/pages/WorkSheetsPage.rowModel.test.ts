import { describe, expect, it } from 'vitest';

import type { WorkSheetRow } from '@matricarmz/shared';

import { buildWorkSheetListItems } from './WorkSheetsPage.js';

/**
 * Ряды списка этапов работ (C2, 16.09.2026): строка правится прямо в списке, и редактор
 * занимает ДВА соседних ряда — сам редактор и полку с кнопками.
 *
 * До C2 «где строка» считалось индексной арифметикой по допущению «служебный ряд один и он
 * сверху»; третий вид ряда ронял `getRowKey` на `undefined.id` и убивал рендер всего списка.
 * Поэтому сборка рядов вынесена в чистую функцию, а здесь сторожатся её СВОЙСТВА, а не
 * сегодняшний текст: нумерация без дыр, один редактор на экран, полка сразу под ним, строка
 * показана один раз, `sorted` не тронут. Переписать функцию иначе можно — нарушить эти пять
 * обещаний нельзя: номер строки диктуют по телефону, а по счётчику «Всего · Показано» сверяют
 * выработку.
 */

type SheetItem = ReturnType<typeof buildWorkSheetListItems>[number];
type SheetEditor = NonNullable<Parameters<typeof buildWorkSheetListItems>[1]>;
type EditorItem = Extract<SheetItem, { kind: 'editor' }>;

/** Фикстуры вымышленные: ФИО и рабочие логины в отслеживаемых файлах не держим (AGENTS.md). */
function row(id: string): WorkSheetRow {
  return {
    id,
    engineId: `engine-${id}`,
    engineNumber: `ТЕСТ-${id}`,
    engineBrand: 'ТЕСТ-МАРКА',
    internalNumber: `ВН-${id}`,
    customerName: 'ООО «Пример»',
    customerFullName: 'Общество с ограниченной ответственностью «Пример»',
    contractNumber: `ДГ-${id}`,
    contractShortLabel: `ДГ-${id}`,
    at: Date.UTC(2026, 8, 15),
    typeId: 'type-obkatka',
    typeCode: 'obkatka',
    typeName: 'Обкатка',
    workshopId: 'workshop-1',
    workshopName: 'Цех сборки',
    performedBy: 'oper',
    note: '',
    fields: [],
    repairStamped: false,
    repeatPass: 1,
  };
}

/** Редактор правки записанной строки: id равен id строки — сохранение идёт upsert'ом. */
function editorOf(base: WorkSheetRow): SheetEditor {
  return {
    base,
    id: base.id,
    typeCode: base.typeCode,
    engineId: base.engineId,
    date: '2026-09-16',
    workshopId: base.workshopId,
    values: {},
    note: base.note,
    busy: false,
    error: '',
    dirty: false,
    escArmed: false,
    focusColId: null,
  };
}

/** Редактор нового этапа работ: своей строки в списке у него ещё нет. */
function newEditor(id = 'draft-1'): SheetEditor {
  return { ...editorOf(row(id)), base: null, id };
}

/** Номера, которые ряды несут сами: у полки номера нет, у нового этапа он пуст. */
function numbering(items: SheetItem[]): number[] {
  return items.flatMap((item) => (item.kind === 'actions' || item.number === null ? [] : [item.number]));
}

function rowIds(items: SheetItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'row' ? [item.row.id] : []));
}

function editorItem(items: SheetItem[]): EditorItem | undefined {
  return items.find((item): item is EditorItem => item.kind === 'editor');
}

/**
 * Свойства, обязательные в ЛЮБОМ состоянии экрана. Проверяются в каждом кейсе целиком:
 * «пара не больше одной» и «нумерация без дыр» стоят дорого ровно тогда, когда держатся
 * сразу во всех положениях редактора, а не в одном удачном.
 */
function expectListInvariants(sorted: WorkSheetRow[], editor: SheetEditor | null): SheetItem[] {
  const before = sorted.map((r) => r.id);
  const items = buildWorkSheetListItems(sorted, editor);
  const kinds = items.map((item) => item.kind);

  // Номер строки диктуют по телефону: «строка 7» обязана быть седьмой сверху и при открытом
  // редакторе. Поэтому правка несёт СВОЙ номер, а новый этап и полка — пустой.
  expect(numbering(items), 'номера настоящих строк — 1..N без дыр при любом редакторе').toEqual(
    Array.from({ length: sorted.length }, (_, i) => i + 1),
  );

  // Один редактор на экран: вторая пара означала бы два набранных состояния одной строки,
  // и «Сохранить» записало бы неизвестно какое.
  expect(kinds.filter((k) => k === 'editor').length, 'редактор на экране ровно один').toBe(editor ? 1 : 0);
  expect(kinds.filter((k) => k === 'actions').length, 'полка есть только у открытого редактора, и она одна').toBe(
    editor ? 1 : 0,
  );
  if (editor) {
    // Полка стоит СРАЗУ под редактором: на этом держится и чтение «одним блоком», и Tab из
    // последнего поля на «Сохранить».
    const at = kinds.indexOf('editor');
    expect(kinds[at + 1], 'полка с кнопками идёт сразу за редактором').toBe('actions');

    // Правимая строка показана один раз — редактором, а не вторым экземпляром себя самой.
    const shown = items.flatMap((item) =>
      item.kind === 'row' ? [item.row.id] : item.kind === 'editor' ? [editor.id] : [],
    );
    expect(shown.filter((id) => id === editor.id), 'правимая строка на экране одна').toHaveLength(1);
  }

  // Состав и порядок настоящих строк не зависят от редактора: список — это по-прежнему `sorted`.
  const editedId = editor?.base ? editor.id : null;
  expect(rowIds(items), 'строки идут в порядке sorted, ни одна не потеряна').toEqual(
    sorted.map((r) => r.id).filter((id) => id !== editedId),
  );

  // Служебные ряды строятся ПОВЕРХ `sorted` и в него не попадают: тот же массив уходит в
  // счётчик «Всего · Показано» и в печать, и врать на единицу он не должен.
  expect(sorted.map((r) => r.id), 'исходный массив строк не изменён').toEqual(before);

  return items;
}

const rows = [row('a'), row('b'), row('c'), row('d'), row('e')];
/** Нумерация того же списка без редактора — эталон, с которым сверяются все остальные кейсы. */
const baselineNumbers = new Map(
  buildWorkSheetListItems(rows, null).flatMap((item): [string, number][] =>
    item.kind === 'row' ? [[item.row.id, item.number]] : [],
  ),
);

describe('buildWorkSheetListItems — ряды списка этапов работ', () => {
  it('без редактора рядов ровно столько, сколько строк', () => {
    const items = expectListInvariants(rows, null);

    expect(items).toHaveLength(rows.length);
    expect(items.every((item) => item.kind === 'row'), 'служебных рядов без редактора нет вовсе').toBe(true);
  });

  for (const [where, index] of [
    ['в начале', 0],
    ['в середине', 2],
    ['в конце', rows.length - 1],
  ] as const) {
    it(`правка ${where} списка раздвигает свою строку и не двигает номера остальных`, () => {
      const base = rows[index]!;
      const items = expectListInvariants(rows, editorOf(base));

      // Редактор встаёт НА МЕСТО своей строки — иначе правка выглядела бы переездом записи.
      expect(items.findIndex((item) => item.kind === 'editor'), 'редактор на месте своей строки').toBe(index);
      expect(editorItem(items)?.number, 'правка несёт номер своей строки').toBe(index + 1);

      // Открытие редактора не перенумеровывает соседей: иначе номер «прыгал» бы на 1 при
      // каждом щелчке, и сверять список с бумагой стало бы нечем.
      for (const item of items) {
        if (item.kind !== 'row') continue;
        expect(item.number, `номер строки ${item.row.id} не сдвинулся`).toBe(baselineNumbers.get(item.row.id));
      }
    });
  }

  it('новый этап работ — пара рядов сверху и без номера', () => {
    const items = expectListInvariants(rows, newEditor());

    expect(items.map((item) => item.kind).slice(0, 2), 'новый заводится сверху, а не в конце').toEqual(['editor', 'actions']);
    // Номера у нового нет: он ещё не строка списка, а «Показано» считает только записанное.
    expect(editorItem(items)?.number, 'у незаписанного этапа номера нет').toBeNull();
    expect(items).toHaveLength(rows.length + 2);
  });

  it('пустой список: новый этап работ — единственная пара рядов', () => {
    const items = expectListInvariants([], newEditor());

    expect(items.map((item) => item.kind)).toEqual(['editor', 'actions']);
  });

  it('правимая строка выпала из выборки — пара уезжает наверх, нумерация остальных цела', () => {
    // Сменился период или фильтр, строку удалили на другом устройстве — редактор НЕ закрывается
    // сам: набранное иначе исчезло бы молча. Пара поднимается наверх, а полка объясняет словами.
    const gone = row('z');
    const items = expectListInvariants(rows, editorOf(gone));

    expect(items.map((item) => item.kind).slice(0, 2), 'правка выпавшей строки видна сверху').toEqual(['editor', 'actions']);
    expect(editorItem(items)?.number, 'номера у выпавшей строки нет — она не в выборке').toBeNull();
    expect(rowIds(items), 'остальные строки остались все').toEqual(rows.map((r) => r.id));
    expect(numbering(items), 'нумерация выборки не сдвинулась').toEqual([1, 2, 3, 4, 5]);
  });
});
