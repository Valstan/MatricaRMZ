import React from 'react';

/**
 * Ручка строки «⠿» — общая для всех списков (промт КАРМАНА #67).
 *
 * На ней живут оба способа перемещения:
 *  - перетаскивание мышью (HTML5 DnD) — приоритетный способ (правило проекта);
 *  - клавиатурное перемещение (клик по ручке → красная рамка → стрелки ↑/↓).
 *
 * Ручка — единственное место, где живёт «переместить строку»: клик по строке открывает
 * карточку, чекбокс выделяет. Иначе эти три действия дрались бы за один и тот же клик.
 */
export function ListRowHandle(props: {
  /** Ключ строки. */
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
  const { active, draggable } = props;
  const title = active
    ? `Перемещение строки${props.blockCount && props.blockCount > 1 ? ` (строк: ${props.blockCount})` : ''} — стрелки ↑/↓ двигают, повторный щелчок снимает`
    : 'Перетащите строку или нажмите — включится перемещение стрелками';

  return (
    <span
      data-list-handle="true"
      role="button"
      tabIndex={0}
      aria-pressed={active ? true : undefined}
      aria-label={props.label ? `Перемещение: ${props.label}` : 'Перемещение строки'}
      title={title}
      draggable={draggable ? true : undefined}
      onDragStart={props.onDragStart}
      onClick={(event) => {
        // Ручка и клик по строке не должны драться: клик по ручке не открывает карточку.
        event.stopPropagation();
        props.onHandleClick?.(props.rowKey, event);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        props.onHandleClick?.(props.rowKey, event);
      }}
      style={{
        cursor: draggable || props.onHandleClick ? 'grab' : 'default',
        userSelect: 'none',
        display: 'inline-block',
        lineHeight: 1,
        color: active ? 'var(--danger)' : 'var(--muted)',
        fontWeight: active ? 700 : 400,
      }}
    >
      ⠿
    </span>
  );
}
