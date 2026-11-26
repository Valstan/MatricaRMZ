// Правило «какой поиск рисуется на полосе» (промт КАРМАНА #166).
//
// Поисков бывает несколько: глобальная палитра запускает новый поиск на
// каждый введённый символ, и старый ещё доезжает до финала. Полоса одна на
// программу — значит, она должна показывать последний начатый поиск, а финал
// чужого (уже неактуального) поиска не должен её гасить: иначе мигающий
// глобальный поиск прятал бы полосу идущего обхода папок.

import { describe, expect, it } from 'vitest';

import type { SearchProgressEvent } from '@matricarmz/shared';

import { applySearchProgressEvent, type SearchProgressSlot } from '../services/searchProgressService.js';

const EMPTY: SearchProgressSlot = { searchId: null, event: null };

function evt(searchId: string, state: SearchProgressEvent['state'], patch: Partial<SearchProgressEvent> = {}) {
  return {
    searchId,
    kind: 'folders',
    state,
    title: 'Поиск по папкам',
    current: null,
    detail: null,
    scanned: null,
    total: null,
    found: null,
    progress: null,
    startedAt: 1,
    elapsedMs: 1,
    updatedAt: 2,
    error: null,
    ...patch,
  } satisfies SearchProgressEvent;
}

describe('кто рисуется на полосе прогресса', () => {
  it('начатый поиск занимает полосу', () => {
    const next = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    expect(next.searchId).toBe('a');
    expect(next.event?.state).toBe('start');
  });

  it('ход поиска обновляет полосу', () => {
    const started = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    const next = applySearchProgressEvent(started, evt('a', 'progress', { current: 'Э06АТ0889' }));
    expect(next.event?.current).toBe('Э06АТ0889');
  });

  it('законченный поиск прячет полосу', () => {
    const started = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    const next = applySearchProgressEvent(started, evt('a', 'done'));
    expect(next.event).toBeNull();
    expect(next.searchId).toBeNull();
  });

  it('отменённый поиск остаётся виден: оператор должен прочитать, что произошло', () => {
    const started = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    const next = applySearchProgressEvent(started, evt('a', 'cancelled'));
    expect(next.event?.state).toBe('cancelled');
  });

  it('ошибка остаётся видна', () => {
    const started = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    const next = applySearchProgressEvent(started, evt('a', 'error', { error: 'диск недоступен' }));
    expect(next.event?.state).toBe('error');
    expect(next.event?.error).toBe('диск недоступен');
  });

  it('новый поиск вытесняет прежний с полосы', () => {
    const first = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    const second = applySearchProgressEvent(first, evt('b', 'start'));
    expect(second.searchId).toBe('b');
  });

  it('финал чужого (устаревшего) поиска не гасит полосу текущего', () => {
    const first = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    const second = applySearchProgressEvent(first, evt('b', 'start'));
    const afterOldDone = applySearchProgressEvent(second, evt('a', 'done'));
    expect(afterOldDone.searchId).toBe('b');
    expect(afterOldDone.event?.searchId).toBe('b');
  });

  it('ход устаревшего поиска не перехватывает полосу', () => {
    const first = applySearchProgressEvent(EMPTY, evt('a', 'start'));
    const second = applySearchProgressEvent(first, evt('b', 'start'));
    const afterOldProgress = applySearchProgressEvent(second, evt('a', 'progress', { current: 'старая папка' }));
    expect(afterOldProgress.event?.searchId).toBe('b');
  });
});
