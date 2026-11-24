import { useCallback, useMemo, useRef } from 'react';

import { useListBehaviorSettings } from './useListBehaviorSettings.js';
import { useListDrag } from './useListDrag.js';
import { useListKeyboardMove } from './useListKeyboardMove.js';
import { listDropIndicatorStyle } from '../utils/listDragVisual.js';
import {
  insertKeyByTarget,
  remapBlockKeys,
  reorderRows,
  rowKeyAt,
  type ListDropPosition,
} from '../utils/listReorder.js';

/**
 * Перестановка строк карточки по киту (промт КАРМАНА #67, фаза «карточки»).
 *
 * Это ЕДИНАЯ точка, где собирается механика перемещения для списков, которые умеют
 * менять порядок (строки договора, строки наряда, свойства инструмента, складской
 * документ, заявка на снабжение, табель, переводы сотрудника).
 *
 * Почему отдельный хук, а не «просто взять useListKeyboardMove в каждой странице»:
 * список отдаёт киту ДВЕ вещи — свои строки и как сохранить новый порядок. Всё
 * остальное (ручка, перетаскивание, клавиатура, правило из общей настройки) — общее и
 * живёт здесь. Страница, которая соберёт эту пару иначе, получит «вторую механику» —
 * ровно то, чего эта нитка закрывает.
 *
 * Правила, которые уже зашиты в ките и потому не переигрываются на страницах:
 *  - ПЕРЕТАСКИВАНИЕ мышью — приоритетный способ (правило проекта), клавиатура — второй;
 *  - клавиатурное перемещение включается общей настройкой правил списков (D-248);
 *  - блок из нескольких строк двигается целиком (Ctrl/Shift по ручкам).
 */
export function useListReorder<T>(opts: {
  /** Строки списка в текущем порядке. */
  rows: readonly T[];
  /**
   * Список сохраняет новый порядок (в своей подсистеме — payload, БД, сервер).
   *
   * Второй аргумент — новый порядок НОМЕРОВ строк (старые номера в новом порядке).
   * Он нужен спискам, у которых рядом со строками лежит параллельный массив
   * (ключи строк для React, свои идентификаторы): этот массив переставляется по той же
   * перестановке, иначе ключи разъедутся со строками.
   */
  onReorder: (rows: T[], order: string[]) => void;
  /** Можно ли переставлять строки (право + состояние сущности). */
  canReorder: boolean;
}) {
  const { rows, onReorder, canReorder } = opts;
  // Правила поведения списков — из общего источника (D-248), а не из настроек страницы.
  const listBehavior = useListBehaviorSettings();

  // Граница списка: строки этого списка и только они участвуют в перетаскивании.
  // На карточке наряда списков три (бригада, подписи, строки работ) — без границы
  // перетаскивание в одном списке целило бы в строки соседних.
  //
  // Маркер `data-list-scope` нужен для ВЛОЖЕННЫХ списков (поставки внутри позиции
  // заявки): строки вложенного списка принадлежат ему, а не внешнему, и в расчёт места
  // вставки внешнего списка попадать не должны.
  const scopeElRef = useRef<HTMLElement | null>(null);
  const scopeRef = useCallback((el: HTMLElement | null) => {
    scopeElRef.current = el;
    if (el) el.setAttribute('data-list-scope', 'true');
  }, []);
  const getScope = useCallback(() => scopeElRef.current, []);

  // Ключ строки — её номер (см. `utils/listReorder.ts`): у строк карточек своего id
  // чаще всего нет, а выдуманный id пришлось бы хранить и передёргивать при каждой
  // правке — это вторая механика рядом с китом.
  const keys = useMemo(() => rows.map((_, index) => rowKeyAt(index)), [rows]);

  /** Список сохраняет новый порядок строк. */
  const handleMove = useCallback(
    (order: string[]) => {
      if (!canReorder) return;
      onReorder(reorderRows(rows, order), order);
    },
    [canReorder, rows, onReorder],
  );

  const keyboard = useListKeyboardMove({
    enabled: canReorder && listBehavior.keyboardMove,
    orderedIds: keys,
    onMove: handleMove,
    // После сдвига номер строки меняется — блок пересчитывает свои номера.
    remapKeys: remapBlockKeys,
  });

  const drag = useListDrag({ enabled: canReorder && listBehavior.dragVisual, scope: getScope });

  /**
   * Куда вставить перетаскиваемую строку.
   *
   * Место вставки задаётся КЛЮЧОМ строки-цели и стороной («до»/«после»), а не
   * индексом: на карточке наряда списков три, и экранный индекс места вставки к
   * массиву этой карточки отношения не имеет.
   */
  const dropRow = useCallback(
    (draggedKey: string, targetKey: string, position: ListDropPosition) => {
      if (!canReorder) return;
      handleMove(insertKeyByTarget(keys, draggedKey, targetKey, position));
    },
    [canReorder, keys, handleMove],
  );

  return {
    /** Ключи строк в текущем порядке — киту и разметке. */
    keys,
    /**
     * Граница списка — вешается на обёртку списка (таблицу/контейнер строк):
     * `ref={reorder.scopeRef}`.
     */
    scopeRef,
    /** Ручка строки: общая на всех списков. */
    handleProps: (rowKey: string, extra?: { label?: string }) => ({
      rowKey,
      active: keyboard.moveKeys.includes(rowKey),
      blockCount: keyboard.moveKeys.length,
      draggable: canReorder && listBehavior.dragVisual,
      onHandleClick: keyboard.onHandleClick,
      onDragStart: (event: React.DragEvent<HTMLSpanElement>) => drag.startDrag(event, { key: rowKey }),
      ...(extra?.label ? { label: extra.label } : {}),
    }),
    /** Стиль строки: красная рамка в режиме перемещения + подсветка при перетаскивании. */
    rowStyle: (rowKey: string) => ({
      ...keyboard.moveRowStyle(rowKey),
      ...drag.rowStyle(rowKey),
      // Линия места вставки: оператор видит, ГДЕ встанет строка.
      ...listDropIndicatorStyle(drag.dropTarget, rowKey),
    }),
    /** Строки в режиме перемещения — для подсветки и объявления. */
    moveKeys: keyboard.moveKeys,
    /** Что сказать скринридеру (и что показать в подсказке). */
    announcement: keyboard.announcement,
    /** Сбросить режим перемещения. */
    clearMove: keyboard.clear,
    /**
     * Строка под курсором — разрешить drop и показать место вставки.
     */
    onDragOver: (event: React.DragEvent) => drag.overRow(event),
    /**
     * Отпустили строку. Место вставки кит считает сам (по координатам и границе
     * списка) и приходит ключом строки-цели со стороной — «до» или «после».
     */
    onDrop: (event: React.DragEvent) => {
      // Источник берём из `dataTransfer` (а не из состояния кита): состояние могло
      // быть погашено слушателем, отработавшим раньше обработчика страницы, — и
      // тогда перестановка молча не случилась бы (см. `utils/listDragDrop.ts`).
      const draggedKey = drag.sourceKeyOf(event);
      if (!draggedKey) return;
      drag.drop(event, (target) => {
        if (!target.key) return;
        dropRow(draggedKey, target.key, target.position);
      });
    },
    /** Место вставки (для линии-индикатора). */
    dropTarget: drag.dropTarget,
  };
}
