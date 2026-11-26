import { useSyncExternalStore } from 'react';

import type { SearchProgressEvent } from '@matricarmz/shared';

/**
 * Подписка на общий прогресс поиска — ОДНА на всю программу.
 *
 * ЗАЧЕМ ОДИН ИСТОЧНИК. Поиск идёт по всей программе: папки, файлы-источники,
 * содержимое карточек, серверный глобальный поиск. Прогресс у них должен
 * выглядеть одинаково и жить в одном канале — иначе каждый экран заведёт свою
 * копию подписки и своего бара (и они разъедутся: один покажет «найдено: 3»,
 * другой — «найдено: 0»).
 *
 * Здесь — единственная подписка на события главного процесса (`search:progress`)
 * и маленькое хранилище последнего состояния. Полоса — одна
 * (`ui/components/SearchProgressBar.tsx`), страницы состояние не дублируют.
 *
 * ОКНО ОТКРЫЛОСЬ ПОСРЕДИ ПОИСКА: окно забирает текущие состояния
 * (`search:progress:list`) — иначе оператор, вернувшийся на вкладку, увидел бы
 * пустоту вместо идущего поиска.
 */

/** Что сейчас на полосе. */
export type SearchProgressSlot = {
  /** Идентификатор поиска, которому принадлежит полоса (null — полоса пуста). */
  searchId: string | null;
  /** Событие, которое рисуется (null — рисуть нечего). */
  event: SearchProgressEvent | null;
};

type Listener = () => void;

/**
 * Правило: какой поиск рисуется на полосе.
 *
 * Поисков может быть несколько: глобальная палитра запускает новый поиск на
 * каждый введённый символ, и старый ещё может доехать до финала. Полоса
 * показывает ПОСЛЕДНИЙ начатый поиск, а финал чужого (уже неактуального) поиска
 * её не прячет — иначе мигающий глобальный поиск гасил бы полосу идущего
 * обхода папок.
 */
export function applySearchProgressEvent(
  slot: SearchProgressSlot,
  evt: SearchProgressEvent,
): SearchProgressSlot {
  if (evt.state === 'start') return { searchId: evt.searchId, event: evt };
  if (evt.state === 'progress') {
    if (slot.searchId != null && slot.searchId !== evt.searchId) return slot;
    return { searchId: evt.searchId, event: evt };
  }
  // Финал: чужой поиск не трогает полосу.
  if (slot.searchId != null && slot.searchId !== evt.searchId) return slot;
  // Поиск закончился — полоса прячется. Отмена и ошибка остаются видимыми:
  // оператор должен прочитать, что произошло, а не получить молчаливую пустоту.
  if (evt.state === 'done') return { searchId: null, event: null };
  return { searchId: evt.searchId, event: evt };
}

let slot: SearchProgressSlot = { searchId: null, event: null };

const listeners = new Set<Listener>();

let subscribed = false;

/** Таймеры скрытия финального состояния (по идентификатору поиска). */
const hideTimers = new Map<string, number>();

/** Сколько живёт финальное состояние, прежде чем полоса спрячется сама. */
const FINAL_STATE_TTL_MS = 4000;

function setSlot(next: SearchProgressSlot): void {
  slot = next;
  for (const listener of [...listeners]) listener();
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  if (typeof window === 'undefined') return;
  const api = window.matrica?.search;
  if (!api?.onProgress) return;

  api.onProgress((evt: SearchProgressEvent) => {
    if (!evt) return;
    const next = applySearchProgressEvent(slot, evt);
    const changed = next !== slot;
    slot = next;
    if (changed) for (const listener of [...listeners]) listener();

    // Финальное состояние «отменено/ошибка» держим несколько секунд.
    if (evt.state !== 'cancelled' && evt.state !== 'error') return;
    const previous = hideTimers.get(evt.searchId);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      hideTimers.delete(evt.searchId);
      if (slot.event?.searchId !== evt.searchId) return;
      setSlot({ searchId: null, event: null });
    }, FINAL_STATE_TTL_MS);
    hideTimers.set(evt.searchId, timer);
  });

  // Окно могло открыться посреди операции — забираем текущее состояние.
  void api
    .progressList?.()
    .then((res) => {
      if (!res?.ok) return;
      const events = Array.isArray(res.events) ? res.events : [];
      const active = events.filter((e) => e.state === 'start' || e.state === 'progress');
      const last = active[active.length - 1];
      if (!last) return;
      if (slot.searchId != null && slot.searchId !== last.searchId) return;
      setSlot({ searchId: last.searchId, event: last });
    })
    .catch(() => {
      // Канала нет (старая сборка) — просто без прогресса.
    });
}

/** Подписаться на изменения состояния поиска. */
export function subscribeSearchProgress(listener: Listener): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Текущее состояние (для `useSyncExternalStore`). */
export function getSearchProgressSnapshot(): SearchProgressEvent | null {
  return slot.event;
}

/**
 * Прогресс поиска — хук для полосы.
 *
 * Один источник подписки на программу: сколько бы экранов ни рисовало
 * прогресс, событие из главного процесса приходит сюда один раз.
 */
export function useSearchProgress(): SearchProgressEvent | null {
  return useSyncExternalStore(subscribeSearchProgress, getSearchProgressSnapshot, getSearchProgressSnapshot);
}

/** Отменить поиск: работа действительно прекращается, а не прячется результат. */
export function cancelSearchProgress(searchId: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  const id = String(searchId ?? '').trim();
  if (!id) return Promise.resolve({ ok: false, error: 'Не указан поиск' });
  return window.matrica?.search?.cancel({ searchId: id }).catch((e) => ({ ok: false, error: String(e) }));
}
