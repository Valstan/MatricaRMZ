import React from 'react';

import { ListRowHandle } from './ListRowHandle.js';

/**
 * Единая ручка перемещения строки «⠿» — общая для всех списков программы
 * (промт КАРМАНА #67, фаза «карточки»).
 *
 * ОНА заменяет кнопки ↑/↓ во всех списках, где строки умеют менять порядок. Один
 * элемент — два способа двигать строку:
 *  - ПЕРЕТАСКИВАНИЕ мышью (приоритетный способ, правило проекта);
 *  - КЛАВИАТУРНОЕ перемещение: клик по ручке → красная рамка → стрелки ↑/↓.
 *
 * Почему одна ручка вместо кнопок ↑/↓:
 *  - кнопки ↑/↓ работали ТОЛЬКО мышью (или пальцем по кнопке) и не давали блока из
 *    нескольких строк: выделить две строки и сдвинуть их разом было нечем;
 *  - ручка даёт и перетаскивание, и блок (Ctrl/Shift по ручкам), и одинаковое поведение
 *    во всех списках — правило «везде одинаково» в одном компоненте.
 *
 * Тач-планшет: HTML5-перетаскивание на touch не работает, поэтому на планшете ручка
 * остаётся ПРИОРИТЕТНЫМ способом только там, где есть мышь; на тач-экране ручка
 * даёт клавиатурный режим (тап по ручке → стрелки), а перетаскивание мышью — второй
 * способ. Поэтому ручка всегда кликабельна: тап по ней включает режим перемещения.
 */
export function ListReorderHandle(props: {
  /** Ключ строки (её номер в списке). */
  rowKey: string;
  /** Строка в режиме перемещения — ручка краснеет. */
  active?: boolean;
  /** Сколько строк в перемещаемом блоке (для подсказки). */
  blockCount?: number;
  /** Разрешено ли перетаскивание мышью. */
  draggable?: boolean;
  /** Клик по ручке (мышь или клавиатура). */
  onHandleClick?: (key: string, event: React.MouseEvent | React.KeyboardEvent) => void;
  /** Начало перетаскивания мышью. */
  onDragStart?: (event: React.DragEvent<HTMLSpanElement>) => void;
  /** Подпись строки для скринридера. */
  label?: string;
}) {
  return (
    <ListRowHandle
      rowKey={props.rowKey}
      {...(props.active !== undefined ? { active: props.active } : {})}
      {...(props.blockCount !== undefined ? { blockCount: props.blockCount } : {})}
      {...(props.draggable !== undefined ? { draggable: props.draggable } : {})}
      {...(props.onHandleClick ? { onHandleClick: props.onHandleClick } : {})}
      {...(props.onDragStart ? { onDragStart: props.onDragStart } : {})}
      {...(props.label ? { label: props.label } : {})}
    />
  );
}
