import { describe, expect, it } from 'vitest';

import {
  applyHandleClick,
  claimMoveOwner,
  computeBlockMove,
  currentMoveOwner,
  describeMoveResult,
  registerMoveOwner,
  releaseMoveOwner,
} from './listKeyboardMove.js';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('клик по ручке', () => {
  it('обычный клик включает режим перемещения этой строки', () => {
    expect(applyHandleClick({ keys: [] }, 'c', order, 'replace')).toEqual({ keys: ['c'] });
  });

  it('повторный клик по той же ручке снимает режим', () => {
    const active = { keys: ['c'] };
    expect(applyHandleClick(active, 'c', order, 'replace')).toEqual({ keys: [] });
  });

  it('Ctrl+клик добавляет строку в блок и убирает её', () => {
    const added = applyHandleClick({ keys: ['b'] }, 'd', order, 'add');
    expect(added.keys).toEqual(['b', 'd']);
    expect(applyHandleClick(added, 'd', order, 'add').keys).toEqual(['b']);
  });

  it('Shift+клик выделяет диапазон строк', () => {
    expect(applyHandleClick({ keys: ['b'] }, 'd', order, 'range').keys).toEqual(['b', 'c', 'd']);
  });
});

describe('перемещение блоком', () => {
  it('одна строка вверх — меняется местами с соседом сверху', () => {
    expect(computeBlockMove(order, ['c'], -1).order).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('одна строка вниз — меняется местами с соседом снизу', () => {
    expect(computeBlockMove(order, ['c'], 1).order).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('блок из двух строк вверх двигается целиком', () => {
    const result = computeBlockMove(order, ['c', 'd'], -1);
    expect(result.order).toEqual(['a', 'c', 'd', 'b', 'e']);
    expect(result.moved).toBe(true);
  });

  it('блок из двух строк вниз двигается целиком', () => {
    expect(computeBlockMove(order, ['b', 'c'], 1).order).toEqual(['a', 'd', 'b', 'c', 'e']);
  });

  it('край списка — строка не двигается (и об этом сказано)', () => {
    const top = computeBlockMove(order, ['a'], -1);
    expect(top.moved).toBe(false);
    expect(top.order).toEqual(order);
    const bottom = computeBlockMove(order, ['e'], 1);
    expect(bottom.moved).toBe(false);
  });

  it('пустой блок и неизвестные ключи — порядок не меняется', () => {
    expect(computeBlockMove(order, [], -1)).toEqual({ order, moved: false });
    expect(computeBlockMove(order, ['zzz'], 1)).toEqual({ order, moved: false });
  });

  it('объявление результата — для скринридера и для подсказки', () => {
    const moved = describeMoveResult(['a', 'c', 'b'], ['c'], true);
    expect(moved).toContain('позиция: 2');
    expect(describeMoveResult(order, ['a'], false)).toContain('край списка');
  });
});

describe('активен только один список', () => {
  it('ручка второго списка снимает режим первого — стрелка двигает один список', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    let firstCleared = 0;
    const unregisterFirst = registerMoveOwner(first, () => {
      firstCleared += 1;
    });
    const unregisterSecond = registerMoveOwner(second, () => {});

    claimMoveOwner(first);
    expect(currentMoveOwner()).toBe(first);

    claimMoveOwner(second);
    expect(firstCleared, 'режим прежнего списка не сняли').toBe(1);
    expect(currentMoveOwner()).toBe(second);

    unregisterFirst();
    unregisterSecond();
  });

  it('снятие регистрации освобождает режим перемещения', () => {
    const owner = Symbol('solo');
    const unregister = registerMoveOwner(owner, () => {});
    claimMoveOwner(owner);
    expect(currentMoveOwner()).toBe(owner);
    unregister();
    expect(currentMoveOwner()).toBe(null);
  });

  it('отпустить режим может только его владелец', () => {
    const owner = Symbol('owner');
    const other = Symbol('other');
    const unregister = registerMoveOwner(owner, () => {});
    claimMoveOwner(owner);
    releaseMoveOwner(other);
    expect(currentMoveOwner(), 'чужой список снял режим не того, кто двигает').toBe(owner);
    releaseMoveOwner(owner);
    expect(currentMoveOwner()).toBe(null);
    unregister();
  });
});
