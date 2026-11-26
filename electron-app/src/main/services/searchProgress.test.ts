// Общий прогресс поиска: главный процесс → окна (промт КАРМАНА #166).
//
// Проверяем то, что нельзя увидеть без живого клиента:
//  * событие уходит в ОКНА (как `sync:progress`), а не в ответ на вызов;
//  * подписка получает состояния поиска (start → progress → done);
//  * отмена действительно прерывает работу (сигнал отмены срабатывает);
//  * поток событий не заливает окно (троттлинг).

const sent: Array<{ channel: string; payload: any }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sent.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginSearchProgress,
  cancelSearchProgress,
  finishSearchProgress,
  listSearchProgress,
} from './searchProgress.js';

beforeEach(() => {
  sent.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function events(state: string) {
  return sent.filter((e) => e.payload?.state === state);
}

describe('канал прогресса поиска', () => {
  it('событие уходит в окна — по образцу sync:progress', () => {
    beginSearchProgress({ kind: 'folders', title: 'Поиск по папкам', total: 3 });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.channel).toBe('search:progress');
    expect(sent[0]?.payload.kind).toBe('folders');
    expect(sent[0]?.payload.state).toBe('start');
  });

  it('подписка получает состояния поиска: старт, ход и финал', () => {
    const handle = beginSearchProgress({ kind: 'cards', title: 'Поиск по карточкам', total: 900 });
    handle.report({ scanned: 400, total: 900, found: 2 });
    vi.advanceTimersByTime(300);
    handle.report({ scanned: 900, total: 900, found: 5 });
    vi.advanceTimersByTime(300);
    handle.finish({ state: 'done' });

    expect(events('start')).toHaveLength(1);
    expect(events('progress').length).toBeGreaterThan(0);
    expect(events('done')).toHaveLength(1);
    // Счётчики доезжают до окна: «просмотрено 400 из 900, найдено 2».
    const progress = events('progress')[0];
    expect(progress?.payload.scanned).toBe(400);
    expect(progress?.payload.total).toBe(900);
    expect(progress?.payload.found).toBe(2);
  });

  it('отмена прерывает работу: сигнал срабатывает', () => {
    const handle = beginSearchProgress({ kind: 'folders', title: 'Поиск по папкам' });
    expect(handle.signal.aborted).toBe(false);
    expect(cancelSearchProgress(handle.searchId)).toBe(true);
    expect(handle.signal.aborted).toBe(true);
  });

  it('отменённый поиск закрывается состоянием «отменён», а не «ошибка»', () => {
    const handle = beginSearchProgress({ kind: 'folders', title: 'Поиск по папкам' });
    cancelSearchProgress(handle.searchId);
    handle.finish({ state: 'cancelled' });
    const last = sent[sent.length - 1];
    expect(last?.payload.state).toBe('cancelled');
    expect(last?.payload.error).toBeNull();
  });

  it('отменять уже законченный поиск — нечего', () => {
    const handle = beginSearchProgress({ kind: 'files', title: 'Поиск по файлам' });
    handle.finish({ state: 'done' });
    expect(cancelSearchProgress(handle.searchId)).toBe(false);
  });

  it('поток событий не заливает окно: троттлинг + последнее состояние доезжает', () => {
    const handle = beginSearchProgress({ kind: 'folders', title: 'Поиск по папкам' });
    for (let i = 1; i <= 50; i += 1) {
      handle.report({ current: `папка${i}`, scanned: i, total: 50, found: 0 });
    }
    // За 50 отчётов подряд событие прогресса ушло не чаще раза в 200 мс.
    expect(events('progress')).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(events('progress')).toHaveLength(1);
    // Доставлено САМОЕ свежее состояние, а не первое.
    expect(events('progress')[0]?.payload.current).toBe('папка50');
  });

  it('окно, открывшееся посреди поиска, спрашивает текущие состояния', () => {
    const handle = beginSearchProgress({ kind: 'cards', title: 'Поиск по карточкам', total: 900 });
    handle.report({ scanned: 400, total: 900, found: 2 });
    const list = listSearchProgress();
    expect(list.length).toBeGreaterThan(0);
    expect(list[list.length - 1]?.searchId).toBe(handle.searchId);
  });

  it('закрытие поиска убирает его из реестра состояний', () => {
    const handle = beginSearchProgress({ kind: 'files', title: 'Поиск по файлам' });
    finishSearchProgress(handle.searchId, { state: 'done' });
    const last = sent[sent.length - 1];
    expect(last?.payload.state).toBe('done');
  });
});
