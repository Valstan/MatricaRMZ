import { useSyncExternalStore } from 'react';

// Намерение «прикрепить эти файлы с Верстака к этой карточке».
//
// Промежуточная записка между двумя экранами: Верстак выбрал файлы и карточку, а вложения
// положить должна САМА карточка — у трёх карточек из девяти список вложений живёт в памяти
// открытой карточки и уходит в базу снимком при её закрытии. Запись «снаружи» потерялась бы
// молча (см. правило в `DesktopFilesContext`).
//
// Поэтому карточка не пишет ничего «извне»: Верстак оставляет записку с адресатом
// (род карточки, её id и категория вложений), карточка её находит по своему `scope`,
// показывает оператору файлы уже отмеченными — и кладёт их СВОИМ `onChange`.
//
// Записка одноразовая: кто первый забрал — тот и виноват. Иначе она уехала бы в следующую
// открытую карточку и прикрепила файлы не туда.

export type DesktopAttachScope = {
  ownerType: string;
  ownerId: string;
  category: string;
};

export type DesktopAttachIntent = DesktopAttachScope & {
  /** id файлов, которые оператор выделил на Верстаке. */
  fileIds: string[];
};

let current: DesktopAttachIntent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Оставить записку для карточки. `null` — снять. */
export function setDesktopAttachIntent(intent: DesktopAttachIntent | null): void {
  current = intent;
  emit();
}

/** Текущая записка (или null) — без снятия. */
export function getDesktopAttachIntent(): DesktopAttachIntent | null {
  return current;
}

/** Записка, адресованная именно этому контейнеру. */
export function desktopAttachIntentFor(scope: DesktopAttachScope | undefined): DesktopAttachIntent | null {
  if (!scope) return null;
  const intent = current;
  if (!intent) return null;
  if (intent.ownerType !== scope.ownerType) return null;
  if (intent.ownerId !== scope.ownerId) return null;
  if (intent.category !== scope.category) return null;
  return intent;
}

/** Забрать записку (одноразово) — вызывающий её уже забрал. */
export function takeDesktopAttachIntent(): void {
  if (!current) return;
  current = null;
  emit();
}

/**
 * Подписка панели вложений на записку.
 *
 * Возвращает записку, адресованную этому контейнеру, и снимает её: одна записка — одна
 * карточка. Подписка через `useSyncExternalStore`, а не через пропы: панель вложений живёт в
 * девяти карточках, и проп пришлось бы протаскивать через девять мест, где его можно забыть.
 */
export function useDesktopAttachIntent(scope: DesktopAttachScope | undefined): DesktopAttachIntent | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => desktopAttachIntentFor(scope),
    () => null,
  );
}
