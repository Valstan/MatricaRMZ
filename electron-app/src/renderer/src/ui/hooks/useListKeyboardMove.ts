import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import {
  applyHandleClick,
  computeBlockMove,
  describeMoveResult,
  type HandleClickMode,
  type ListMoveBlock,
} from '../utils/listKeyboardMove.js';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Клавиатурное перемещение строк по ручке «⠿» (промт КАРМАНА #67).
 *
 * Правило одно на всю программу: клик по ручке включает режим перемещения (ручка
 * краснеет, строка обводится красной рамкой), стрелки ↑/↓ двигают на позицию, повторный
 * клик снимает. Через те же ручки выделяется несколько строк (Ctrl+клик, Shift+клик) —
 * и они перемещаются блоком.
 *
 * Сохранение порядка — за списком: кит считает только механику перемещения и отдаёт
 * новый порядок целиком (`onMove`), а список решает, как его сохранить (у ПП — `orderNo`,
 * у списков в карточках — свои механизмы).
 */
export function useListKeyboardMove(opts: {
  /** Правило включено глобальной настройкой (D-248). */
  enabled: boolean;
  /** Ключи строк в порядке списка. */
  orderedIds: string[];
  /** Список сохраняет новый порядок. */
  onMove: (order: string[]) => void;
}) {
  const [block, setBlock] = useState<ListMoveBlock>({ keys: [] });
  const [announcement, setAnnouncement] = useState('');

  const orderedIds = opts.orderedIds;
  const onMove = opts.onMove;
  const enabled = opts.enabled;

  const clear = useCallback(() => {
    setBlock({ keys: [] });
    setAnnouncement('');
  }, []);

  const onHandleClick = useCallback(
    (key: string, event: ReactMouseEvent | ReactKeyboardEvent) => {
      if (!enabled) return;
      const mode: HandleClickMode = event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'add' : 'replace';
      setBlock((prev) => applyHandleClick(prev, key, orderedIds, mode));
    },
    [enabled, orderedIds],
  );

  const move = useCallback(
    (direction: -1 | 1) => {
      if (!enabled || !block.keys.length) return;
      const result = computeBlockMove(orderedIds, block.keys, direction);
      if (!result.moved) {
        setAnnouncement(describeMoveResult(result.order, block.keys, false));
        return;
      }
      setAnnouncement(describeMoveResult(result.order, block.keys, true));
      onMove(result.order);
    },
    [enabled, block.keys, orderedIds, onMove],
  );

  // Стрелки работают, когда ручка в фокусе (оператор нажал на неё) и когда блок выбран.
  // Слушатель на документе в фазе capture — как у `useListSelection`, чтобы скрытая
  // вкладка не перехватывала клавиши видимой.
  useEffect(() => {
    if (!enabled || !block.keys.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clear();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [enabled, block.keys.length, move, clear]);

  const isMoving = useMemo(() => block.keys.length > 0, [block.keys.length]);

  return {
    /** Ключи строк в режиме перемещения (красная рамка). */
    moveKeys: block.keys,
    /** Можно ли двигать блок прямо сейчас. */
    isMoving,
    /** Что сказать скринридеру (и что показать в подсказке). */
    announcement,
    onHandleClick,
    clear,
    /** Стиль строки в режиме перемещения — общий для всех списков. */
    moveRowStyle: (rowKey: string) =>
      block.keys.includes(rowKey)
        ? { outline: '2px solid var(--danger)', outlineOffset: '-2px' }
        : {},
  };
}
