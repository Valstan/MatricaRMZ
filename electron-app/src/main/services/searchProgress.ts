// Общий прогресс поиска: главный процесс → окна (промт КАРМАНА #166).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Поиск идёт в главном процессе (там диск и база), а
// оператор смотрит в renderer. Без общего канала renderer узнаёт о ходе поиска
// только после того, как поиск закончился, — то есть ровно тогда, когда прогресс
// уже не нужен. Прецедент — прогресс синхронизации (`sync:progress`) и прогресс
// передачи файлов (`files:progress`).
//
// ОДИН КАНАЛ НА ВСЮ ПРОГРАММУ. Каждый вид поиска (папки, файлы-источники,
// содержимое карточек, серверный глобальный поиск) начинает поиск через
// `beginSearchProgress` и докладывает ход через `report`. Подписка в окне —
// одна (`ui/services/searchProgressService.ts`), полоса — одна
// (`ui/components/SearchProgressBar.tsx`).
//
// ОТМЕНА ЧЕСТНАЯ. `beginSearchProgress` отдаёт `AbortSignal`: поиск обязан сам
// проверять его и прекращать работу. «Отмена» здесь — это остановка обхода, а
// не прятание результата: отменённый поиск отдаёт частичный результат.
//
// ТРОТТЛИНГ. Событие на каждый прочитанный файл в сетевой папке устроило бы
// поток в окно и просадку скорости. Поэтому события идут не чаще раза в
// `THROTTLE_MS`, а финальное состояние — всегда сразу.

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  SEARCH_PROGRESS_KIND_TITLE,
  type SearchProgressEvent,
  type SearchProgressKind,
  type SearchProgressState,
} from '@matricarmz/shared';

/** Как часто событие прогресса уходит в окно (мс). */
export const SEARCH_PROGRESS_THROTTLE_MS = 200;
/** Сколько живёт завершённый поиск в реестре (мс) — чтобы окно, открывшееся
 *  посреди поиска, увидело его состояние. */
const FINISHED_TTL_MS = 10_000;

/** Что можно обновить в ходе поиска. */
export type SearchProgressPatch = {
  title?: string;
  /** Что читается прямо сейчас: имя папки или файла. */
  current?: string | null;
  /** Дополнительная счётная строка — например «В дереве папок: 412». */
  detail?: string | null;
  /** Просмотрено: N. */
  scanned?: number | null;
  /** Всего: M (null — неизвестно). */
  total?: number | null;
  /** Найдено: K. */
  found?: number | null;
  /** Доля 0..1 (null — неизвестно). */
  progress?: number | null;
};

/** Ручка поиска: идентификатор, сигнал отмены и способы доложить ход. */
export type SearchProgressHandle = {
  /** Идентификатор поиска — по нему окно отменяет поиск. */
  searchId: string;
  /** Сигнал отмены: поиск проверяет его сам. */
  signal: AbortSignal;
  /** Доложить ход (текущий объект, счётчики). */
  report: (patch: SearchProgressPatch) => void;
  /** Закрыть поиск: `done`, `cancelled` или `error`. */
  finish: (result?: { state?: 'done' | 'cancelled' | 'error'; error?: string | null }) => void;
};

type SearchEntry = {
  id: string;
  kind: SearchProgressKind;
  title: string;
  startedAt: number;
  controller: AbortController;
  /** Последнее отправленное событие. */
  latest: SearchProgressEvent | null;
  /** Когда последний раз ушло событие. */
  lastEmitAt: number;
  /** Отложенная отправка (троттлинг). */
  timer: ReturnType<typeof setTimeout> | null;
  /** Поиск закончен — остаётся в реестре на TTL. */
  finishedAt: number | null;
};

const searches = new Map<string, SearchEntry>();

function broadcast(evt: SearchProgressEvent): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('search:progress', evt);
    }
  } catch {
    // окно могло закрыться — прогресс оператору уже не нужен
  }
}

function pruneFinished(now: number): void {
  for (const [id, entry] of searches) {
    if (entry.finishedAt == null) continue;
    if (now - entry.finishedAt > FINISHED_TTL_MS) {
      if (entry.timer) clearTimeout(entry.timer);
      searches.delete(id);
    }
  }
}

function buildEvent(entry: SearchEntry, state: SearchProgressState, patch: SearchProgressPatch): SearchProgressEvent {
  const now = Date.now();
  const latest = entry.latest;
  return {
    searchId: entry.id,
    kind: entry.kind,
    state,
    title: patch.title ?? latest?.title ?? entry.title,
    current: patch.current !== undefined ? patch.current : (latest?.current ?? null),
    detail: patch.detail !== undefined ? patch.detail : (latest?.detail ?? null),
    scanned: patch.scanned !== undefined ? patch.scanned : (latest?.scanned ?? null),
    total: patch.total !== undefined ? patch.total : (latest?.total ?? null),
    found: patch.found !== undefined ? patch.found : (latest?.found ?? null),
    progress: patch.progress !== undefined ? patch.progress : (latest?.progress ?? null),
    startedAt: entry.startedAt,
    elapsedMs: Math.max(0, now - entry.startedAt),
    updatedAt: now,
    error: null,
  };
}

function emitNow(entry: SearchEntry, evt: SearchProgressEvent): void {
  entry.latest = evt;
  entry.lastEmitAt = evt.updatedAt;
  broadcast(evt);
}

/**
 * Отправить событие с троттлингом: не чаще раза в `SEARCH_PROGRESS_THROTTLE_MS`.
 * Финальное состояние (`force`) уходит сразу — оператор не должен ждать.
 */
function emit(entry: SearchEntry, state: SearchProgressState, patch: SearchProgressPatch, force = false): void {
  const evt = buildEvent(entry, state, patch);
  const now = evt.updatedAt;
  if (force || now - entry.lastEmitAt >= SEARCH_PROGRESS_THROTTLE_MS) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    emitNow(entry, evt);
    return;
  }
  // Не успело — запоминаем самое свежее и отправляем по таймеру.
  entry.latest = evt;
  if (entry.timer) return;
  const wait = Math.max(1, SEARCH_PROGRESS_THROTTLE_MS - (now - entry.lastEmitAt));
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const pending = entry.latest;
    if (!pending) return;
    if (entry.finishedAt != null) {
      // Поиск закрыт, пока ждал таймер — отправляем финальное состояние.
      emitNow(entry, pending);
      return;
    }
    emitNow(entry, { ...pending, state: 'progress' });
  }, wait);
}

/**
 * Начать поиск: выдать идентификатор, сигнал отмены и ручку доклада.
 *
 * Событие `start` уходит сразу — полоса должна появиться ДО первого
 * результата, а не после.
 */
export function beginSearchProgress(init: {
  kind: SearchProgressKind;
  title?: string;
  current?: string | null;
  total?: number | null;
}): SearchProgressHandle {
  const now = Date.now();
  pruneFinished(now);
  const id = `search_${randomUUID()}`;
  const entry: SearchEntry = {
    id,
    kind: init.kind,
    title: String(init.title ?? SEARCH_PROGRESS_KIND_TITLE[init.kind] ?? 'Поиск').trim(),
    startedAt: now,
    controller: new AbortController(),
    latest: null,
    lastEmitAt: 0,
    timer: null,
    finishedAt: null,
  };
  searches.set(id, entry);
  emit(entry, 'start', {
    ...(init.current != null ? { current: init.current } : {}),
    ...(init.total != null ? { total: init.total } : {}),
    scanned: 0,
    found: 0,
  }, true);

  return {
    searchId: id,
    signal: entry.controller.signal,
    report: (patch: SearchProgressPatch) => {
      if (entry.finishedAt != null) return;
      emit(entry, 'progress', patch);
    },
    finish: (result?: { state?: 'done' | 'cancelled' | 'error'; error?: string | null }) => {
      if (entry.finishedAt != null) return;
      const state: SearchProgressState = result?.state ?? 'done';
      entry.finishedAt = Date.now();
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const evt = buildEvent(entry, state, {});
      emitNow(entry, { ...evt, error: state === 'error' ? String(result?.error ?? 'неизвестная ошибка') : null });
    },
  };
}

/** Доложить ход поиска по идентификатору (в обход ручки). */
export function reportSearchProgress(searchId: string, patch: SearchProgressPatch): void {
  const entry = searches.get(String(searchId ?? ''));
  if (!entry) return;
  if (entry.finishedAt != null) return;
  emit(entry, 'progress', patch);
}

/** Закрыть поиск по идентификатору. */
export function finishSearchProgress(
  searchId: string,
  result?: { state?: 'done' | 'cancelled' | 'error'; error?: string | null },
): void {
  const entry = searches.get(String(searchId ?? ''));
  if (!entry) return;
  if (entry.finishedAt != null) return;
  entry.finishedAt = Date.now();
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  const state: SearchProgressState = result?.state ?? 'done';
  const evt = buildEvent(entry, state, {});
  emitNow(entry, { ...evt, error: state === 'error' ? String(result?.error ?? 'неизвестная ошибка') : null });
}

/**
 * Отменить поиск: сигнал отмены срабатывает, поиск обязан прекратить работу.
 *
 * Возвращает false, если такого поиска нет (он уже закончился) — тогда
 * ничего отменять не нужно.
 */
export function cancelSearchProgress(searchId: string): boolean {
  const entry = searches.get(String(searchId ?? ''));
  if (!entry) return false;
  if (entry.finishedAt != null) return false;
  entry.controller.abort();
  return true;
}

/** Текущие состояния поисков — для окна, открывшегося посреди операции. */
export function listSearchProgress(): SearchProgressEvent[] {
  pruneFinished(Date.now());
  return [...searches.values()]
    .map((entry) => entry.latest)
    .filter((evt): evt is SearchProgressEvent => evt != null)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Отменён ли поиск (по его сигналу). */
export { isSearchCancelled, raceWithAbort, SearchCancelledError } from './searchAbort.js';

