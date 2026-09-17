import { describe, expect, it } from 'vitest';

import {
  PICKER_RANK_CAP,
  bumpPickerRank,
  parsePickerRankStore,
  rankOptionsByPick,
  type PickerRankScope,
  type PickerRankStore,
} from './pickerRank.js';

const opt = (id: string, label = id) => ({ id, label });

describe('rankOptionsByPick', () => {
  it('поднимает наверх того, кого выбирают чаще, а не того, кого выбрали последним', () => {
    // Смысл всего D4 одной проверкой: recency ставила бы «Редкого» первым (его выбрали
    // позже всех), частота оставляет наверху того, кого оператор берёт каждый день.
    const scope: PickerRankScope = {
      often: { n: 12, last: 1_000 },
      rare: { n: 1, last: 9_999 },
    };
    const out = rankOptionsByPick([opt('rare'), opt('often'), opt('never')], scope);
    expect(out.map((o) => o.id)).toEqual(['often', 'rare', 'never']);
  });

  it('при равной частоте вперёд идёт более свежий выбор', () => {
    const scope: PickerRankScope = { a: { n: 3, last: 100 }, b: { n: 3, last: 200 } };
    expect(rankOptionsByPick([opt('a'), opt('b')], scope).map((o) => o.id)).toEqual(['b', 'a']);
  });

  it('при равных счётчиках порядок решает алфавит', () => {
    const scope: PickerRankScope = { x: { n: 2, last: 50 }, y: { n: 2, last: 50 } };
    const out = rankOptionsByPick([opt('x', 'Яковлев'), opt('y', 'Абрамов')], scope);
    expect(out.map((o) => o.label)).toEqual(['Абрамов', 'Яковлев']);
  });

  it('хвост сохраняет ИСХОДНЫЙ порядок вызывающего, а не пересортировывается', () => {
    // Порядок списка — решение вызывающего (алфавит, группировка, уволенные в конце);
    // рейтинг вправе только поднять своих наверх.
    const scope: PickerRankScope = { b: { n: 5, last: 1 } };
    const out = rankOptionsByPick([opt('z', 'Яшин'), opt('a', 'Антонов'), opt('b', 'Борисов')], scope);
    expect(out.map((o) => o.id)).toEqual(['b', 'z', 'a']);
  });

  it('пустой рейтинг и рейтинг без пересечений со списком ничего не меняют', () => {
    const list = [opt('a'), opt('b')];
    expect(rankOptionsByPick(list, undefined).map((o) => o.id)).toEqual(['a', 'b']);
    expect(rankOptionsByPick(list, {}).map((o) => o.id)).toEqual(['a', 'b']);
    expect(rankOptionsByPick(list, { чужой: { n: 9, last: 9 } }).map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('не мутирует переданный массив опций', () => {
    const list = [opt('a'), opt('b')];
    rankOptionsByPick(list, { b: { n: 1, last: 1 } });
    expect(list.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('bumpPickerRank', () => {
  it('считает выборы и запоминает время последнего', () => {
    const one = bumpPickerRank({}, 'employee:approver', 'emp-1', 1_000);
    const two = bumpPickerRank(one, 'employee:approver', 'emp-1', 2_000);
    expect(two['employee:approver']?.['emp-1']).toEqual({ n: 2, last: 2_000 });
  });

  it('точки выбора не делят счётчики: у «утверждающего» и «экипажа» разные люди', () => {
    let store: PickerRankStore = {};
    store = bumpPickerRank(store, 'employee:approver', 'chief', 1);
    store = bumpPickerRank(store, 'employee:work-order-crew', 'worker', 2);
    expect(Object.keys(store['employee:approver'] ?? {})).toEqual(['chief']);
    expect(Object.keys(store['employee:work-order-crew'] ?? {})).toEqual(['worker']);
  });

  it('возвращает НОВОЕ хранилище и не трогает прежнее', () => {
    // На этом держится синглтон хука: два поля на экране читают одну правду и не
    // затирают счётчики друг друга своей копией состояния.
    const before: PickerRankStore = { k: { a: { n: 1, last: 1 } } };
    const after = bumpPickerRank(before, 'k', 'a', 5);
    expect(before.k?.a).toEqual({ n: 1, last: 1 });
    expect(after.k?.a).toEqual({ n: 2, last: 5 });
  });

  it('пустой ключ или пустой id не меняют хранилище', () => {
    const store: PickerRankStore = { k: { a: { n: 1, last: 1 } } };
    expect(bumpPickerRank(store, '', 'a', 5)).toBe(store);
    expect(bumpPickerRank(store, 'k', '   ', 5)).toBe(store);
  });

  it('обрезает хвост по тому же правилу, по которому сортирует: редкие уходят первыми', () => {
    let store: PickerRankStore = {};
    for (let i = 0; i < PICKER_RANK_CAP + 5; i += 1) {
      store = bumpPickerRank(store, 'k', `emp-${i}`, 1_000 + i);
    }
    // Все по одному выбору — остаются самые свежие; счётчик выживания — n, потом last.
    const scope = store.k ?? {};
    expect(Object.keys(scope)).toHaveLength(PICKER_RANK_CAP);
    expect(scope['emp-0']).toBeUndefined();
    expect(scope[`emp-${PICKER_RANK_CAP + 4}`]).toEqual({ n: 1, last: 1_000 + PICKER_RANK_CAP + 4 });
  });

  it('новичок пробивается в ПОЛНЫЙ рейтинг, а не выбывает на каждом выборе', () => {
    // Рейтинг, который нельзя пополнить, — замёрзший рейтинг. Кэп, занятый людьми с n≥2,
    // выбрасывал новичка сразу после записи (он входит с n=1 и тут же слабейший), поэтому
    // сколько его ни выбирай, счётчик каждый раз начинался с нуля: новый сотрудник не мог
    // попасть в подсказку НИКОГДА. Броня «только что выбранного» это чинит.
    let store: PickerRankStore = {};
    for (let i = 0; i < PICKER_RANK_CAP; i += 1) {
      store = bumpPickerRank(store, 'k', `старый-${i}`, 1_000 + i);
      store = bumpPickerRank(store, 'k', `старый-${i}`, 2_000 + i);
    }
    for (let day = 0; day < 5; day += 1) store = bumpPickerRank(store, 'k', 'новичок', 9_000 + day);
    expect(store.k?.['новичок']).toEqual({ n: 5, last: 9_004 });
    expect(Object.keys(store.k ?? {})).toHaveLength(PICKER_RANK_CAP);
  });

  it('новичок вытесняет слабейшего из ОСТАЛЬНЫХ, а не переполняет список', () => {
    let store: PickerRankStore = {};
    for (let i = 0; i < PICKER_RANK_CAP; i += 1) store = bumpPickerRank(store, 'k', `старый-${i}`, 1_000 + i);
    store = bumpPickerRank(store, 'k', 'новичок', 9_000);
    const scope = store.k ?? {};
    expect(Object.keys(scope)).toHaveLength(PICKER_RANK_CAP);
    expect(scope['новичок']).toEqual({ n: 1, last: 9_000 });
    // Выбыл самый давний из равных по частоте — правило вытеснения то же, что правило сортировки.
    expect(scope['старый-0']).toBeUndefined();
  });

  it('частый переживает обрезку, даже если выбран давно', () => {
    let store: PickerRankStore = bumpPickerRank({}, 'k', 'старожил', 1);
    for (let i = 0; i < 9; i += 1) store = bumpPickerRank(store, 'k', 'старожил', 2);
    for (let i = 0; i < PICKER_RANK_CAP + 5; i += 1) store = bumpPickerRank(store, 'k', `emp-${i}`, 5_000 + i);
    expect(store.k?.['старожил']?.n).toBe(10);
  });
});

describe('parsePickerRankStore', () => {
  it('читает своё', () => {
    const raw = { 'employee:approver': { 'emp-1': { n: 3, last: 42 } } };
    expect(parsePickerRankStore(raw)).toEqual(raw);
  });

  it('чужое и испорченное даёт пустой рейтинг, а не падение', () => {
    // Рейтинг — подсказка порядка, а не данные: испорченное хранилище обязано молча
    // выродиться в алфавит вызывающего, а не сломать поле выбора сотрудника.
    expect(parsePickerRankStore(null)).toEqual({});
    expect(parsePickerRankStore('строка')).toEqual({});
    expect(parsePickerRankStore([1, 2, 3])).toEqual({});
    expect(parsePickerRankStore({ k: 'не объект' })).toEqual({});
    expect(parsePickerRankStore({ k: { a: { n: 'три', last: 1 } } })).toEqual({});
    expect(parsePickerRankStore({ k: { a: { n: 0, last: 1 } } })).toEqual({});
    expect(parsePickerRankStore({ k: { a: { n: 2 } } })).toEqual({});
  });

  it('выбрасывает мусор порознь, сохраняя годные записи', () => {
    const out = parsePickerRankStore({ k: { good: { n: 2, last: 7 }, bad: { n: -1, last: 7 } } });
    expect(out).toEqual({ k: { good: { n: 2, last: 7 } } });
  });
});
