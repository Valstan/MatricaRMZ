import { describe, expect, it } from 'vitest';

import {
  formatSearchProgressCounters,
  formatSearchProgressCurrent,
  formatSearchProgressElapsed,
  isSearchProgressActive,
  searchProgressCounterNoun,
  searchProgressPercent,
  searchProgressStateLabel,
  type SearchProgressEvent,
} from './searchProgress.js';

// Общий прогресс поиска (промт КАРМАНА #166). Проверяем форму: полоса рисуется
// одна и та же в любом месте программы, поэтому подписи считаются чистыми
// функциями, а не «как получится» в каждом экране.

function evt(patch: Partial<SearchProgressEvent> = {}): SearchProgressEvent {
  return {
    searchId: 'search_1',
    kind: 'folders',
    state: 'progress',
    title: 'Поиск по папкам',
    current: null,
    detail: null,
    scanned: null,
    total: null,
    found: null,
    progress: null,
    startedAt: 1_000,
    elapsedMs: 5_000,
    updatedAt: 6_000,
    error: null,
    ...patch,
  };
}

describe('подписи прогресса поиска', () => {
  it('счётчики: сколько просмотрено из скольких и сколько найдено', () => {
    expect(formatSearchProgressCounters(evt({ scanned: 12, total: 40, found: 3 }))).toBe(
      'Просмотрено папок: 12 из 40 · Найдено: 3',
    );
  });

  it('счётчик без «из» — когда всего не знаем', () => {
    expect(formatSearchProgressCounters(evt({ scanned: 7, total: null, found: 0 }))).toBe(
      'Просмотрено папок: 7 · Найдено: 0',
    );
  });

  it('счётчики различают вид поиска: файлы, карточки, источники', () => {
    expect(searchProgressCounterNoun('files')).toBe('файлов');
    expect(searchProgressCounterNoun('cards')).toBe('карточек');
    expect(searchProgressCounterNoun('global')).toBe('источников');
    expect(formatSearchProgressCounters(evt({ kind: 'cards', scanned: 400, total: 900, found: 1 }))).toBe(
      'Просмотрено карточек: 400 из 900 · Найдено: 1',
    );
  });

  it('пустые счётчики не рисуются мусором', () => {
    expect(formatSearchProgressCounters(evt())).toBe('');
  });

  it('текущий объект виден строкой, а без объекта строки нет', () => {
    expect(formatSearchProgressCurrent(evt({ current: 'Э06АТ0889' }))).toBe('Сейчас смотрим: Э06АТ0889');
    expect(formatSearchProgressCurrent(evt())).toBe('');
  });

  it('прошедшее время — по-человечески: секунды и минуты', () => {
    expect(formatSearchProgressElapsed(12_000)).toBe('прошло 12 с');
    expect(formatSearchProgressElapsed(65_000)).toBe('прошло 1 мин 05 с');
    expect(formatSearchProgressElapsed(-5)).toBe('прошло 0 с');
  });

  it('процент: из доли или из счётчиков, а когда неизвестно — null', () => {
    expect(searchProgressPercent(evt({ progress: 0.42 }))).toBe(42);
    expect(searchProgressPercent(evt({ scanned: 1, total: 4 }))).toBe(25);
    expect(searchProgressPercent(evt())).toBeNull();
  });

  it('активен ли поиск: start/progress — да, остальное — нет', () => {
    expect(isSearchProgressActive('start')).toBe(true);
    expect(isSearchProgressActive('progress')).toBe(true);
    expect(isSearchProgressActive('done')).toBe(false);
    expect(isSearchProgressActive('cancelled')).toBe(false);
    expect(isSearchProgressActive('error')).toBe(false);
  });

  it('финальные состояния называются по-человечески', () => {
    expect(searchProgressStateLabel(evt({ state: 'cancelled' }))).toBe('Поиск отменён');
    expect(searchProgressStateLabel(evt({ state: 'done' }))).toBe('Поиск закончен');
    expect(searchProgressStateLabel(evt({ state: 'error', error: 'диск недоступен' }))).toBe(
      'Ошибка поиска: диск недоступен',
    );
    expect(searchProgressStateLabel(evt({ state: 'progress' }))).toBe('');
  });
});
