/**
 * Правила поведения списков — ОДНА настройка на всю программу (D-248, ответ владельца 21.11
 * по плану «Списки во всей программе по одним правилам»).
 *
 * Отдельный модуль, а не ещё одна группа в `UiControlTuning`: группа `lists` там уже занята
 * плотностью и шрифтами списка (это «как выглядит»), а здесь — «как себя ведёт» (это «что умеет»).
 * Смешивать их нельзя: пресеты интерфейса перезаписывают tuning, а правила поведения должны
 * переживать смену пресета.
 *
 * Ключевое следствие D-248: группа живёт в **глобальных дефолтах** и **не участвует** в слиянии
 * с личными настройками (`mergeUiControlSettings`). Иначе чья-то личная настройка перекроет
 * общее правило — это будет вторая правда (см. `mergeUiControlSettings`).
 */
export type ListBehaviorSettings = {
  /** Визуальное сопровождение перетаскивания: подсветка строки и линия места вставки. */
  dragVisual: boolean;
  /** Клавиатурное перемещение по ручке: клик по ручке — красная рамка, стрелки двигают. */
  keyboardMove: boolean;
  /** Выделение контуром (Ctrl + рамка). */
  lasso: boolean;
  /** Контекстное меню списка (ПКМ по строке). */
  contextMenu: boolean;
};

export const DEFAULT_LIST_BEHAVIOR_SETTINGS: ListBehaviorSettings = {
  dragVisual: true,
  keyboardMove: true,
  lasso: true,
  contextMenu: true,
};

function clampBoolean(raw: unknown, fallback: boolean): boolean {
  if (raw === true) return true;
  if (raw === false) return false;
  return fallback;
}

/**
 * Санитайзер группы правил. Неизвестные/битые значения ⇒ дефолт, а не «тихо выключено»:
 * список без правил — это список, который ведёт себя как раньше, и оператор не заметит поломки.
 */
export function sanitizeListBehaviorSettings(
  raw: unknown,
  fallback: ListBehaviorSettings = DEFAULT_LIST_BEHAVIOR_SETTINGS,
): ListBehaviorSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    dragVisual: clampBoolean(value.dragVisual, fallback.dragVisual),
    keyboardMove: clampBoolean(value.keyboardMove, fallback.keyboardMove),
    lasso: clampBoolean(value.lasso, fallback.lasso),
    contextMenu: clampBoolean(value.contextMenu, fallback.contextMenu),
  };
}
