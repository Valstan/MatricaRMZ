import { useSyncExternalStore } from 'react';

import { DEFAULT_LIST_BEHAVIOR_SETTINGS, type ListBehaviorSettings } from '@matricarmz/shared';

/**
 * ЕДИНЫЙ источник правил поведения списков (промт КАРМАНА #67, D-248).
 *
 * Настройка приходит из глобальных дефолтов программы и раздаётся всем спискам отсюда.
 * Списки не читают её сами по себе и не имеют частных переключателей: правило одно на
 * всю программу, иначе «везде одинаково» — это не правило, а набор исключений.
 *
 * Хранилище — модульный синглтон с подпиской: список живёт в любой вкладке и на любой
 * странице, прокидывать контекст через всё дерево `App.tsx` ради четырёх флагов — лишняя
 * связность. Глобальные дефолты применяются один раз при загрузке (см. `App.tsx`,
 * `applyEffectiveUiSettings`).
 */
let current: ListBehaviorSettings = { ...DEFAULT_LIST_BEHAVIOR_SETTINGS };
const listeners = new Set<() => void>();

export function getListBehaviorSettings(): ListBehaviorSettings {
  return current;
}

/** Применяет глобальные правила. Вызывается при загрузке настроек программы. */
export function setListBehaviorSettings(next: ListBehaviorSettings): void {
  if (
    next.dragVisual === current.dragVisual &&
    next.keyboardMove === current.keyboardMove &&
    next.lasso === current.lasso &&
    next.contextMenu === current.contextMenu
  ) {
    return;
  }
  current = { ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Правила поведения списков для любого списка в программе. */
export function useListBehaviorSettings(): ListBehaviorSettings {
  return useSyncExternalStore(subscribe, getListBehaviorSettings, getListBehaviorSettings);
}

/**
 * CSS-переменные правил — чтобы стили (рамка перемещаемой строки, курсор контура)
 * читались из одного места, а не из пропсов по каждому списку.
 */
export function applyListBehaviorCssVars(root: HTMLElement, settings: ListBehaviorSettings): void {
  root.style.setProperty('--ui-list-drag-visual', settings.dragVisual ? '1' : '0');
  root.style.setProperty('--ui-list-keyboard-move', settings.keyboardMove ? '1' : '0');
  root.style.setProperty('--ui-list-lasso', settings.lasso ? '1' : '0');
  root.style.setProperty('--ui-list-context-menu', settings.contextMenu ? '1' : '0');
}
