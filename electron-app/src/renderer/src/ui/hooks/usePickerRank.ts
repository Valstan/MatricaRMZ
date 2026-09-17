import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  bumpPickerRank,
  parsePickerRankStore,
  rankOptionsByPick,
  type PickerRankStore,
} from '../utils/pickerRank.js';

/**
 * Привязка рейтинга пикеров к React и localStorage (план autumn-2026 §D4).
 *
 * Хранилище — ОДИН модульный синглтон, а не состояние компонента. Причина: на одном экране
 * полей выбора несколько (комиссия — три, экипаж наряда — сколько угодно), и каждое писало бы
 * в localStorage ВЕСЬ объект из своей копии состояния — чужие счётчики, поднятые до её монтажа,
 * затирались бы при каждом выборе. Синглтон + `useSyncExternalStore` дают одну правду на окно
 * и мгновенный перерисованный порядок у соседних полей.
 *
 * Ключ версионирован: формат рейтинга — наша внутренняя кухня, и смена формы значения не
 * должна требовать миграции чужих данных, достаточно нового ключа.
 */
const STORAGE_KEY = 'matrica:picker-rank:v1';

let store: PickerRankStore | null = null;
const listeners = new Set<() => void>();

function read(): PickerRankStore {
  if (store) return store;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    store = parsePickerRankStore(raw ? JSON.parse(raw) : null);
  } catch {
    // Хранилище недоступно или испорчено: рейтинг — подсказка порядка, а не данные, —
    // молча деградируем к алфавиту вызывающего.
    store = {};
  }
  return store;
}

function write(next: PickerRankStore): void {
  store = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Запись не удалась — порядок в этом сеансе уже поднят, на следующем запуске вернётся
    // прежний. Ронять выбор сотрудника из-за подсказки нельзя.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Тестовая точка входа: сбросить синглтон между прогонами. Продуктовый код её не зовёт. */
export function __resetPickerRankForTests(): void {
  store = null;
  listeners.clear();
}

export type PickerRank = {
  /** Поднять наверх тех, кого оператор выбирает чаще; остальные — в исходном порядке. */
  rankOptions: <T extends { id: string; label?: string }>(options: readonly T[]) => T[];
  /** Отметить выбор. Зовётся ТОЛЬКО на реальном выборе — очистка поля выбором не является. */
  bump: (id: string | null | undefined) => void;
};

export function usePickerRank(rankKey: string | undefined): PickerRank {
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const scope = rankKey ? snapshot[rankKey] : undefined;

  const bump = useCallback(
    (id: string | null | undefined) => {
      if (!rankKey || !id) return;
      write(bumpPickerRank(read(), rankKey, id, Date.now()));
    },
    [rankKey],
  );

  return useMemo<PickerRank>(
    () => ({
      rankOptions: (options) => rankOptionsByPick(options, scope),
      bump,
    }),
    [bump, scope],
  );
}
