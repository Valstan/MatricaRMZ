import React from 'react';

/**
 * Состояние панели фильтров — общий источник для кнопки «Фильтры» в тулбаре и для самой панели
 * (владелец 25.11.2026, промт КАРМАНА #151).
 *
 * Почему отдельный стор, а не `useListUiState` (`hooks/useListBehavior.ts`): тот читает состояние
 * ОДИН раз при монтировании и на внешние изменения НЕ подписан ⇒ кнопка в тулбаре переключила бы
 * своё состояние, а панель — своё, и они разошлись бы (владелец нажал «Фильтры» — а панель не
 * открылась). Здесь один источник с подпиской: кто переключил, тот и увидел.
 *
 * Ключ — по `usageKey` списка: своя панель у каждого экрана, переживает переход между экранами.
 * Хранилище — `sessionStorage` (как у состояния списка): панель, свёрнутая вчера, сегодня
 * развёрнута — но перезапуск программы возвращает умолчание.
 */

export type FacetPanelState = {
  /** Панель развёрнута. По умолчанию — да (владелец 24.11.2026: «по умолчанию панель развёрнута»). */
  expanded: boolean;
  /**
   * Сколько ступеней отбора активно. Живёт на кнопке «Фильтры» в тулбаре: свёрнутая панель
   * исчезает с экрана целиком, и без числа оператор не поймёт, почему список короче
   * (ловушка «почему тут не все?» — её уже чинили 12.11.2026).
   */
  activeCount: number;
};

const MEMORY = new Map<string, FacetPanelState>();
const LISTENERS = new Map<string, Set<(state: FacetPanelState) => void>>();

/** Ключ состояния панели: свой у каждого списка. */
export function facetPanelKey(usageKey?: string): string {
  return `${usageKey ?? 'facets'}:facetPanel`;
}

function readStored(key: string): FacetPanelState {
  const cached = MEMORY.get(key);
  if (cached) return cached;
  try {
    const raw = window.sessionStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as Partial<FacetPanelState>) : null;
    const count = Number(parsed?.activeCount);
    return {
      expanded: parsed?.expanded !== false,
      activeCount: Number.isFinite(count) && count > 0 ? count : 0,
    };
  } catch {
    return { expanded: true, activeCount: 0 };
  }
}

function write(key: string, state: FacetPanelState) {
  MEMORY.set(key, state);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Хранилище недоступно — состояние живёт до перезагрузки окна.
  }
  const listeners = LISTENERS.get(key);
  if (listeners) for (const listener of listeners) listener(state);
}

export function readFacetPanelState(usageKey?: string): FacetPanelState {
  return readStored(facetPanelKey(usageKey));
}

export function setFacetPanelExpanded(usageKey: string | undefined, expanded: boolean): void {
  const key = facetPanelKey(usageKey);
  write(key, { ...readStored(key), expanded });
}

export function toggleFacetPanel(usageKey: string | undefined): void {
  const key = facetPanelKey(usageKey);
  const prev = readStored(key);
  write(key, { ...prev, expanded: !prev.expanded });
}

/** Счётчик активных ступеней публикует панель: она знает свой отбор. */
export function setFacetPanelActiveCount(usageKey: string | undefined, activeCount: number): void {
  const key = facetPanelKey(usageKey);
  const prev = readStored(key);
  if (prev.activeCount === activeCount) return;
  write(key, { ...prev, activeCount });
}

export function subscribeFacetPanel(
  usageKey: string | undefined,
  listener: (state: FacetPanelState) => void,
): () => void {
  const key = facetPanelKey(usageKey);
  const listeners = LISTENERS.get(key) ?? new Set<(state: FacetPanelState) => void>();
  listeners.add(listener);
  LISTENERS.set(key, listeners);
  return () => {
    listeners.delete(listener);
  };
}

/** Хук для кнопки тулбара и для самой панели: одно состояние на обоих. */
export function useFacetPanelState(usageKey?: string) {
  const key = facetPanelKey(usageKey);
  const [state, setState] = React.useState<FacetPanelState>(() => readStored(key));

  React.useEffect(() => {
    setState(readStored(key));
    return subscribeFacetPanel(key, setState);
  }, [key]);

  return {
    expanded: state.expanded,
    activeCount: state.activeCount,
    setExpanded: (expanded: boolean) => setFacetPanelExpanded(usageKey, expanded),
    toggle: () => toggleFacetPanel(usageKey),
  };
}
