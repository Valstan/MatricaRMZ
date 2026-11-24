import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';

import {
  decideListDragDrop,
  listDragSourceKey,
  type ListDragEventLike,
} from '../utils/listDragDrop.js';
import {
  listDragRowStyle,
  resolveDropTarget,
  type ListDragSource,
  type ListDropTarget,
  type ListRowRect,
} from '../utils/listDragVisual.js';

const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_STEP_PX = 18;

/**
 * Общий слой перетаскивания строк (промт КАРМАНА #67, шаг «визуальное сопровождение»).
 *
 * Даёт спискам три вещи, одинаковые во всей программе:
 *  - подсветку перетаскиваемой строки;
 *  - линию (разрыв) места вставки;
 *  - автоскролл у края списка.
 *
 * И ЗАКРЫВАЕТ дыру с `onDragEnd`: состояние перетаскивания гасится на уровне документа,
 * поэтому отмена перетаскивания (Esc, drop мимо строки) больше не оставляет список
 * «залипшим» с подсвеченной строкой. Раньше это чинили вручную и только в одном месте.
 *
 * ⚠️ ПОРЯДОК СОБЫТИЙ (здесь ломалось перетаскивание — владелец 24.11.2026):
 * React делегирует `onDrop` на корневой контейнер, поэтому обработчик страницы
 * срабатывает в фазе ВСПЛЫТИЯ на корне — ПОЗЖЕ capture-фазы на `document`.
 * Слушатель `drop` на `document` с `capture = true` гасил состояние перетаскивания
 * ДО того, как страница прочитала источник, — строка подсвечивалась, линия
 * вставки показывалась, а порядок не менялся. Поэтому:
 *  · `drop` на `document` слушаем в фазе ВСПЛЫТИЯ (после обработчика страницы);
 *  · `dragend` — отдельное событие, оно приходит после drop, capture тут безопасен;
 *  · источник перетаскивания берём из `dataTransfer`, а не из ref кита.
 * Подробности и чистая часть — `utils/listDragDrop.ts`.
 */
export function useListDrag(opts?: { enabled?: boolean; scope?: () => HTMLElement | null }) {
  const enabled = opts?.enabled !== false;
  const scope = opts?.scope;
  const [drag, setDrag] = useState<ListDragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<ListDropTarget | null>(null);
  const dragRef = useRef<ListDragSource | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);

  const clear = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
    setDropTarget(null);
  }, []);

  // Сброс по событию документа: `dragend` на элементе не срабатывает, если drop
  // прошёл мимо цели или оператор отменил перетаскивание клавишей Escape.
  //
  // `drop` — ТОЛЬКО в фазе всплытия: React отдаёт `onDrop` странице в фазе
  // всплытия на корневом контейнере, и наш слушатель на `document` обязан
  // прийти ПОСЛЕ него. С capture-фазой он пришёл бы раньше и погасил
  // состояние до того, как страница прочитала источник (см. шапку файла).
  useEffect(() => {
    if (!enabled) return;
    const onEnd = () => clear();
    document.addEventListener('dragend', onEnd, true);
    document.addEventListener('drop', onEnd, false);
    return () => {
      document.removeEventListener('dragend', onEnd, true);
      document.removeEventListener('drop', onEnd, false);
    };
  }, [enabled, clear]);

  const startDrag = useCallback(
    (event: ReactDragEvent, source: ListDragSource) => {
      if (!enabled) return;
      dragRef.current = source;
      setDrag(source);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', source.key);
    },
    [enabled],
  );

  /** Строки списка в координатах экрана — по ним считается место вставки. */
  const collectRowRects = useCallback((): ListRowRect[] => {
    // ГРАНИЦА СПИСКА: строки собираются только внутри своего контейнера. На карточке
    // наряда списков три (бригада, подписи, строки работ), и без границы перетаскивание
    // в одном списке считало бы строки соседних — место вставки уезжало бы в чужой список.
    const root = scope?.() ?? scrollRef.current;
    const scopeEl = root ?? document;
    const rows = Array.from(scopeEl.querySelectorAll<HTMLElement>('[data-list-row="true"][data-list-row-key]'))
      // Вложенный список (поставки внутри позиции заявки) — свой: его строки не должны
      // попасть в расчёт места вставки внешнего списка. Без своей границы (scope не
      // задан) фильтр не применяется — иначе список без разметки потерял бы строки.
      .filter((row) => {
        if (!root) return true;
        const owner = row.closest('[data-list-scope="true"]');
        return !owner || owner === scopeEl;
      });
    return rows.map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        key: row.getAttribute('data-list-row-key') ?? '',
        top: rect.top,
        bottom: rect.bottom,
      };
    });
  }, [scope]);

  const autoScroll = useCallback((clientY: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (clientY - rect.top < AUTOSCROLL_EDGE_PX) {
      container.scrollTop -= AUTOSCROLL_STEP_PX;
      return;
    }
    if (rect.bottom - clientY < AUTOSCROLL_EDGE_PX) {
      container.scrollTop += AUTOSCROLL_STEP_PX;
    }
  }, []);

  const overRow = useCallback(
    (event: ReactDragEvent) => {
      if (!enabled || !dragRef.current) return false;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const target = resolveDropTarget(event.clientY, collectRowRects());
      setDropTarget(target);
      autoScroll(event.clientY);
      return true;
    },
    [enabled, collectRowRects, autoScroll],
  );

  /**
   * Ключ перетаскиваемой строки — из `dataTransfer` (то, что кит положил при
   * старте перетаскивания), с откатом на ref кита.
   *
   * Источник истины — `dataTransfer`: он переживает любое состояние ref'а
   * кита, а ref мог быть погашен слушателем, отработавшим раньше.
   */
  const sourceKeyOf = useCallback((event: ListDragEventLike | null | undefined): string => {
    return listDragSourceKey(event, dragRef.current?.key ?? null);
  }, []);

  const drop = useCallback(
    (event: ReactDragEvent, onDropAt: (target: ListDropTarget) => void) => {
      if (!enabled) return;
      const wasDragging = dragRef.current != null;
      const sourceKey = listDragSourceKey(event, dragRef.current?.key ?? null);
      // Это не наше перетаскивание — чужой drop браузеру не мешаем.
      if (!sourceKey && !wasDragging) return;
      event.preventDefault();
      const target = resolveDropTarget(event.clientY, collectRowRects());
      const decision = decideListDragDrop({ sourceKey, target });
      // Состояние гасим всегда: и когда перестановка случилась, и когда цель
      // не нашлась (drop мимо строки) — список не должен остаться «залипшим».
      clear();
      if (decision.kind === 'ignore') return;
      onDropAt(decision.target);
    },
    [enabled, collectRowRects, clear],
  );

  return {
    enabled,
    drag,
    dropTarget,
    /** Ссылка на прокручиваемую обёртку списка (для автоскролла и координат строк). */
    scrollRef,
    startDrag,
    overRow,
    drop,
    /**
     * Ключ перетаскиваемой строки по событию — для страниц, которые читают
     * источник сами (ПП читает `dataTransfer` напрямую).
     */
    sourceKeyOf,
    clear,
    /** Стиль перетаскиваемой строки (общий для всех списков). */
    rowStyle: (rowKey: string) => listDragRowStyle(drag?.key ?? null, rowKey),
  };
}
