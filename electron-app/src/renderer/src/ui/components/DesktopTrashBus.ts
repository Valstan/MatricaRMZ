import { useEffect, useRef } from 'react';

// «Открыть корзину Верстака» — общий вызов для пункта МЕНЮ «Корзина» и для ярлыка корзины.
//
// Почему шина, а не проп: пункт МЕНЮ живёт в оболочке (`App.tsx`), а корзина — в компоненте
// Верстака (`DesktopPane.tsx`), и между ними пять слоёв вёрстки. Проп пришлось бы
// протаскивать через все пять — и забыть в одном, и «Корзина» снова открыла бы пустоту.
//
// Раньше в оболочке был собственный `trashOpen` с собственными ссылками на кнопку и
// всплывашку, и он НИЧЕГО НЕ РИСОВАЛ: пункт МЕНЮ «Корзина» открывал пустоту, и оператор
// заключал, что корзина сломана. Теперь пункт меню и ярлык — одна и та же корзина.
//
// Запрос помнит и «ждущий»: если Верстак сейчас не смонтирован (вкладка закрыта), запрос
// не теряется — корзина откроется, как только Верстак появится.

let pending = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Открыть корзину Верстака (из пункта МЕНЮ или по коду). */
export function openDesktopTrash(): void {
  pending = true;
  emit();
}

/** Закрыть корзину и снять «ждущий» запрос — открывать её больше не нужно. */
export function closeDesktopTrash(): void {
  pending = false;
  emit();
}

/** Забрать запрос «открыть корзину» (одноразово). */
export function takeDesktopTrashRequest(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}

/**
 * Подписка Верстака на запрос «открыть корзину».
 *
 * Обычная подписка, а не `useSyncExternalStore`: здесь СОБЫТИЕ, а не состояние — «открой
 * корзину» нельзя «прочитать», его можно только выполнить. Колбэк хранится в ref, чтобы
 * подписка не пересоздавалась на каждом рендере (иначе Верстак переподписывался бы
 * постоянно).
 */
export function useDesktopTrashRequest(onOpen: () => void): void {
  const ref = useRef(onOpen);
  useEffect(() => {
    ref.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    const listener = () => {
      if (takeDesktopTrashRequest()) ref.current();
    };
    listeners.add(listener);
    // Верстак только что смонтировался, а запрос уже был — отдать его, а не потерять.
    if (takeDesktopTrashRequest()) ref.current();
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
